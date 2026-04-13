"""Query functions for every table in the AI Recruiter database.

All functions accept a sqlite3.Connection as the first argument
and use parameterized queries exclusively.  Return values are
sqlite3.Row objects (or lists thereof).
"""

from __future__ import annotations

import sqlite3


# ---------------------------------------------------------------------------
# candidates
# ---------------------------------------------------------------------------

def create_candidate(
    conn: sqlite3.Connection,
    candidate_id: str,
    name: str,
    email: str,
    role: str,
    state_updated: str,
    created_at: str,
    *,
    state: str = "new",
    resume_path: str | None = None,
    thread_id: str | None = None,
    inbox_id: str | None = None,
    pending_action: str | None = None,
    match_score: float | None = None,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO candidates
            (candidate_id, name, email, role, state, state_updated,
             resume_path, thread_id, inbox_id, pending_action, match_score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            candidate_id, name, email, role, state, state_updated,
            resume_path, thread_id, inbox_id, pending_action, match_score,
            created_at,
        ),
    )
    return conn.execute(
        "SELECT * FROM candidates WHERE rowid = ?", (cur.lastrowid,)
    ).fetchone()


def get_candidate(conn: sqlite3.Connection, candidate_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM candidates WHERE candidate_id = ?", (candidate_id,)
    ).fetchone()


def list_candidates(
    conn: sqlite3.Connection, state: str | None = None
) -> list[sqlite3.Row]:
    if state is not None:
        return conn.execute(
            "SELECT * FROM candidates WHERE state = ? ORDER BY created_at DESC",
            (state,),
        ).fetchall()
    return conn.execute(
        "SELECT * FROM candidates ORDER BY created_at DESC"
    ).fetchall()


def update_candidate_state(
    conn: sqlite3.Connection,
    candidate_id: str,
    new_state: str,
    state_updated: str,
) -> None:
    conn.execute(
        "UPDATE candidates SET state = ?, state_updated = ? WHERE candidate_id = ?",
        (new_state, state_updated, candidate_id),
    )


# ---------------------------------------------------------------------------
# state_history
# ---------------------------------------------------------------------------

