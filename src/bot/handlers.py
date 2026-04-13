"""Slack event and action handlers for the recruiter bot."""

from __future__ import annotations

import logging
import os
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

RESUME_DIR = Path("data/resumes")


def handle_message(event: dict, say) -> None:
    """Handle incoming message events in channels and DMs.

    Sends a simple acknowledgment so the user knows the bot is listening.
    """
    user = event.get("user", "there")
    text = event.get("text", "")
    logger.info("Received message from user %s: %s", user, text[:80])
    say(f"Got it, <@{user}>! I'm processing your message.")


def handle_file_shared(event: dict, client) -> None:
    """Handle file_shared events.

    If the shared file is a PDF, download it to ``data/resumes/``.
    """
    file_id = event.get("file_id")
    if not file_id:
        logger.warning("file_shared event without file_id: %s", event)
        return

    # Fetch file metadata.
    result = client.files_info(file=file_id)
    file_info = result.get("file", {})
    name = file_info.get("name", "unknown")
    mimetype = file_info.get("mimetype", "")

    if mimetype != "application/pdf":
        logger.info("Skipping non-PDF file %s (mimetype=%s)", name, mimetype)
        return

    url = file_info.get("url_private_download") or file_info.get("url_private")
    if not url:
        logger.error("No download URL for file %s", file_id)
        return

    # Ensure the target directory exists.
    RESUME_DIR.mkdir(parents=True, exist_ok=True)

    # Download the file using the bot token for auth.
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        logger.error("SLACK_BOT_TOKEN not set; cannot download file %s", file_id)
        return

    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()

    # Sanitize filename to prevent path traversal (e.g. "../../evil.pdf").
    safe_name = Path(name).name
    if not safe_name:
        safe_name = f"{file_id}.pdf"

    # Include file_id to prevent filename collisions on repeated uploads.
    stem = Path(safe_name).stem
    suffix = Path(safe_name).suffix
    dest = RESUME_DIR / f"{stem}_{file_id}{suffix}"
    dest.write_bytes(resp.content)
    logger.info("Downloaded resume %s to %s (%d bytes)", name, dest, len(resp.content))


def handle_approve_action(ack, body: dict, client) -> None:
    """Handle the approve_candidate button click."""
    ack()

    channel = body["channel"]["id"]
    ts = body["message"]["ts"]
    candidate_name = body["actions"][0].get("value", "Unknown")

    client.chat_update(
        channel=channel,
        ts=ts,
        text=f"Candidate *{candidate_name}* has been *approved*.",
        blocks=[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f":white_check_mark: Candidate *{candidate_name}* has been *approved*.",
                },
            }
        ],
    )


def handle_reject_action(ack, body: dict, client) -> None:
    """Handle the reject_candidate button click."""
    ack()

    channel = body["channel"]["id"]
    ts = body["message"]["ts"]
    candidate_name = body["actions"][0].get("value", "Unknown")

    client.chat_update(
        channel=channel,
        ts=ts,
        text=f"Candidate *{candidate_name}* has been *rejected*.",
        blocks=[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f":x: Candidate *{candidate_name}* has been *rejected*.",
                },
            }
        ],
    )
