import { describe, it, expect, vi } from 'vitest';
import {
  RecruiterMailClient,
  EmailSendError,
  withRetry,
} from '../src/emailClient.js';

// ---------------------------------------------------------------------------
// makeIcsAttachment
// ---------------------------------------------------------------------------

describe('RecruiterMailClient.makeIcsAttachment', () => {
  it('should produce base64 content, correct content type, and filename', () => {
    const icsContent = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
    const attachment = RecruiterMailClient.makeIcsAttachment(icsContent);

    expect(attachment.filename).toBe('invite.ics');
    expect(attachment.contentType).toBe('text/calendar');

    // Verify base64 round-trip
    const decoded = Buffer.from(attachment.content, 'base64').toString('utf-8');
    expect(decoded).toBe(icsContent);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  it('should succeed on first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on transient failure then succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new EmailSendError('Server error', { retryable: true, statusCode: 500 }),
      )
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, 2);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should fail immediately on 4xx (retryable=false)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        new EmailSendError('Bad request', { retryable: false, statusCode: 400 }),
      );

    await expect(withRetry(fn, 2)).rejects.toThrow('Bad request');
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  it('should exhaust retries on repeated 500 errors (retryable=true)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        new EmailSendError('Internal error', { retryable: true, statusCode: 500 }),
      );

    await expect(withRetry(fn, 2)).rejects.toThrow('Internal error');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('RecruiterMailClient constructor', () => {
  it('should throw when apiKey is missing', () => {
    expect(() => new RecruiterMailClient({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('should not throw with a valid apiKey', () => {
    expect(() => new RecruiterMailClient({ apiKey: 'test-key' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration tests (skipped without AGENTMAIL_API_KEY)
// ---------------------------------------------------------------------------

const describeIntegration = process.env.AGENTMAIL_API_KEY
  ? describe
  : describe.skip;

describeIntegration('RecruiterMailClient integration', () => {
  function makeClient() {
    return new RecruiterMailClient({
      apiKey: process.env.AGENTMAIL_API_KEY!,
    });
  }

  it('should create an inbox', async () => {
    const client = makeClient();
    const result = await client.createInbox('Test Recruiter', `test-${Date.now()}`);
    expect(result.inboxId).toBeDefined();
    expect(result.email).toContain('@');
  });

  it('should send an email', async () => {
    const client = makeClient();
    // Ensure inbox exists
    await client.createInbox('Test Recruiter', `test-send-${Date.now()}`);
    const result = await client.sendEmail({
      to: 'test@example.com',
      subject: 'Test email',
      body: 'Hello from integration test',
    });
    expect(result.messageId).toBeDefined();
    expect(result.threadId).toBeDefined();
  });
});