def insert_state_history(
    conn: sqlite3.Connection,
    candidate_id: str,
    from_state: str | None,
    to_state: str,
    trigger: str | None,
    actor: str | None,
    timestamp: str,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO state_history
            (candidate_id, from_state, to_state, trigger, actor, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (candidate_id, from_state, to_state, trigger, actor, timestamp),
    )
    return conn.execute(
        "SELECT * FROM state_history WHERE id = ?", (cur.lastrowid,)
    ).fetchone()


def get_state_history(
    conn: sqlite3.Connection, candidate_id: str
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM state_history WHERE candidate_id = ? ORDER BY timestamp",
        (candidate_id,),
    ).fetchall()


# ---------------------------------------------------------------------------
# evaluation_frameworks
# ---------------------------------------------------------------------------

def create_framework(
    conn: sqlite3.Connection,
    framework_id: str,
    job_title: str,
    created_at: str,
    *,
    jd_text: str | None = None,
    confirmed: int = 0,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO evaluation_frameworks
            (framework_id, job_title, jd_text, confirmed, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (framework_id, job_title, jd_text, confirmed, created_at),
    )
    return conn.execute(
        "SELECT * FROM evaluation_frameworks WHERE rowid = ?", (cur.lastrowid,)
    ).fetchone()


def get_framework(
    conn: sqlite3.Connection, framework_id: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM evaluation_frameworks WHERE framework_id = ?",
        (framework_id,),
    ).fetchone()


def confirm_framework(conn: sqlite3.Connection, framework_id: str) -> None:
    conn.execute(
        "UPDATE evaluation_frameworks SET confirmed = 1 WHERE framework_id = ?",
        (framework_id,),
    )


# ---------------------------------------------------------------------------
# evaluation_dimensions
# ---------------------------------------------------------------------------

def add_dimension(
    conn: sqlite3.Connection,
    framework_id: str,
    name: str,
    weight: float,
    *,
    threshold: float | None = None,
    scoring_guide: str | None = None,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO evaluation_dimensions
            (framework_id, name, weight, threshold, scoring_guide)
        VALUES (?, ?, ?, ?, ?)
        """,
        (framework_id, name, weight, threshold, scoring_guide),
    )
    return conn.execute(
        "SELECT * FROM evaluation_dimensions WHERE dimension_id = ?",
        (cur.lastrowid,),
    ).fetchone()


def get_dimensions(
    conn: sqlite3.Connection, framework_id: str
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM evaluation_dimensions WHERE framework_id = ? ORDER BY dimension_id",
        (framework_id,),
    ).fetchall()


# ---------------------------------------------------------------------------
# candidate_scores
# ---------------------------------------------------------------------------

def add_score(
    conn: sqlite3.Connection,
    candidate_id: str,
    dimension_id: int,
    score: float,
    source: str,
    created_at: str,
    *,
    reasoning: str | None = None,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO candidate_scores
            (candidate_id, dimension_id, score, reasoning, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (candidate_id, dimension_id, score, reasoning, source, created_at),
    )
    return conn.execute(
        "SELECT * FROM candidate_scores WHERE id = ?", (cur.lastrowid,)
    ).fetchone()


def get_candidate_scores(
    conn: sqlite3.Connection, candidate_id: str
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM candidate_scores WHERE candidate_id = ? ORDER BY created_at",
        (candidate_id,),
    ).fetchall()


# ---------------------------------------------------------------------------
# interviews
# ---------------------------------------------------------------------------

def create_interview(
    conn: sqlite3.Connection,
    candidate_id: str,
    created_at: str,
    *,
    round: int = 1,
    scheduled_time: str | None = None,
    meeting_link: str | None = None,
    ics_sent: int = 0,
    status: str = "pending",
    hm_feedback: str | None = None,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO interviews
            (candidate_id, round, scheduled_time, meeting_link,
             ics_sent, status, hm_feedback, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            candidate_id, round, scheduled_time, meeting_link,
            ics_sent, status, hm_feedback, created_at,
        ),
    )
    return conn.execute(
        "SELECT * FROM interviews WHERE interview_id = ?", (cur.lastrowid,)
    ).fetchone()


def get_interviews(
    conn: sqlite3.Connection, candidate_id: str
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM interviews WHERE candidate_id = ? ORDER BY round",
        (candidate_id,),
    ).fetchall()


def update_interview_status(
    conn: sqlite3.Connection, interview_id: int, status: str
) -> None:
    conn.execute(
        "UPDATE interviews SET status = ? WHERE interview_id = ?",
        (status, interview_id),
    )


# ---------------------------------------------------------------------------
# homework
# ---------------------------------------------------------------------------

def create_homework(
    conn: sqlite3.Connection,
    candidate_id: str,
    deadline: str,
    created_at: str,
    *,
    content_path: str | None = None,
    token: str | None = None,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO homework
            (candidate_id, content_path, token, deadline, submitted_at,
             submission_path, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?)
        """,
        (candidate_id, content_path, token, deadline, created_at),
    )
    return conn.execute(
        "SELECT * FROM homework WHERE homework_id = ?", (cur.lastrowid,)
    ).fetchone()


def get_homework(
    conn: sqlite3.Connection, candidate_id: str
) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM homework WHERE candidate_id = ? ORDER BY created_at",
        (candidate_id,),
    ).fetchall()


def update_homework_submission(
    conn: sqlite3.Connection,
    homework_id: int,
    submitted_at: str,
    submission_path: str,
) -> None:
    conn.execute(
        "UPDATE homework SET submitted_at = ?, submission_path = ? WHERE homework_id = ?",
        (submitted_at, submission_path, homework_id),
    )


# ---------------------------------------------------------------------------
# approvals
# ---------------------------------------------------------------------------

def create_approval(
    conn: sqlite3.Connection,
    action_type: str,
    requested_at: str,
    *,
    candidate_id: str | None = None,
    content_preview: str | None = None,
    status: str = "pending",
    reviewer_flags: str | None = None,
    slack_message_ts: str | None = None,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO approvals
            (candidate_id, action_type, content_preview, status,
             reviewer_flags, slack_message_ts, requested_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            candidate_id, action_type, content_preview, status,
            reviewer_flags, slack_message_ts, requested_at,
        ),
    )
    return conn.execute(
        "SELECT * FROM approvals WHERE approval_id = ?", (cur.lastrowid,)
    ).fetchone()


def get_pending_approvals(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at"
    ).fetchall()


def resolve_approval(
    conn: sqlite3.Connection,
    approval_id: int,
    status: str,
    resolved_at: str,
) -> None:
    conn.execute(
        "UPDATE approvals SET status = ?, resolved_at = ? WHERE approval_id = ?",
        (status, resolved_at, approval_id),
    )


# ---------------------------------------------------------------------------
# audit_log
# ---------------------------------------------------------------------------

def log_action(
    conn: sqlite3.Connection,
    action_type: str,
    timestamp: str,
    *,
    candidate_id: str | None = None,
    details: str | None = None,
    auto_mode: int = 0,
) -> sqlite3.Row:
    cur = conn.execute(
        """
        INSERT INTO audit_log
            (action_type, candidate_id, details, auto_mode, timestamp)
        VALUES (?, ?, ?, ?, ?)
        """,
        (action_type, candidate_id, details, auto_mode, timestamp),
    )
    return conn.execute(
        "SELECT * FROM audit_log WHERE id = ?", (cur.lastrowid,)
    ).fetchone()


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def get_config(conn: sqlite3.Connection, key: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM config WHERE key = ?", (key,)
    ).fetchone()


def set_config(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (key, value),
    )
