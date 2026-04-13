"""Database connection helpers for the AI Recruiter project."""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = os.environ.get("RECRUITER_DB_PATH", "data/recruiter.db")

_SCHEMA_FILE = Path(__file__).parent / "schema.sql"


def get_connection(db_path: str | None = None) -> sqlite3.Connection:
    """Return a sqlite3 connection with WAL mode, foreign keys, and Row factory.

    Args:
        db_path: Path to the SQLite database file. Falls back to DB_PATH.
    """
    db_path = db_path or DB_PATH
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: str | None = None) -> sqlite3.Connection:
    """Create all tables from schema.sql (idempotent via IF NOT EXISTS).

    Returns the open connection so callers can use it immediately.
    """
    conn = get_connection(db_path)
    schema_sql = _SCHEMA_FILE.read_text(encoding="utf-8")
    conn.executescript(schema_sql)
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection):
    """Context manager that wraps a block in BEGIN / COMMIT, rolling back on error.

    Usage:
        with transaction(conn):
            queries.create_candidate(conn, ...)
            queries.insert_state_history(conn, ...)
    """
    conn.execute("BEGIN")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
