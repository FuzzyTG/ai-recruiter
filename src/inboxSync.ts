import { isTerminalState } from './models.js';
import type { ConversationMessage } from './models.js';
import type { RecruiterStore } from './store.js';
import type { RecruiterMailClient, InboundMessage } from './emailClient.js';
import { parseEmailAddress } from './emailComposer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CandidateMatch = {
  role: string;
  candidate_id: string;
  conversation_id: string;
  name: string;
};

export type InboxSyncResult = {
  synced: number;
  unmatched: number;
  new_messages: Array<{
    candidate_id: string;
    name: string;
    subject: string;
    preview: string;
    from: string;
    received_at: string;
  }>;
  unmatched_messages: Array<{
    from: string;
    subject: string;
    received_at: string;
  }>;
  warning?: string;
};

export type InboxSyncOptions = {
  terminalThreadIds?: Set<string>;
  fallbackEmailCounts?: Map<string, number>;
  includeUnmatched?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function activeCandidateMatches(
  store: RecruiterStore,
  roles: string[],
  candidateId?: string,
): CandidateMatch[] {
  const matches: CandidateMatch[] = [];

  for (const role of roles) {
    const candidates = candidateId
      ? [store.readCandidate(role, candidateId)]
      : store.listCandidates(role);

    for (const c of candidates) {
      if (isTerminalState(c.state)) continue;
      matches.push({
        role: c.role,
        candidate_id: c.candidate_id,
        conversation_id: c.conversation_id,
        name: c.name,
      });
    }
  }

  return matches;
}

export function terminalThreadIds(store: RecruiterStore, roles: string[]): Set<string> {
  const threadIds = new Set<string>();

  for (const role of roles) {
    for (const c of store.listCandidates(role)) {
      if (!isTerminalState(c.state)) continue;
      for (const msg of store.readConversation(c.conversation_id)) {
        if (msg.agentmail_thread_id) {
          threadIds.add(msg.agentmail_thread_id);
        }
      }
    }
  }

  return threadIds;
}

export function candidateEmailCounts(store: RecruiterStore, roles: string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const role of roles) {
    for (const c of store.listCandidates(role)) {
      const email = c.channels.email.toLowerCase();
      counts.set(email, (counts.get(email) ?? 0) + 1);
    }
  }

  return counts;
}

export function emptyInboxSyncResult(): InboxSyncResult {
  return {
    synced: 0,
    unmatched: 0,
    new_messages: [],
    unmatched_messages: [],
  };
}

export async function syncInboxForMatches(
  store: RecruiterStore,
  emailClient: RecruiterMailClient | undefined,
  matches: CandidateMatch[],
  options: InboxSyncOptions = {},
): Promise<InboxSyncResult> {
  if (!emailClient) {
    return {
      synced: 0,
      unmatched: 0,
      new_messages: [],
      unmatched_messages: [],
      warning: 'Email client not configured. Inbox sync skipped.',
    };
  }

  if (matches.length === 0) {
    return emptyInboxSyncResult();
  }

  const threadMap = new Map<string, CandidateMatch>();
  const candidateMap = new Map<string, CandidateMatch[]>();
  const knownMessageIds = new Set<string>();

  for (const entry of matches) {
    const candidate = store.readCandidate(entry.role, entry.candidate_id);
    const email = candidate.channels.email.toLowerCase();
    const existing = candidateMap.get(email) ?? [];
    existing.push(entry);
    candidateMap.set(email, existing);

    const messages = store.readConversation(entry.conversation_id);
    for (const msg of messages) {
      knownMessageIds.add(msg.message_id);
      if (msg.agentmail_thread_id) {
        threadMap.set(msg.agentmail_thread_id, entry);
      }
    }
  }

  const allInbound: InboundMessage[] = [];
  let cursor: string | undefined;
  const MAX_PAGES = 4;
  const PAGE_SIZE = 50;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await emailClient.listMessages({
      limit: PAGE_SIZE,
      after: cursor,
    });
    allInbound.push(...result.messages);
    cursor = result.nextCursor;
    if (!cursor) break;
  }

  const newMessages: InboxSyncResult['new_messages'] = [];
  const unmatchedMessages: InboxSyncResult['unmatched_messages'] = [];

  for (const msg of allInbound) {
    if (knownMessageIds.has(msg.messageId)) continue;
    if (msg.threadId && options.terminalThreadIds?.has(msg.threadId)) continue;

    let match: CandidateMatch | null = null;
    if (msg.threadId) {
      match = threadMap.get(msg.threadId) ?? null;
    } else {
      const email = parseEmailAddress(msg.from);
      const candidates = candidateMap.get(email) ?? [];
      const emailCount = options.fallbackEmailCounts?.get(email) ?? candidates.length;
      match = candidates.length === 1 && emailCount === 1 ? candidates[0] : null;
    }

    if (match) {
      const convMsg: ConversationMessage = {
        schema_version: 1,
        message_id: msg.messageId,
        direction: 'inbound',
        from: msg.from,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        body: msg.text,
        timestamp: msg.receivedAt,
        agentmail_thread_id: msg.threadId,
      };
      store.appendMessage(match.conversation_id, convMsg);
      knownMessageIds.add(msg.messageId);

      newMessages.push({
        candidate_id: match.candidate_id,
        name: match.name,
        subject: msg.subject,
        preview: msg.text.slice(0, 200),
        from: msg.from,
        received_at: msg.receivedAt,
      });
    } else if (options.includeUnmatched) {
      unmatchedMessages.push({
        from: msg.from,
        subject: msg.subject,
        received_at: msg.receivedAt,
      });
    }
  }

  return {
    synced: newMessages.length,
    unmatched: unmatchedMessages.length,
    new_messages: newMessages,
    unmatched_messages: unmatchedMessages,
  };
}

export async function trySyncInboxForMatches(
  store: RecruiterStore,
  emailClient: RecruiterMailClient | undefined,
  matches: CandidateMatch[],
  options?: InboxSyncOptions,
): Promise<InboxSyncResult> {
  try {
    return await syncInboxForMatches(store, emailClient, matches, options);
  } catch (e) {
    return {
      synced: 0,
      unmatched: 0,
      new_messages: [],
      unmatched_messages: [],
      warning: e instanceof Error ? e.message : String(e),
    };
  }
}
