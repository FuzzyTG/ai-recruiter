import { AgentMailClient } from 'agentmail';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboundMessage {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  receivedAt: string; // ISO 8601
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  cc?: string[];
  attachments?: Array<{
    filename: string;
    content: string;       // base64
    contentType: string;
  }>;
}

export interface ReplyOptions {
  messageId: string;
  text: string;
  cc?: string[];
  attachments?: Array<{
    filename: string;
    content: string;
    contentType: string;
  }>;
}

export interface ListMessagesOptions {
  limit?: number;
  after?: string;  // cursor for pagination
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EmailSendError extends Error {
  public readonly retryable: boolean;
  public readonly statusCode?: number;

  constructor(
    message: string,
    options: { retryable: boolean; statusCode?: number; cause?: Error },
  ) {
    super(message);
    this.name = 'EmailSendError';
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/**
 * Retry a function up to `maxRetries` times on transient (5xx / network) errors.
 * 4xx errors fail immediately.
 * Backoff: 1s, 2s (exponential).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // If it's an EmailSendError with retryable=false, fail immediately
      if (err instanceof EmailSendError && !err.retryable) {
        throw err;
      }

      // If we've exhausted retries, throw
      if (attempt >= maxRetries) {
        throw err;
      }

      // Exponential backoff: 1s, 2s
      const delayMs = 1000 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Should never reach here
  throw lastError;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class RecruiterMailClient {
  private readonly client: AgentMailClient;
  private inboxId: string | undefined;

  constructor(options: { apiKey: string; inboxId?: string }) {
    if (!options.apiKey) {
      throw new Error('apiKey is required');
    }
    this.client = new AgentMailClient({ apiKey: options.apiKey });
    this.inboxId = options.inboxId;
  }

  /**
   * Create a new inbox for a hiring-manager / role.
   * Uses clientId for idempotency: same hmNameSlug → same inbox.
   */
  async createInbox(
    displayName: string,
    hmNameSlug: string,
    username?: string,
  ): Promise<{ inboxId: string; email: string }> {
    const inbox = await withRetry(async () => {
      try {
        const result = await this.client.inboxes.create({
          username,
          displayName,
          clientId: `ai-recruiter-setup-${hmNameSlug}`,
        });
        return result;
      } catch (err: any) {
        throw this.wrapError(err);
      }
    });

    this.inboxId = inbox.inboxId;
    return { inboxId: inbox.inboxId, email: inbox.email };
  }

  /**
   * Update an existing inbox (e.g. change displayName).
   */
  async updateInbox(
    inboxId: string,
    update: { displayName: string },
  ): Promise<void> {
    await withRetry(async () => {
      try {
        await this.client.inboxes.update(inboxId, update);
      } catch (err: any) {
        throw this.wrapError(err);
      }
    });
  }

  /**
   * Send a new email (new thread).
   */
  async sendEmail(
    options: SendEmailOptions,
  ): Promise<{ messageId: string; threadId: string }> {
    this.ensureInbox();

    const result = await withRetry(async () => {
      try {
        const resp = await this.client.inboxes.messages.send(this.inboxId!, {
          to: options.to,
          subject: options.subject,
          text: options.text,
          cc: options.cc,
          attachments: options.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          })),
        });
        return resp;
      } catch (err: any) {
        throw this.wrapError(err);
      }
    });

    return {
      messageId: result.messageId,
      threadId: result.threadId,
    };
  }

  /**
   * Reply to an existing message in a thread.
   */
  async replyToMessage(
    options: ReplyOptions,
  ): Promise<{ messageId: string; threadId: string }> {
    this.ensureInbox();

    const result = await withRetry(async () => {
      try {
        const resp = await this.client.inboxes.messages.reply(
          this.inboxId!,
          options.messageId,
          {
            text: options.text,
            cc: options.cc,
            attachments: options.attachments?.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
            })),
          },
        );
        return resp;
      } catch (err: any) {
        throw this.wrapError(err);
      }
    });

    return {
      messageId: result.messageId,
      threadId: result.threadId,
    };
  }

  /**
   * List messages in the inbox.
   */
  async listMessages(
    options?: ListMessagesOptions,
  ): Promise<{ messages: InboundMessage[]; nextCursor?: string }> {
    this.ensureInbox();

    const result = await withRetry(async () => {
      try {
        const resp = await this.client.inboxes.messages.list(this.inboxId!, {
          limit: options?.limit ?? 20,
          pageToken: options?.after,
        });
        return resp;
      } catch (err: any) {
        throw this.wrapError(err);
      }
    });

    const items = result.messages ?? [];
    const messages: InboundMessage[] = items.map((msg: any) => ({
      messageId: msg.messageId,
      threadId: msg.threadId,
      from: msg.from ?? '',
      to: Array.isArray(msg.to) ? msg.to : [],
      cc: Array.isArray(msg.cc) ? msg.cc : [],
      subject: msg.subject ?? '',
      text: msg.text ?? msg.preview ?? '',
      receivedAt: msg.createdAt instanceof Date
        ? msg.createdAt.toISOString()
        : typeof msg.createdAt === 'string'
          ? msg.createdAt
          : new Date().toISOString(),
    }));

    return {
      messages,
      nextCursor: result.nextPageToken,
    };
  }

  /**
   * Create an ICS attachment object suitable for sendEmail/replyToMessage.
   */
  static makeIcsAttachment(icsContent: string): {
    filename: string;
    content: string;
    contentType: string;
  } {
    return {
      filename: 'invite.ics',
      content: Buffer.from(icsContent, 'utf-8').toString('base64'),
      contentType: 'text/calendar',
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private ensureInbox(): void {
    if (!this.inboxId) {
      throw new Error(
        'No inboxId set. Call createInbox() first or pass inboxId in constructor.',
      );
    }
  }

  private wrapError(err: any): EmailSendError {
    if (err instanceof EmailSendError) return err;

    const statusCode = err?.status ?? err?.statusCode ?? err?.response?.status;
    const is4xx = statusCode >= 400 && statusCode < 500;
    const is5xx = statusCode >= 500 && statusCode < 600;

    return new EmailSendError(err?.message ?? String(err), {
      retryable: !is4xx && (is5xx || !statusCode), // network errors are retryable
      statusCode,
      cause: err instanceof Error ? err : undefined,
    });
  }
}
