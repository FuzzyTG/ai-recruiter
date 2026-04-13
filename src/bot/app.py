"""Slack Bolt App setup.

Creates a configured Slack Bolt ``App`` instance using the bot token
loaded from environment variables via python-dotenv.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from slack_bolt import App

load_dotenv()

_token = os.environ.get("SLACK_BOT_TOKEN")
if not _token:
    raise RuntimeError(
        "SLACK_BOT_TOKEN is not set. "
        "Please export it or add it to your .env file."
    )

app = App(token=_token)
