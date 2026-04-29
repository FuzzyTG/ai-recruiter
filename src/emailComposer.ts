import { CandidateState, slugify } from './models.js';
import type { Candidate, Config, CoordinatorIdentity, TimeoutRule } from './models.js';

export function normalizeCoordinatorLocalPart(name: string): string {
  const normalized = slugify(name)
    .replace(/-/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '');
  return normalized || 'coordinator';
}

export function coordinatorIdentity(name: string): CoordinatorIdentity {
  const trimmedName = name.trim();
  const safeName = trimmedName || 'AI Assistant';
  return {
    name: safeName,
    display_name: `${safeName}, AI Recruiting Coordinator`,
    email_local_part: normalizeCoordinatorLocalPart(safeName),
  };
}

export function candidateFacingCc(config: Config): string[] {
  return [config.cc_email];
}

export function quoteDisplayName(displayName: string): string {
  const escapedName = displayName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escapedName}"`;
}

export function formatAddress(displayName: string, email: string): string {
  return `${quoteDisplayName(displayName)} <${email}>`;
}

export function candidateFacingFrom(config: Config): string {
  const displayName = config.communication?.coordinator.display_name ?? config.sender_name;
  const email = config.agentmail_inbox_email;
  if (email) return formatAddress(displayName, email);
  return config.communication?.coordinator ? quoteDisplayName(displayName) : config.cc_email;
}

/** Parse email address from RFC 5322 format ("Name <email>") or plain email. */
export function parseEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : raw.toLowerCase().trim();
}

/** Append the config's signature_template to an email body. */
export function appendSignature(body: string, config: Config): string {
  const sig = config.signature_template;
  if (!sig) return body;
  return `${body}\n\n${sig}`;
}

/**
 * Strip trailing sign-off patterns the LLM may have added.
 * Runs BEFORE appendSignature() so only the canonical signature remains.
 */
export function stripTrailingSignature(body: string): string {
  const lines = body.trimEnd().split('\n');

  // Walk backwards to find where the trailing signature block begins.
  // A signature block is: optional name line(s), then a sign-off/separator/AI-disclaimer.
  // We track two things: where a sign-off was found, and how far up name lines extend.
  let cutIndex = lines.length;
  let foundSignoff = false;
  let nameOnlyCount = 0; // consecutive name-like lines seen before any signoff

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') {
      // Blank lines within the signature block are OK, but if we only
      // found name lines so far (no signoff), a blank means we've left
      // the potential signature zone — reset.
      if (!foundSignoff && nameOnlyCount > 0) {
        cutIndex = lines.length;
        nameOnlyCount = 0;
      }
      continue;
    }

    // Sign-off patterns (e.g., "Best regards,", "Thanks,")
    if (/^(best\s+regards|kind\s+regards|warm\s+regards|regards|sincerely|thanks|thank\s+you|cheers|respectfully),?\s*$/i.test(line)) {
      cutIndex = i;
      foundSignoff = true;
      continue;
    }

    // Separator lines (e.g., "---", "———")
    if (/^[-─—_]{2,}\s*$/.test(line)) {
      cutIndex = i;
      foundSignoff = true;
      continue;
    }

    // AI disclaimer (e.g., "Drafted with AI")
    if (/drafted\s+(with|by)\s+ai/i.test(line) || /ai\s+assist/i.test(line)) {
      cutIndex = i;
      foundSignoff = true;
      continue;
    }

    // Name-like line (e.g., "John Smith", "Recruiting Team")
    if (/^[\w\s.]{1,40}$/.test(line) && line.split(/\s+/).length <= 4) {
      if (foundSignoff) {
        // We already confirmed a sign-off; stop here — don't consume body lines
        break;
      }
      // Tentatively include as part of a potential signature (below sign-off)
      if (nameOnlyCount < 2) {
        cutIndex = i;
        nameOnlyCount++;
        continue;
      }
    }

    // Non-matching line: if we haven't found a signoff, the tentative
    // name cuts were just body text — reset and stop.
    if (!foundSignoff) {
      cutIndex = lines.length;
    }
    break;
  }

  if (cutIndex < lines.length && foundSignoff) {
    return lines.slice(0, cutIndex).join('\n').trimEnd();
  }
  return body.trimEnd();
}

export function generateFollowupBody(
  candidate: Candidate,
  _rule: TimeoutRule,
  _config: Config,
): string {
  const name = candidate.name;

  if (candidate.state === CandidateState.Scheduling) {
    const slotLines = candidate.offered_slots
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .map((s) => {
        const start = new Date(s.start);
        const dateStr = start.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        });
        const timeStr = start.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        });
        return `  - ${dateStr} at ${timeStr}`;
      })
      .join('\n');

    return `Hi ${name},\n\nI wanted to follow up on the interview scheduling email I sent earlier. Here are the available time slots:\n\n${slotLines}\n\nPlease let me know which time works best for you, or if you need different options.`;
  }

  return `Hi ${name},\n\nI wanted to follow up on the status of your application. Please let me know if you have any updates.\n\nThank you.`;
}
