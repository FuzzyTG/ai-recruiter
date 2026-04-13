"""Tests for src.bot.handlers.

These tests mock the Slack client and verify handler behavior without
hitting the Slack API.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.bot.handlers import (
    handle_approve_action,
    handle_file_shared,
    handle_message,
    handle_reject_action,
)


# ---------------------------------------------------------------------------
# handle_message
# ---------------------------------------------------------------------------

class TestHandleMessage:
    def test_calls_say_with_user_mention(self) -> None:
        event = {"user": "U12345", "text": "Hello bot"}
        say = MagicMock()
        handle_message(event, say)
        say.assert_called_once()
        msg = say.call_args[0][0]
        assert "<@U12345>" in msg

    def test_handles_missing_user_gracefully(self) -> None:
        event = {"text": "no user field"}
        say = MagicMock()
        handle_message(event, say)
        say.assert_called_once()

    def test_handles_missing_text_gracefully(self) -> None:
        event = {"user": "U99"}
        say = MagicMock()
        handle_message(event, say)
        say.assert_called_once()


# ---------------------------------------------------------------------------
# handle_file_shared
# ---------------------------------------------------------------------------

class TestHandleFileShared:
    def test_skips_non_pdf(self) -> None:
        event = {"file_id": "F001"}
        client = MagicMock()
        client.files_info.return_value = {
            "file": {
                "name": "image.png",
                "mimetype": "image/png",
            }
        }
        with patch("src.bot.handlers.requests") as mock_requests:
            handle_file_shared(event, client)
            mock_requests.get.assert_not_called()

    def test_downloads_pdf_to_resume_dir(self, tmp_path: Path) -> None:
        event = {"file_id": "F002"}
        client = MagicMock()
        client.files_info.return_value = {
            "file": {
                "name": "resume.pdf",
                "mimetype": "application/pdf",
                "url_private_download": "https://files.slack.com/resume.pdf",
            }
        }
        fake_content = b"%PDF-1.4 fake content"

        with (
            patch("src.bot.handlers.requests") as mock_requests,
            patch("src.bot.handlers.RESUME_DIR", tmp_path / "resumes"),
            patch.dict(os.environ, {"SLACK_BOT_TOKEN": "xoxb-test-token"}),
        ):
            mock_resp = MagicMock()
            mock_resp.content = fake_content
            mock_requests.get.return_value = mock_resp

            handle_file_shared(event, client)

            # Verify requests.get was called with auth header.
            mock_requests.get.assert_called_once()
            call_kwargs = mock_requests.get.call_args
            assert call_kwargs[1]["headers"]["Authorization"] == "Bearer xoxb-test-token"

            # Verify file was written with file_id to avoid collisions.
            dest = tmp_path / "resumes" / "resume_F002.pdf"
            assert dest.exists()
            assert dest.read_bytes() == fake_content

    def test_ignores_event_without_file_id(self) -> None:
        event = {}
        client = MagicMock()
        handle_file_shared(event, client)
        client.files_info.assert_not_called()

    def test_uses_url_private_fallback(self, tmp_path: Path) -> None:
        """When url_private_download is missing, falls back to url_private."""
        event = {"file_id": "F003"}
        client = MagicMock()
        client.files_info.return_value = {
            "file": {
                "name": "cv.pdf",
                "mimetype": "application/pdf",
                "url_private": "https://files.slack.com/cv.pdf",
            }
        }
        with (
            patch("src.bot.handlers.requests") as mock_requests,
            patch("src.bot.handlers.RESUME_DIR", tmp_path / "resumes"),
            patch.dict(os.environ, {"SLACK_BOT_TOKEN": "xoxb-test"}),
        ):
            mock_resp = MagicMock()
            mock_resp.content = b"pdf bytes"
            mock_requests.get.return_value = mock_resp

            handle_file_shared(event, client)

            mock_requests.get.assert_called_once()
            url_used = mock_requests.get.call_args[0][0]
            assert url_used == "https://files.slack.com/cv.pdf"

    def test_sanitizes_path_traversal_filename(self, tmp_path: Path) -> None:
        """A filename like ../../evil.pdf must be sanitized to evil.pdf."""
        event = {"file_id": "F004"}
        client = MagicMock()
        client.files_info.return_value = {
            "file": {
                "name": "../../evil.pdf",
                "mimetype": "application/pdf",
                "url_private_download": "https://files.slack.com/evil.pdf",
            }
        }
        with (
            patch("src.bot.handlers.requests") as mock_requests,
            patch("src.bot.handlers.RESUME_DIR", tmp_path / "resumes"),
            patch.dict(os.environ, {"SLACK_BOT_TOKEN": "xoxb-test"}),
        ):
            mock_resp = MagicMock()
            mock_resp.content = b"%PDF-evil"
            mock_requests.get.return_value = mock_resp

            handle_file_shared(event, client)

            # Must land inside resumes dir, not escape via ../
            saved = tmp_path / "resumes" / "evil_F004.pdf"
            assert saved.exists()
            # Must NOT exist outside the directory
            escaped = tmp_path / "evil.pdf"
            assert not escaped.exists()

    def test_returns_early_when_token_missing(self) -> None:
        """If SLACK_BOT_TOKEN is unset, handler logs error and returns."""
        event = {"file_id": "F005"}
        client = MagicMock()
        client.files_info.return_value = {
            "file": {
                "name": "resume.pdf",
                "mimetype": "application/pdf",
                "url_private_download": "https://files.slack.com/resume.pdf",
            }
        }
        with (
            patch("src.bot.handlers.requests") as mock_requests,
            patch.dict(os.environ, {}, clear=True),
        ):
            handle_file_shared(event, client)
            mock_requests.get.assert_not_called()


# ---------------------------------------------------------------------------
# handle_approve_action / handle_reject_action
# ---------------------------------------------------------------------------

def _make_action_body(action_value: str = "Ada Lovelace") -> dict:
    """Build a minimal Slack action body for testing."""
    return {
        "channel": {"id": "C123"},
        "message": {"ts": "1234567890.123456"},
        "actions": [{"value": action_value}],
    }


class TestHandleApproveAction:
    def test_calls_ack(self) -> None:
        ack = MagicMock()
        client = MagicMock()
        handle_approve_action(ack, _make_action_body(), client)
        ack.assert_called_once()

    def test_updates_message_with_approved_status(self) -> None:
        ack = MagicMock()
        client = MagicMock()
        handle_approve_action(ack, _make_action_body("Grace Hopper"), client)
        client.chat_update.assert_called_once()
        call_kwargs = client.chat_update.call_args[1]
        assert call_kwargs["channel"] == "C123"
        assert call_kwargs["ts"] == "1234567890.123456"
        assert "approved" in call_kwargs["text"].lower()
        assert "Grace Hopper" in call_kwargs["text"]

    def test_updated_blocks_contain_approved_text(self) -> None:
        ack = MagicMock()
        client = MagicMock()
        handle_approve_action(ack, _make_action_body("Test"), client)
        call_kwargs = client.chat_update.call_args[1]
        block_text = call_kwargs["blocks"][0]["text"]["text"]
        assert "approved" in block_text.lower()


class TestHandleRejectAction:
    def test_calls_ack(self) -> None:
        ack = MagicMock()
        client = MagicMock()
        handle_reject_action(ack, _make_action_body(), client)
        ack.assert_called_once()

    def test_updates_message_with_rejected_status(self) -> None:
        ack = MagicMock()
        client = MagicMock()
        handle_reject_action(ack, _make_action_body("Alan Turing"), client)
        client.chat_update.assert_called_once()
        call_kwargs = client.chat_update.call_args[1]
        assert call_kwargs["channel"] == "C123"
        assert "rejected" in call_kwargs["text"].lower()
        assert "Alan Turing" in call_kwargs["text"]

    def test_updated_blocks_contain_rejected_text(self) -> None:
        ack = MagicMock()
        client = MagicMock()
        handle_reject_action(ack, _make_action_body("Test"), client)
        call_kwargs = client.chat_update.call_args[1]
        block_text = call_kwargs["blocks"][0]["text"]["text"]
        assert "rejected" in block_text.lower()
