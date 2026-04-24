---
name: recruit-schedule
description: Schedule an interview — propose time slots, confirm, resend, or cancel/reschedule
---

## Rules

- All file I/O and email sending goes through MCP tools. Never write files or send emails directly.
- **LLM composes body text only.** Do NOT include sign-offs (e.g., "Best regards,"), names, signatures, separators ("---"), or AI disclaimers in email drafts. The server appends the signature automatically via `appendSignature()`.
- **Plain text only in `email_body`.** Do not use Markdown formatting — no `**`, `_`, `#`, `[]()`, or bullet lists with `- `. The email is sent as `text/plain`; Markdown symbols render as literal characters in the recipient's inbox.
- **NEVER write date-weekday combinations in email drafts before calling MCP.** The server finds free slots from the calendar. Only after receiving slot ISO strings from MCP should you format dates with weekday names.
- Derive weekday names from ISO date strings programmatically. Do not guess or calculate weekdays yourself.
- The server validates date-weekday correctness in email bodies. Mismatches cause rejection.
- Email send requires HM approval. Show the complete email draft before calling MCP.
- Match email language to `config.language`. Match output language to `config.language`.

## Dependency Guard

**[MCP]** Call `recruit_status({ query_type: "candidate", role: "<role>", candidate_id: "<id>" })`.

- If `setup_required` → "Run `/recruit-setup` first."
- If `candidate_not_found` → "Candidate not found. Check ID or run `/recruit-status` to see available candidates."
- If candidate state is `screened_pass` → proceed with `propose`.
- If candidate state is `scheduling` → proceed with `confirm` or `resend`.
- If candidate state is `scheduling` and HM wants to cancel → proceed with `cancel`.
- If candidate state is `interview_confirmed` and HM wants to cancel or reschedule → proceed with `cancel`.
- If candidate state is anything else → explain which states allow scheduling.
- If MCP returns `calendar_error` during slot finding, it likely means no calendar URL was configured. Tell HM: "Calendar URL is not configured. Run `/recruit-setup` to add it before scheduling."

## Protocol

### Action: Propose (first-time scheduling)

#### Step 1: Collect Parameters

**[LLM]** Confirm with HM:
- Which candidate (by name or ID)
- Interview duration (default: 60 minutes)
- Number of slots to offer (default: 3)

#### Step 2: Get Available Slots (Preview)

**[MCP]** Call `recruit_schedule` with `approved: false` to preview available slots without sending email:
```
{
  role, candidate_id,
  action: "propose",
  duration_minutes, num_slots,
  email_subject: "[draft]",
  email_body: "[draft]",
  approved: false
}
```

The response will contain `slots` with ISO start/end times. No email is sent, no state changes.

#### Step 3: Draft Email with Actual Dates

**[LLM]** Format each returned slot as:
- Date in locale format
- Weekday name (derived from the ISO date)
- Time range in config.timezone

Draft the full scheduling email in `config.language`:
- Greeting with candidate name
- Purpose (interview for the role)
- Formatted slot options (numbered list)
- Meeting link from config
- Instruction to pick a preferred slot and reply

#### Step 4: Approval Gate

**[LLM]** Show HM the complete email (subject + body with actual dates). Ask:

> "Send this scheduling email to [candidate name] at [email]? (CC: [config.cc_email])"

#### Step 5: Send

**[MCP]** Call `recruit_schedule` with the final email and `approved: true`:
```
{
  role, candidate_id,
  action: "propose",
  duration_minutes, num_slots,
  email_subject, email_body,
  approved: true
}
```

#### Step 6: Display Result

```
Interview Scheduling Sent
━━━━━━━━━━━━━━━━━━━━━━━━━
Candidate:  Alice Chen
Slots:      3 proposed
  1. Wed Apr 16, 10:00-11:00 CST
  2. Thu Apr 17, 14:00-15:00 CST
  3. Fri Apr 18, 09:00-10:00 CST
Email:      ✓ sent (CC: alex@acme.com)
State:      scheduling

Waiting for candidate to pick a slot.
```

### Action: Confirm (candidate replied with preference)

#### Step 1: Identify Slot

**[LLM]** HM tells you which slot the candidate picked. Match to one of the offered slots by date/time.

Construct `confirmed_slot: { start: "<ISO>", end: "<ISO>" }`.

#### Step 2: Draft Confirmation Email

**[LLM]** Draft a confirmation email in `config.language`:
- Confirm date, time, and duration
- Include meeting link
- Attach ICS (MCP handles this automatically)

#### Step 3: Approval Gate

Show HM the confirmation email. Ask: "Send this confirmation?"

#### Step 4: Send

**[MCP]** Call `recruit_schedule`:
```
{
  role, candidate_id,
  action: "confirm",
  confirmed_slot: { start, end },
  email_body, email_subject,
  approved: true
}
```

**[LLM]** Display: confirmed slot, email sent, state → `interview_confirmed`.

### Action: Resend (candidate didn't respond)

Follow the same flow as `propose` but with `action: "resend"`. Candidate must be in `scheduling` state.

## Anti-patterns

| Pattern | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Writing "Monday April 15" without verification | Server scans email for date-weekday mismatches, rejects on error | Derive weekday from ISO string after MCP returns slots |
| Guessing available dates | Only the calendar feed knows real availability | Let MCP find free slots from iCal feed |
| Sending email without HM seeing it | Unapproved candidate contact | Always show full email draft, get explicit "yes" |
| Proposing for candidate not in screened_pass | Invalid state transition | Check candidate state via recruit_status first |
| Writing files directly (ICS, conversation logs) | Bypasses audit trail | MCP tool handles ICS generation, message logging |
| Skipping CC to HM | Loses human oversight trail | CC is automatic via MCP tool — don't override |

### Action: Cancel (cancel or reschedule an interview)

#### Step 1: Determine Intent

**[LLM]** Understand what HM wants:
- **Cancel** → withdraw candidate from process entirely (`target_state: "withdrawn"`)
- **Pause** → return candidate to pool, may schedule later (`target_state: "screened_pass"`)
- **Reschedule** → cancel current slot, propose new times (`target_state: "scheduling"`)

Ask HM to clarify if ambiguous. `target_state` is required — do not assume.

#### Step 2: Draft Cancel Email

**[LLM]** Draft a cancellation email in `config.language`:
- Apologize for the change
- If rescheduling: mention new times will follow
- If cancelling: thank candidate for their time
- Keep it professional and brief

#### Step 3: Approval Gate

**[LLM]** Show HM the email and the intended outcome:

> "Cancel [candidate name]'s interview? This will:
> - Send cancellation email (with ICS cancel if interview was confirmed)
> - Move candidate to [target_state]
>
> Proceed?"

#### Step 4: Send

**[MCP]** Call `recruit_schedule`:
```
{
  role, candidate_id,
  action: "cancel",
  target_state: "scheduling" | "screened_pass" | "withdrawn",
  email_body, email_subject,
  approved: true
}
```

The server handles: ICS CANCEL attachment (if interview was confirmed), reply-in-thread, signature, slot release, state transition.

#### Step 5: Display Result

```
Interview Cancelled
━━━━━━━━━━━━━━━━━━
Candidate:  Alice Chen
Action:     reschedule
ICS cancel: ✓ sent
Email:      ✓ sent (CC: alex@acme.com)
State:      scheduling

[If reschedule] Run `/recruit-schedule` to propose new times.
```

#### Step 6: Follow-up (reschedule only)

If `target_state` was `scheduling`, prompt HM: "Want to propose new time slots now?"
If yes, proceed with the Propose flow above.
