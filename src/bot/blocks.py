"""Block Kit message builders for candidate review workflows."""

from __future__ import annotations


def candidate_review_blocks(
    candidate_name: str,
    role: str,
    score: float | int,
) -> list[dict]:
    """Build Block Kit blocks for a candidate review card.

    Returns a list of blocks containing:
    - A section with candidate info (name, role, score)
    - An actions block with Approve and Reject buttons

    Args:
        candidate_name: The candidate's display name.
        role: The role/position the candidate applied for.
        score: The candidate's evaluation score.

    Returns:
        A list of Slack Block Kit block dicts.
    """
    return [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*Candidate Review*\n\n"
                    f"*Name:* {candidate_name}\n"
                    f"*Role:* {role}\n"
                    f"*Score:* {score}"
                ),
            },
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Approve"},
                    "style": "primary",
                    "action_id": "approve_candidate",
                    "value": candidate_name,
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Reject"},
                    "style": "danger",
                    "action_id": "reject_candidate",
                    "value": candidate_name,
                },
            ],
        },
    ]
