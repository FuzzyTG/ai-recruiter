"""Tests for the database layer (src.db.connection + src.db.queries).

Uses in-memory SQLite for every test so there are no side effects.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from src.db import queries
from src.db.connection import init_db

SCHEMA_PATH = Path(__file__).parent.parent / "src" / "db" / "schema.sql"

EXPECTED_TABLES = {
    "candidates",
    "state_history",
    "evaluation_frameworks",
    "evaluation_dimensions",
    "candidate_scores",
    "interviews",
    "homework",
    "approvals",
    "audit_log",
    "config",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def conn() -> sqlite3.Connection:
    """In-memory DB with schema applied."""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
    db.executescript(schema_sql)
    return db


@pytest.fixture()
def seeded_conn(conn: sqlite3.Connection) -> sqlite3.Connection:
    """DB with a single test candidate already created."""
    now = _now_iso()
    queries.create_candidate(
        conn,
        candidate_id="C-TEST-001",
        name="Ada Lovelace",
        email="ada@example.com",
        role="Engineer",
        state_updated=now,
        created_at=now,
    )
    conn.commit()
    return conn


# ---------------------------------------------------------------------------
# 1. init_db creates all tables
# ---------------------------------------------------------------------------

def test_init_db_creates_tables() -> None:
    """Verify that init_db creates all expected tables."""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
    db.executescript(schema_sql)

    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    table_names = {r["name"] for r in rows}

    assert EXPECTED_TABLES.issubset(table_names), (
        f"Missing tables: {EXPECTED_TABLES - table_names}"
    )


# ---------------------------------------------------------------------------
# 2. Create / get candidate round-trip
# ---------------------------------------------------------------------------

def test_create_and_get_candidate(conn: sqlite3.Connection) -> None:
    now = _now_iso()
    result = queries.create_candidate(
        conn,
        candidate_id="C-RT-001",
        name="Grace Hopper",
        email="grace@example.com",
        role="Software Engineer",
        state_updated=now,
        created_at=now,
    )
    assert result is not None
    assert result["candidate_id"] == "C-RT-001"
    assert result["name"] == "Grace Hopper"
    assert result["email"] == "grace@example.com"
    assert result["role"] == "Software Engineer"
    assert result["state"] == "new"

    fetched = queries.get_candidate(conn, "C-RT-001")
    assert fetched is not None
    assert fetched["name"] == "Grace Hopper"


def test_get_candidate_missing(conn: sqlite3.Connection) -> None:
    assert queries.get_candidate(conn, "C-NOPE") is None


# ---------------------------------------------------------------------------
# 3. List candidates with state filter
# ---------------------------------------------------------------------------

def test_list_candidates_all(seeded_conn: sqlite3.Connection) -> None:
    all_candidates = queries.list_candidates(seeded_conn)
    assert len(all_candidates) == 1
    assert all_candidates[0]["candidate_id"] == "C-TEST-001"


def test_list_candidates_by_state(seeded_conn: sqlite3.Connection) -> None:
    matches = queries.list_candidates(seeded_conn, state="new")
    assert len(matches) == 1

    no_match = queries.list_candidates(seeded_conn, state="hired")
    assert len(no_match) == 0


# ---------------------------------------------------------------------------
# 4. State history insert and retrieval
# ---------------------------------------------------------------------------

def test_state_history_round_trip(seeded_conn: sqlite3.Connection) -> None:
    now = _now_iso()
    row = queries.insert_state_history(
        seeded_conn,
        candidate_id="C-TEST-001",
        from_state="new",
        to_state="screening",
        trigger="start_screening",
        actor="test_bot",
        timestamp=now,
    )
    assert row is not None

    history = queries.get_state_history(seeded_conn, "C-TEST-001")
    assert len(history) == 1
    rec = history[0]
    assert rec["from_state"] == "new"
    assert rec["to_state"] == "screening"
    assert rec["trigger"] == "start_screening"
    assert rec["actor"] == "test_bot"


def test_state_history_ordering(seeded_conn: sqlite3.Connection) -> None:
    """Multiple entries should come back sorted by timestamp ASC."""
    queries.insert_state_history(
        seeded_conn, "C-TEST-001", "new", "screening", "start_screening", "system", _now_iso()
    )
    queries.insert_state_history(
        seeded_conn, "C-TEST-001", "screening", "screened_pass", "screening_pass", "system", _now_iso()
    )

    history = queries.get_state_history(seeded_conn, "C-TEST-001")
    assert len(history) == 2
    assert history[0]["from_state"] == "new"
    assert history[1]["from_state"] == "screening"


# ---------------------------------------------------------------------------
# 5. Config get / set
# ---------------------------------------------------------------------------

def test_config_get_missing(conn: sqlite3.Connection) -> None:
    assert queries.get_config(conn, "nonexistent") is None


def test_config_set_and_get(conn: sqlite3.Connection) -> None:
    queries.set_config(conn, "meeting_link", "https://zoom.us/123")
    row = queries.get_config(conn, "meeting_link")
    assert row is not None
    assert row["value"] == "https://zoom.us/123"


def test_config_upsert(conn: sqlite3.Connection) -> None:
    queries.set_config(conn, "mode", "manual")
    queries.set_config(conn, "mode", "auto")
    row = queries.get_config(conn, "mode")
    assert row is not None
    assert row["value"] == "auto"


# ---------------------------------------------------------------------------
# 6. Framework + dimensions CRUD
# ---------------------------------------------------------------------------

def test_create_and_get_framework(conn: sqlite3.Connection) -> None:
    now = _now_iso()
    fw = queries.create_framework(conn, "FW-001", "Backend Engineer", now, jd_text="Build APIs")
    assert fw is not None
    assert fw["framework_id"] == "FW-001"
    assert fw["job_title"] == "Backend Engineer"
    assert fw["jd_text"] == "Build APIs"

    fetched = queries.get_framework(conn, "FW-001")
    assert fetched is not None
    assert fetched["job_title"] == "Backend Engineer"


def test_get_framework_missing(conn: sqlite3.Connection) -> None:
    assert queries.get_framework(conn, "FW-NOPE") is None


def test_add_and_get_dimensions(conn: sqlite3.Connection) -> None:
    now = _now_iso()
    queries.create_framework(conn, "FW-D-001", "ML Engineer", now)

    queries.add_dimension(conn, "FW-D-001", "Technical Depth", 0.4, threshold=3.0)
    queries.add_dimension(conn, "FW-D-001", "Communication", 0.3, scoring_guide="1=poor, 5=excellent")

    dims = queries.get_dimensions(conn, "FW-D-001")
    assert len(dims) == 2
    assert dims[0]["name"] == "Technical Depth"
    assert dims[0]["weight"] == 0.4
    assert dims[0]["threshold"] == 3.0
    assert dims[1]["name"] == "Communication"
    assert dims[1]["scoring_guide"] == "1=poor, 5=excellent"


# ---------------------------------------------------------------------------
# 7. Approval lifecycle
# ---------------------------------------------------------------------------

def test_approval_lifecycle(seeded_conn: sqlite3.Connection) -> None:
    now = _now_iso()
    row = queries.create_approval(
        seeded_conn,
        action_type="send_first_email",
        requested_at=now,
        candidate_id="C-TEST-001",
        content_preview="Hello Ada...",
    )
    assert row is not None
    aid = row["approval_id"]

    # Should appear in pending list.
    pending = queries.get_pending_approvals(seeded_conn)
    assert len(pending) == 1
    assert pending[0]["approval_id"] == aid
    assert pending[0]["status"] == "pending"
    assert pending[0]["content_preview"] == "Hello Ada..."

    # Resolve it.
    queries.resolve_approval(seeded_conn, aid, "approved", _now_iso())

    # No longer pending.
    pending_after = queries.get_pending_approvals(seeded_conn)
    assert len(pending_after) == 0


def test_approval_reject(seeded_conn: sqlite3.Connection) -> None:
    now = _now_iso()
    row = queries.create_approval(
        seeded_conn,
        action_type="advance",
        requested_at=now,
        candidate_id="C-TEST-001",
    )
    aid = row["approval_id"]
    queries.resolve_approval(seeded_conn, aid, "rejected", _now_iso())

    pending = queries.get_pending_approvals(seeded_conn)
    assert len(pending) == 0


def test_multiple_pending_approvals(seeded_conn: sqlite3.Connection) -> None:
    now = _now_iso()
    row1 = queries.create_approval(
        seeded_conn, "send_email", now, candidate_id="C-TEST-001",
    )
    row2 = queries.create_approval(
        seeded_conn, "advance", now, candidate_id="C-TEST-001",
    )
    aid1 = row1["approval_id"]
    aid2 = row2["approval_id"]

    pending = queries.get_pending_approvals(seeded_conn)
    assert len(pending) == 2

    queries.resolve_approval(seeded_conn, aid1, "approved", _now_iso())
    pending = queries.get_pending_approvals(seeded_conn)
    assert len(pending) == 1
    assert pending[0]["approval_id"] == aid2
