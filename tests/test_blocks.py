"""Tests for src.bot.blocks."""

from __future__ import annotations

from src.bot.blocks import candidate_review_blocks


class TestCandidateReviewBlocks:
    """Tests for the candidate_review_blocks builder."""

    def test_returns_list_of_blocks(self) -> None:
        blocks = candidate_review_blocks("Ada Lovelace", "Engineer", 92)
        assert isinstance(blocks, list)
        assert len(blocks) == 2

    def test_first_block_is_section_with_candidate_info(self) -> None:
        blocks = candidate_review_blocks("Grace Hopper", "Backend Engineer", 88)
        section = blocks[0]
        assert section["type"] == "section"
        text = section["text"]["text"]
        assert "Grace Hopper" in text
        assert "Backend Engineer" in text
        assert "88" in text

    def test_section_text_is_mrkdwn(self) -> None:
        blocks = candidate_review_blocks("Test User", "SWE", 75)
        assert blocks[0]["text"]["type"] == "mrkdwn"

    def test_second_block_is_actions(self) -> None:
        blocks = candidate_review_blocks("Ada Lovelace", "Engineer", 92)
        actions = blocks[1]
        assert actions["type"] == "actions"
        assert "elements" in actions

    def test_approve_button_present_with_correct_action_id(self) -> None:
        blocks = candidate_review_blocks("Ada", "Eng", 90)
        elements = blocks[1]["elements"]
        approve_buttons = [e for e in elements if e["action_id"] == "approve_candidate"]
        assert len(approve_buttons) == 1
        btn = approve_buttons[0]
        assert btn["type"] == "button"
        assert btn["text"]["text"] == "Approve"

    def test_reject_button_present_with_correct_action_id(self) -> None:
        blocks = candidate_review_blocks("Ada", "Eng", 90)
        elements = blocks[1]["elements"]
        reject_buttons = [e for e in elements if e["action_id"] == "reject_candidate"]
        assert len(reject_buttons) == 1
        btn = reject_buttons[0]
        assert btn["type"] == "button"
        assert btn["text"]["text"] == "Reject"

    def test_approve_button_has_primary_style(self) -> None:
        blocks = candidate_review_blocks("X", "Y", 1)
        approve = [e for e in blocks[1]["elements"] if e["action_id"] == "approve_candidate"][0]
        assert approve.get("style") == "primary"

    def test_reject_button_has_danger_style(self) -> None:
        blocks = candidate_review_blocks("X", "Y", 1)
        reject = [e for e in blocks[1]["elements"] if e["action_id"] == "reject_candidate"][0]
        assert reject.get("style") == "danger"

    def test_button_values_carry_candidate_name(self) -> None:
        blocks = candidate_review_blocks("Jane Doe", "PM", 85)
        for elem in blocks[1]["elements"]:
            assert elem["value"] == "Jane Doe"

    def test_score_can_be_float(self) -> None:
        blocks = candidate_review_blocks("Float Test", "QA", 87.5)
        text = blocks[0]["text"]["text"]
        assert "87.5" in text

    def test_score_can_be_zero(self) -> None:
        blocks = candidate_review_blocks("Zero", "Role", 0)
        text = blocks[0]["text"]["text"]
        assert "0" in text
