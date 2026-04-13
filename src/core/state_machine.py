"""Candidate state machine for the AI Recruiter pipeline.

Implements the 17-state hiring workflow defined in PRD section 7.
All state transitions are validated against a static transition table
and executed atomically (state update + history + audit log in one
transaction).
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from src.db import queries
from src.db.connection import transaction


def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# States
# ---------------------------------------------------------------------------

class State(str, Enum):
    NEW = "new"
    SCREENING = "screening"
    SCREENED_PASS = "screened_pass"
    SCREENED_REJECT = "screened_reject"
    SCHEDULING = "scheduling"
    INTERVIEW_CONFIRMED = "interview_confirmed"
    INTERVIEW_DONE = "interview_done"
    EVALUATING = "evaluating"
    HOMEWORK_ASSIGNED = "homework_assigned"
    HOMEWORK_SUBMITTED = "homework_submitted"
    HOMEWORK_OVERDUE = "homework_overdue"
    CALIBRATION = "calibration"
    DECISION_PENDING = "decision_pending"
    HIRED = "hired"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    NO_SHOW = "no_show"


TERMINAL_STATES: frozenset[str] = frozenset({
    State.HIRED,
    State.REJECTED,
    State.SCREENED_REJECT,
    State.WITHDRAWN,
    State.NO_SHOW,
})


# ---------------------------------------------------------------------------
# Triggers
# ---------------------------------------------------------------------------

class Trigger(str, Enum):
    START_SCREENING = "start_screening"
    SCREENING_PASS = "screening_pass"
    SCREENING_REJECT = "screening_reject"
    APPROVE_INTERVIEW = "approve_interview"
    CONFIRM_INTERVIEW = "confirm_interview"
    RESCHEDULE = "reschedule"
    INTERVIEW_COMPLETE = "interview_complete"
    CANDIDATE_NO_SHOW = "candidate_no_show"
    START_EVALUATION = "start_evaluation"
    SCHEDULE_NEXT_ROUND = "schedule_next_round"
    ASSIGN_HOMEWORK = "assign_homework"
    START_CALIBRATION = "start_calibration"
    REJECT_CANDIDATE = "reject_candidate"
    SUBMIT_HOMEWORK = "submit_homework"
    HOMEWORK_DEADLINE_PASSED = "homework_deadline_passed"
    REVIEW_COMPLETE = "review_complete"
    SCHEDULE_ADDITIONAL_INTERVIEW = "schedule_additional_interview"
    CALIBRATION_COMPLETE = "calibration_complete"
    HIRE = "hire"
    CANDIDATE_WITHDRAW = "candidate_withdraw"


# ---------------------------------------------------------------------------
# Transition table
# ---------------------------------------------------------------------------
# Mapping: {current_state: {trigger: next_state}}

TRANSITIONS: dict[str, dict[str, str]] = {
    State.NEW: {
        Trigger.START_SCREENING: State.SCREENING,
    },
    State.SCREENING: {
        Trigger.SCREENING_PASS: State.SCREENED_PASS,
        Trigger.SCREENING_REJECT: State.SCREENED_REJECT,
    },
    State.SCREENED_PASS: {
        Trigger.APPROVE_INTERVIEW: State.SCHEDULING,
    },
    State.SCHEDULING: {
        Trigger.CONFIRM_INTERVIEW: State.INTERVIEW_CONFIRMED,
        Trigger.RESCHEDULE: State.SCHEDULING,
    },
    State.INTERVIEW_CONFIRMED: {
        Trigger.INTERVIEW_COMPLETE: State.INTERVIEW_DONE,
        Trigger.CANDIDATE_NO_SHOW: State.NO_SHOW,
    },
    State.INTERVIEW_DONE: {
        Trigger.START_EVALUATION: State.EVALUATING,
    },
    State.EVALUATING: {
        Trigger.SCHEDULE_NEXT_ROUND: State.SCHEDULING,
        Trigger.ASSIGN_HOMEWORK: State.HOMEWORK_ASSIGNED,
        Trigger.START_CALIBRATION: State.CALIBRATION,
        Trigger.REJECT_CANDIDATE: State.REJECTED,
    },
    State.HOMEWORK_ASSIGNED: {
        Trigger.SUBMIT_HOMEWORK: State.HOMEWORK_SUBMITTED,
        Trigger.HOMEWORK_DEADLINE_PASSED: State.HOMEWORK_OVERDUE,
    },
    State.HOMEWORK_OVERDUE: {
        Trigger.SUBMIT_HOMEWORK: State.HOMEWORK_SUBMITTED,
        Trigger.REJECT_CANDIDATE: State.REJECTED,
    },
    State.HOMEWORK_SUBMITTED: {
        Trigger.REVIEW_COMPLETE: State.EVALUATING,
        Trigger.SCHEDULE_ADDITIONAL_INTERVIEW: State.SCHEDULING,
    },
    State.CALIBRATION: {
        Trigger.CALIBRATION_COMPLETE: State.DECISION_PENDING,
    },
    State.DECISION_PENDING: {
        Trigger.HIRE: State.HIRED,
        Trigger.REJECT_CANDIDATE: State.REJECTED,
    },
    # Terminal states have no outgoing transitions.
    State.SCREENED_REJECT: {},
    State.HIRED: {},
    State.REJECTED: {},
    State.WITHDRAWN: {},
    State.NO_SHOW: {},
}


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------

class IllegalTransitionError(Exception):
    """Raised when a trigger is not valid from the current state."""

    def __init__(self, from_state: str, trigger: str, candidate_id: str) -> None:
        self.from_state = from_state
        self.trigger = trigger
        self.candidate_id = candidate_id
        super().__init__(
            f"Illegal transition: cannot apply trigger {trigger!r} "
            f"from state {from_state!r} for candidate {candidate_id!r}"
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_terminal(state: str) -> bool:
    """Return True if *state* is a terminal (absorbing) state."""
    return state in TERMINAL_STATES


def get_valid_triggers(state: str) -> list[str]:
    """Return the list of triggers valid from *state*.

    For non-terminal states, ``candidate_withdraw`` and ``reject_candidate``
    are always included (global transitions).
    """
    state_triggers = list(TRANSITIONS.get(state, {}).keys())

    if not is_terminal(state):
        # Global transitions available from every non-terminal state.
        if Trigger.CANDIDATE_WITHDRAW not in state_triggers:
            state_triggers.append(Trigger.CANDIDATE_WITHDRAW)
        if Trigger.REJECT_CANDIDATE not in state_triggers:
            state_triggers.append(Trigger.REJECT_CANDIDATE)

    return state_triggers


def _resolve_transition(current_state: str, trigger: str) -> str | None:
    """Return the target state for (current_state, trigger), or None if illegal."""
    # Check state-specific transitions first.
    target = TRANSITIONS.get(current_state, {}).get(trigger)
    if target is not None:
        return target

    # Global transitions from any non-terminal state.
    if not is_terminal(current_state):
        if trigger == Trigger.CANDIDATE_WITHDRAW:
            return State.WITHDRAWN
        if trigger == Trigger.REJECT_CANDIDATE:
            return State.REJECTED

    return None


# ---------------------------------------------------------------------------
# Main transition function
# ---------------------------------------------------------------------------

def transition_candidate(
    conn,
    candidate_id: str,
    trigger: str,
    actor: str = "system",
    details: str | None = None,
) -> str:
    """Transition a candidate to a new state.

    1. Loads the current state from the DB.
    2. Validates that *trigger* is legal from the current state.
    3. Atomically updates the candidate row, inserts a state_history record,
       and appends an audit log entry -- all inside a single transaction.

    Args:
        conn: A sqlite3 connection (not in an active transaction).
        candidate_id: The candidate's primary-key ID.
        trigger: One of the valid trigger strings.
        actor: Who initiated this transition ('system', 'hm', or similar).
        details: Optional free-text context.

    Returns:
        The new state string.

    Raises:
        IllegalTransitionError: If the trigger is not valid for the current state.
        ValueError: If the candidate does not exist.
    """
    # Read current state (outside the write transaction).
    candidate = queries.get_candidate(conn, candidate_id)
    if candidate is None:
        raise ValueError(f"Candidate {candidate_id!r} not found")

    current_state = candidate["state"]

    # Validate.
    new_state = _resolve_transition(current_state, trigger)
    if new_state is None:
        raise IllegalTransitionError(current_state, trigger, candidate_id)

    # Atomic write: state + history + audit.
    with transaction(conn):
        now = _now_iso()
        queries.update_candidate_state(conn, candidate_id, new_state, now)
        queries.insert_state_history(
            conn,
            candidate_id,
            from_state=current_state,
            to_state=new_state,
            trigger=trigger,
            actor=actor,
            timestamp=now,
        )
        queries.log_action(
            conn,
            action_type=f"state_transition:{trigger}",
            timestamp=now,
            candidate_id=candidate_id,
            details=details,
        )

    return new_state
