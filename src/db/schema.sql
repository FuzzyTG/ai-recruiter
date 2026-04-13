-- AI Recruiter Database Schema
-- SQLite with WAL mode, foreign keys enabled

-- Core: candidates and state tracking
CREATE TABLE IF NOT EXISTS candidates (
    candidate_id    TEXT PRIMARY KEY,        -- "C-20260411-001"
    name            TEXT NOT NULL,
    email           TEXT NOT NULL,
    role            TEXT NOT NULL,           -- Job title applied for
    state           TEXT NOT NULL DEFAULT 'new',
    state_updated   TEXT NOT NULL,           -- ISO 8601
    resume_path     TEXT,                    -- Local file path
    thread_id       TEXT,                    -- AgentMail thread ID
    inbox_id        TEXT,                    -- AgentMail inbox ID
    pending_action  TEXT,                    -- What's waiting (approval, reply, etc.)
    match_score     REAL,                    -- Weighted screening score (0-100)
    created_at      TEXT NOT NULL
);

-- Immutable audit log (PRD 7.4, 12.4)
CREATE TABLE IF NOT EXISTS state_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    TEXT NOT NULL REFERENCES candidates(candidate_id),
    from_state      TEXT,
    to_state        TEXT NOT NULL,
    trigger         TEXT,                    -- What caused the transition
    actor           TEXT,                    -- 'system', 'hm', 'candidate'
    timestamp       TEXT NOT NULL,
    UNIQUE(candidate_id, timestamp)
);

-- Evaluation framework (PRD 4.1)
CREATE TABLE IF NOT EXISTS evaluation_frameworks (
    framework_id    TEXT PRIMARY KEY,
    job_title       TEXT NOT NULL,
    jd_text         TEXT,                    -- Original JD
    confirmed       INTEGER NOT NULL DEFAULT 0,  -- HM confirmed?
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_dimensions (
    dimension_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    framework_id    TEXT NOT NULL REFERENCES evaluation_frameworks(framework_id),
    name            TEXT NOT NULL,           -- e.g., "AI native thinking"
    weight          REAL NOT NULL,           -- 0.0-1.0
    threshold       REAL,                    -- Minimum score to pass
    scoring_guide   TEXT                     -- What 1-5 means for this dimension
);

-- Per-candidate scores (PRD 4.2)
CREATE TABLE IF NOT EXISTS candidate_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    TEXT NOT NULL REFERENCES candidates(candidate_id),
    dimension_id    INTEGER NOT NULL REFERENCES evaluation_dimensions(dimension_id),
    score           REAL NOT NULL,           -- 1-5
    reasoning       TEXT,                    -- LLM's reasoning
    source          TEXT NOT NULL,           -- 'resume_screen', 'interview', 'homework'
    created_at      TEXT NOT NULL
);

-- Interview scheduling (PRD 4.3)
CREATE TABLE IF NOT EXISTS interviews (
    interview_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    TEXT NOT NULL REFERENCES candidates(candidate_id),
    round           INTEGER NOT NULL DEFAULT 1,
    scheduled_time  TEXT,                    -- ISO 8601
    meeting_link    TEXT,                    -- Fixed link from setup
    ics_sent        INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'pending',  -- pending, confirmed, done, no_show, cancelled
    hm_feedback     TEXT,                    -- Raw HM feedback (free text)
    created_at      TEXT NOT NULL
);

-- Homework assignments (PRD 4.5)
CREATE TABLE IF NOT EXISTS homework (
    homework_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    TEXT NOT NULL REFERENCES candidates(candidate_id),
    content_path    TEXT,                    -- Markdown/HTML file path
    token           TEXT UNIQUE,             -- Access token for homework URL
    deadline        TEXT NOT NULL,           -- ISO 8601
    submitted_at    TEXT,
    submission_path TEXT,                    -- Submitted work file path
    created_at      TEXT NOT NULL
);

-- Approval queue (PRD 5, 12.2)
CREATE TABLE IF NOT EXISTS approvals (
    approval_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    TEXT REFERENCES candidates(candidate_id),
    action_type     TEXT NOT NULL,           -- 'send_first_email', 'send_homework', 'advance', 'reject'
    content_preview TEXT,                    -- What will be sent/done
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, auto
    reviewer_flags  TEXT,                    -- JSON: soft warnings from Reviewer Agent
    slack_message_ts TEXT,                   -- Slack message timestamp
    requested_at    TEXT NOT NULL,
    resolved_at     TEXT
);

-- Audit log for all actions (PRD 5.1, 12.6)
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type     TEXT NOT NULL,
    candidate_id    TEXT,
    details         TEXT,                    -- JSON blob
    auto_mode       INTEGER DEFAULT 0,      -- Was this auto-approved?
    timestamp       TEXT NOT NULL
);

-- Setup / configuration
CREATE TABLE IF NOT EXISTS config (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_candidates_state ON candidates(state);
CREATE INDEX IF NOT EXISTS idx_candidates_role ON candidates(role);
CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email);

CREATE INDEX IF NOT EXISTS idx_state_history_candidate ON state_history(candidate_id);
CREATE INDEX IF NOT EXISTS idx_state_history_timestamp ON state_history(timestamp);

CREATE INDEX IF NOT EXISTS idx_evaluation_dimensions_framework ON evaluation_dimensions(framework_id);

CREATE INDEX IF NOT EXISTS idx_candidate_scores_candidate ON candidate_scores(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_scores_dimension ON candidate_scores(dimension_id);

CREATE INDEX IF NOT EXISTS idx_interviews_candidate ON interviews(candidate_id);
CREATE INDEX IF NOT EXISTS idx_interviews_status ON interviews(status);

CREATE INDEX IF NOT EXISTS idx_homework_candidate ON homework(candidate_id);
CREATE INDEX IF NOT EXISTS idx_homework_token ON homework(token);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_candidate ON approvals(candidate_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_candidate ON audit_log(candidate_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
