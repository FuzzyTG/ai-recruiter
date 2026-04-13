"""Entry point for the AI Recruiter Slack bot.

Registers all handlers and starts the Socket Mode connection.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

from src.bot.app import app  # noqa: E402
from src.bot.handlers import (  # noqa: E402
    handle_approve_action,
    handle_file_shared,
    handle_message,
    handle_reject_action,
)

# Register event handlers.
app.event("message")(handle_message)
app.event("file_shared")(handle_file_shared)

# Register action handlers (button clicks).
app.action("approve_candidate")(handle_approve_action)
app.action("reject_candidate")(handle_reject_action)


def main() -> None:
    """Start the bot using Socket Mode."""
    from slack_bolt.adapter.socket_mode import SocketModeHandler

    app_token = os.environ.get("SLACK_APP_TOKEN")
    if not app_token:
        raise RuntimeError("SLACK_APP_TOKEN environment variable is not set")

    handler = SocketModeHandler(app, app_token)
    handler.start()


if __name__ == "__main__":
    main()
