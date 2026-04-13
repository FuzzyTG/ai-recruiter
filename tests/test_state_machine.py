"""Tests for src.core.state_machine.

Uses an in-memory SQLite database initialised from schema.sql so that
each test starts with a clean slate.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from src.core.state_machine import (
    IllegalTransitionError,
    State,
    Trigger,
    get_valid_triggers,
    is_terminal,
    transition_candidate,
)
from src.db import queries
from src.db.connection import init_db

SCHEMA_PATH = Path(__file__).parent.parent / "src" / "db" / "schema.sql"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def conn() -> sqlite3.Connection:
    """In-memory DB with schema applied and a single test candidate at 'new'."""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
    db.executescript(schema_sql)

    # Seed a candidate in state 'new'.
    now = _now_iso()
    queries.create_candidate(
        db,
        candidate_id="C-TEST-001",
        name="Ada Lovelace",
        email="ada@example.com",
        role="Engineer",
        state_updated=now,
        created_at=now,
    )
    db.commit()
    return db


# ---------------------------------------------------------------------------
# 1. Happy-path transitions
# ---------------------------------------------------------------------------

def test_happy_path_to_hired(conn: sqlite3.Connection) -> None:
    """Walk the full happy path from new -> hired."""
    cid = "C-TEST-001"
    steps = [
        Trigger.START_SCREENING,        # new -> screening
        Trigger.SCREENING_PASS,         # screening -> screened_pass
        Trigger.APPROVE_INTERVIEW,      # screened_pass -> scheduling
        Trigger.CONFIRM_INTERVIEW,      # scheduling -> interview_confirmed
        Trigger.INTERVIEW_COMPLETE,     # interview_confirmed -> interview_done
        Trigger.START_EVALUATION,       # interview_done -> evaluating
        Trigger.START_CALIBRATION,      # evaluating -> calibration
        Trigger.CALIBRATION_COMPLETE,   # calibration -> decision_pending
        Trigger.HIRE,                   # decision_pending -> hired
    ]
    expected_states = [
        State.SCREENING,
        State.SCREENED_PASS,
        State.SCHEDULING,
        State.INTERVIEW_CONFIRMED,
        State.INTERVIEW_DONE,
        State.EVALUATING,
        State.CALIBRATION,
        State.DECISION_PENDING,
        State.HIRED,
    ]

    for trigger, expected in zip(steps, expected_states):
        result = transition_candidate(conn, cid, trigger, actor="test")
        assert result == expected

    # Verify final DB state.
    candidate = queries.get_candidate(conn, cid)
    assert candidate["state"] == State.HIRED


# ---------------------------------------------------------------------------
# 2. Invalid transition
# ---------------------------------------------------------------------------

def test_invalid_transition_raises(conn: sqlite3.Connection) -> None:
    """new -> scheduling should raise IllegalTransitionError."""
    with pytest.raises(IllegalTransitionError) as exc_info:
        transition_candidate(conn, "C-TEST-001", Trigger.APPROVE_INTERVIEW)

    err = exc_info.value
    assert err.from_state == State.NEW
    assert err.trigger == Trigger.APPROVE_INTERVIEW
    assert err.candidate_id == "C-TEST-001"


# ---------------------------------------------------------------------------
# 3. Terminal state blocks all triggers
# ---------------------------------------------------------------------------

def test_terminal_state_blocks_triggers(conn: sqlite3.Connection) -> None:
    """Once hired, every trigger must raise IllegalTransitionError."""
    cid = "C-TEST-001"
    # Fast-track to hired.
    for t in [
        Trigger.START_SCREENING, Trigger.SCREENING_PASS,
        Trigger.APPROVE_INTERVIEW, Trigger.CONFIRM_INTERVIEW,
        Trigger.INTERVIEW_COMPLETE, Trigger.START_EVALUATION,
        Trigger.START_CALIBRATION, Trigger.CALIBRATION_COMPLETE,
        Trigger.HIRE,
    ]:
        transition_candidate(conn, cid, t)

    assert queries.get_candidate(conn, cid)["state"] == State.HIRED

    # Every trigger should now fail.
    for trigger in Trigger:
        with pytest.raises(IllegalTransitionError):
            transition_candidate(conn, cid, trigger)


# ---------------------------------------------------------------------------
# 4. Withdrawal from various non-terminal states
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("setup_triggers,expected_state", [
    ([], State.NEW),
    ([Trigger.START_SCREENING], State.SCREENING),
    ([Trigger.START_SCREENING, Trigger.SCREENING_PASS], State.SCREENED_PASS),
    (
        [Trigger.START_SCREENING, Trigger.SCREENING_PASS, Trigger.APPROVE_INTERVIEW],
        State.SCHEDULING,
    ),
    (
        [
            Trigger.START_SCREENING, Trigger.SCREENING_PASS,
            Trigger.APPROVE_INTERVIEW, Trigger.CONFIRM_INTERVIEW,
            Trigger.INTERVIEW_COMPLETE, Trigger.START_EVALUATION,
        ],
        State.EVALUATING,
    ),
])
def test_withdrawal_from_non_terminal(
    conn: sqlite3.Connection, setup_triggers: list[str], expected_state: str,
) -> None:
    cid = "C-TEST-001"
    for t in setup_triggers:
        transition_candidate(conn, cid, t)
    assert queries.get_candidate(conn, cid)["state"] == expected_state

    result = transition_candidate(conn, cid, Trigger.CANDIDATE_WITHDRAW)
    assert result == State.WITHDRAWN
    assert queries.get_candidate(conn, cid)["state"] == State.WITHDRAWN


# ---------------------------------------------------------------------------
# 5. Rejection from various non-terminal states
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("setup_triggers,expected_state", [
    ([], State.NEW),
    ([Trigger.START_SCREENING], State.SCREENING),
    (
        [
            Trigger.START_SCREENING, Trigger.SCREENING_PASS,
            Trigger.APPROVE_INTERVIEW, Trigger.CONFIRM_INTERVIEW,
            Trigger.INTERVIEW_COMPLETE, Trigger.START_EVALUATION,
        ],
        State.EVALUATING,
    ),
])
def test_rejection_from_non_terminal(
    conn: sqlite3.Connection, setup_triggers: list[str], expected_state: str,
) -> None:
    cid = "C-TEST-001"
    for t in setup_triggers:
        transition_candidate(conn, cid, t)

    result = transition_candidate(conn, cid, Trigger.REJECT_CANDIDATE)
    assert result == State.REJECTED
    assert queries.get_candidate(conn, cid)["state"] == State.REJECTED


# ---------------------------------------------------------------------------
# 6. History logging
# ---------------------------------------------------------------------------

def test_history_logging(conn: sqlite3.Connection) -> None:
    """After a transition, state_history must contain the right record."""
    cid = "C-TEST-001"
    transition_candidate(conn, cid, Trigger.START_SCREENING, actor="recruiter_bot")

    history = queries.get_state_history(conn, cid)
    assert len(history) == 1
    rec = history[0]
    assert rec["from_state"] == State.NEW
    assert rec["to_state"] == State.SCREENING
    assert rec["trigger"] == Trigger.START_SCREENING
    assert rec["actor"] == "recruiter_bot"


# ---------------------------------------------------------------------------
# 7. Atomicity -- nonexistent candidate
# ---------------------------------------------------------------------------

def test_atomicity_nonexistent_candidate(conn: sqlite3.Connection) -> None:
    """Transition for a missing candidate must leave DB unchanged."""
    # Capture row counts before.
    hist_before = conn.execute("SELECT COUNT(*) FROM state_history").fetchone()[0]
    audit_before = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]

    with pytest.raises(ValueError, match="not found"):
        transition_candidate(conn, "C-DOES-NOT-EXIST", Trigger.START_SCREENING)

    # Row counts must be unchanged.
    hist_after = conn.execute("SELECT COUNT(*) FROM state_history").fetchone()[0]
    audit_after = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
    assert hist_before == hist_after
    assert audit_before == audit_after


# ---------------------------------------------------------------------------
# 8. Scheduling self-loop
# ---------------------------------------------------------------------------

def test_scheduling_self_loop(conn: sqlite3.Connection) -> None:
    """scheduling -> scheduling via reschedule trigger."""
    cid = "C-TEST-001"
    for t in [Trigger.START_SCREENING, Trigger.SCREENING_PASS, Trigger.APPROVE_INTERVIEW]:
        transition_candidate(conn, cid, t)

    assert queries.get_candidate(conn, cid)["state"] == State.SCHEDULING

    result = transition_candidate(conn, cid, Trigger.RESCHEDULE)
    assert result == State.SCHEDULING
    assert queries.get_candidate(conn, cid)["state"] == State.SCHEDULING


# ---------------------------------------------------------------------------
# 9. Homework flow
# ---------------------------------------------------------------------------

def test_homework_flow(conn: sqlite3.Connection) -> None:
    """homework_assigned -> homework_overdue -> homework_submitted -> evaluating."""
    cid = "C-TEST-001"
    # Get to evaluating first.
    for t in [
        Trigger.START_SCREENING, Trigger.SCREENING_PASS,
        Trigger.APPROVE_INTERVIEW, Trigger.CONFIRM_INTERVIEW,
        Trigger.INTERVIEW_COMPLETE, Trigger.START_EVALUATION,
    ]:
        transition_candidate(conn, cid, t)

    # Assign homework.
    result = transition_candidate(conn, cid, Trigger.ASSIGN_HOMEWORK)
    assert result == State.HOMEWORK_ASSIGNED

    # Deadline passes.
    result = transition_candidate(conn, cid, Trigger.HOMEWORK_DEADLINE_PASSED)
    assert result == State.HOMEWORK_OVERDUE

    # Late submission.
    result = transition_candidate(conn, cid, Trigger.SUBMIT_HOMEWORK)
    assert result == State.HOMEWORK_SUBMITTED

    # Review complete -> back to evaluating.
    result = transition_candidate(conn, cid, Trigger.REVIEW_COMPLETE)
    assert result == State.EVALUATING


# ---------------------------------------------------------------------------
# 10. get_valid_triggers
# ---------------------------------------------------------------------------

def test_get_valid_triggers_new() -> None:
    triggers = get_valid_triggers(State.NEW)
    assert Trigger.START_SCREENING in triggers
    # Global transitions should be present for non-terminal.
    assert Trigger.CANDIDATE_WITHDRAW in triggers
    assert Trigger.REJECT_CANDIDATE in triggers


def test_get_valid_triggers_evaluating() -> None:
    triggers = get_valid_triggers(State.EVALUATING)
    expected = {
        Trigger.SCHEDULE_NEXT_ROUND,
        Trigger.ASSIGN_HOMEWORK,
        Trigger.START_CALIBRATION,
        Trigger.REJECT_CANDIDATE,
        Trigger.CANDIDATE_WITHDRAW,
    }
    assert set(triggers) == expected


def test_get_valid_triggers_terminal() -> None:
    """Terminal states should have no valid triggers."""
    for state in [State.HIRED, State.REJECTED, State.SCREENED_REJECT, State.WITHDRAWN, State.NO_SHOW]:
        assert get_valid_triggers(state) == []


# ---------------------------------------------------------------------------
# 11. is_terminal
# ---------------------------------------------------------------------------

def test_is_terminal() -> None:
    assert is_terminal(State.HIRED) is True
    assert is_terminal(State.REJECTED) is True
    assert is_terminal(State.SCREENED_REJECT) is True
    assert is_terminal(State.WITHDRAWN) is True
    assert is_terminal(State.NO_SHOW) is True


def test_is_not_terminal() -> None:
    non_terminal = [
        State.NEW, State.SCREENING, State.SCREENED_PASS, State.SCHEDULING,
        State.INTERVIEW_CONFIRMED, State.INTERVIEW_DONE, State.EVALUATING,
        State.HOMEWORK_ASSIGNED, State.HOMEWORK_SUBMITTED, State.HOMEWORK_OVERDUE,
        State.CALIBRATION, State.DECISION_PENDING,
    ]
    # Note: SCREENED_REJECT is terminal, not in this list
    for state in non_terminal:
        assert is_terminal(state) is False, f"{state} should not be terminal"
