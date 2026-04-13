# AI Recruiter

AI Recruiter is an AI-powered recruiting assistant that acts as a third-party recruiter on behalf of hiring managers. It handles the full recruiting pipeline — from resume screening to interview scheduling to hiring decisions — through a chat-first interface (Slack).

## How It Works

```
Hiring Manager (you)
       ↕ Chat (Slack)
AI Recruiter
       ↕ Email (AgentMail)
Candidate
```

- You chat with AI Recruiter in Slack — give commands, upload resumes, approve actions
- AI Recruiter emails candidates on your behalf (scheduling, follow-ups, homework)
- A read-only dashboard (localhost) shows pipeline status, candidate comparisons, and scoring

## Key Features (V1)

- **Evaluation framework** — AI generates scoring dimensions from your job description
- **Resume screening** — Drop PDFs in Slack, get scored and ranked candidates
- **Interview scheduling** — Calendar-aware scheduling via email, with ICS attachments
- **Interview evaluation** — Describe your impression in chat, AI structures it into scores
- **Homework management** — Assign, track deadlines, auto-remind
- **Candidate pipeline** — Full state machine with 17 states and audit trail
- **Approval system** — AI acts autonomously on routine tasks, asks permission on decisions

## Architecture

- **Chat-first**: Slack bot (Socket Mode) as the primary interface
- **Local-first**: Runs on your machine, no cloud deployment needed
- **Python**: Built with slack-bolt, AgentMail SDK, FastAPI, SQLite

## Setup

*Coming soon*

## License

MIT
