import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  type Config,
  type Framework,
  type Candidate,
  type AuditEntry,
  type ConversationMessage,
  type OfferedSlot,
  type TimeoutRule,
  CandidateState,
  isValidTransition,
  isApprovalRequired,
  getTimeoutRules,
  slugify,
} from './models.js';

// ── Error Types ──────────────────────────────────────────────────────────────

export class SetupRequiredError extends Error {
  constructor() {
    super('Setup required: run setup first');
    this.name = 'SetupRequiredError';
  }
}

export class RoleNotFoundError extends Error {
  constructor(role: string) {
    super(`Role not found: ${role}`);
    this.name = 'RoleNotFoundError';
  }
}

export class CandidateNotFoundError extends Error {
  constructor(id: string) {
    super(`Candidate not found: ${id}`);
    this.name = 'CandidateNotFoundError';
  }
}

export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class ApprovalRequiredError extends Error {
  constructor(from: string, to: string) {
    super(`Approval required for: ${from} → ${to}`);
    this.name = 'ApprovalRequiredError';
  }
}

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ValidationError';
  }
}

// ── Role Resolution Types ────────────────────────────────────────────────────

export type RoleResolution =
  | { status: 'exact'; canonical: string; display: string }
  | { status: 'normalized'; canonical: string; display: string; input: string }
  | { status: 'ambiguous'; input: string; candidates: Array<{ canonical: string; display: string }> }
  | { status: 'not_found'; input: string; available: Array<{ canonical: string; display: string }> };

export interface MigrationResult {
  renamed: Array<{ from: string; to: string; display: string }>;
  skipped_collisions: Array<{ source: string; target: string; reason: string }>;
  display_backfills: Array<{ canonical: string; display: string }>;
}

// ── RecruiterStore ───────────────────────────────────────────────────────────

export class RecruiterStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.recruiter');
  }

  // ── Core Primitive: Atomic Write ─────────────────────────────────────────

  private _safeWrite(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);
    const tmp = path.join(dir, `.${basename}.tmp`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  // ── Audit Logging ────────────────────────────────────────────────────────

  private _appendAudit(entry: AuditEntry): void {
    const auditPath = path.join(this.baseDir, 'audit.jsonl');
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  // ── Credentials Operations ────────────────────────────────────────────────

  private get credentialsPath(): string {
    return path.join(this.baseDir, '.credentials');
  }

  readCredentials(): Record<string, string> {
    if (!fs.existsSync(this.credentialsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.credentialsPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  writeCredential(key: string, value: string): void {
    const creds = this.readCredentials();
    creds[key] = value;
    this._safeWrite(this.credentialsPath, creds);
    fs.chmodSync(this.credentialsPath, 0o600);
  }

  // ── Config Operations ────────────────────────────────────────────────────

  configExists(): boolean {
    return fs.existsSync(path.join(this.baseDir, 'config.json'));
  }

  readConfig(): Config {
    const configPath = path.join(this.baseDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      throw new SetupRequiredError();
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Config;
  }

  writeConfig(config: Config): void {
    const configPath = path.join(this.baseDir, 'config.json');
    this._safeWrite(configPath, config);
    this._appendAudit({
      timestamp: new Date().toISOString(),
      tool: 'store',
      action: 'write_config',
      details: { path: configPath },
      actor: 'system',
    });
  }

  // ── Framework Operations ─────────────────────────────────────────────────

  readFramework(role: string): Framework {
    const fwPath = path.join(this.baseDir, 'roles', role, 'framework.json');
    if (!fs.existsSync(fwPath)) {
      throw new RoleNotFoundError(role);
    }
    const parsed = JSON.parse(fs.readFileSync(fwPath, 'utf-8')) as Framework;
    if (!parsed.role_display) {
      parsed.role_display = parsed.role ?? role;
    }
    return parsed;
  }

  writeFramework(role: string, fw: Framework): void {
    const fwPath = path.join(this.baseDir, 'roles', role, 'framework.json');
    const toWrite: Framework = {
      ...fw,
      role_display: fw.role_display ?? fw.role ?? role,
    };
    this._safeWrite(fwPath, toWrite);
    this._appendAudit({
      timestamp: new Date().toISOString(),
      tool: 'store',
      action: 'write_framework',
      details: { role, path: fwPath },
      actor: 'system',
    });
  }

  listRoles(): string[] {
    const rolesDir = path.join(this.baseDir, 'roles');
    if (!fs.existsSync(rolesDir)) {
      return [];
    }
    return fs
      .readdirSync(rolesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  // ── Role Resolution ──────────────────────────────────────────────────────

  private _readDisplay(canonical: string): string {
    const fwPath = path.join(this.baseDir, 'roles', canonical, 'framework.json');
    if (!fs.existsSync(fwPath)) return canonical;
    try {
      const parsed = JSON.parse(fs.readFileSync(fwPath, 'utf-8')) as Framework;
      return parsed.role_display ?? parsed.role ?? canonical;
    } catch {
      return canonical;
    }
  }

  listRolesWithDisplay(): Array<{ canonical: string; display: string }> {
    return this.listRoles().map((canonical) => ({
      canonical,
      display: this._readDisplay(canonical),
    }));
  }

  resolveRole(input: string): RoleResolution {
    const folders = this.listRoles();

    // Exact match against existing folder name
    if (folders.includes(input)) {
      return { status: 'exact', canonical: input, display: this._readDisplay(input) };
    }

    const normalized = slugify(input);
    const matches = folders.filter((f) => slugify(f) === normalized);

    if (matches.length === 1) {
      const canonical = matches[0];
      return {
        status: 'normalized',
        canonical,
        display: this._readDisplay(canonical),
        input,
      };
    }

    if (matches.length >= 2) {
      return {
        status: 'ambiguous',
        input,
        candidates: matches.map((canonical) => ({
          canonical,
          display: this._readDisplay(canonical),
        })),
      };
    }

    return {
      status: 'not_found',
      input,
      available: folders.map((canonical) => ({
        canonical,
        display: this._readDisplay(canonical),
      })),
    };
  }

  canonicalizeForNewRole(
    input: string,
  ): { canonical: string; collision?: { existing_canonical: string; existing_display: string } } {
    const canonical = slugify(input);
    const folders = this.listRoles();
    // Check if any existing folder would collide
    const existing = folders.find((f) => f === canonical || slugify(f) === canonical);
    if (existing) {
      return {
        canonical,
        collision: {
          existing_canonical: existing,
          existing_display: this._readDisplay(existing),
        },
      };
    }
    return { canonical };
  }

  // ── Migration ────────────────────────────────────────────────────────────

  migrateRoleFolders(options: { dryRun?: boolean } = {}): MigrationResult {
    const dryRun = !!options.dryRun;
    const result: MigrationResult = {
      renamed: [],
      skipped_collisions: [],
      display_backfills: [],
    };

    const rolesDir = path.join(this.baseDir, 'roles');
    if (!fs.existsSync(rolesDir)) return result;

    const folders = fs
      .readdirSync(rolesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const folder of folders) {
      const canonical = slugify(folder);
      const sourcePath = path.join(rolesDir, folder);
      const targetPath = path.join(rolesDir, canonical);
      const fwPath = path.join(sourcePath, 'framework.json');

      if (folder === canonical) {
        // Already slug — only backfill role_display if missing
        if (!fs.existsSync(fwPath)) continue;
        let parsed: Framework;
        try {
          parsed = JSON.parse(fs.readFileSync(fwPath, 'utf-8')) as Framework;
        } catch (e) {
          result.skipped_collisions.push({
            source: folder,
            target: folder,
            reason: 'framework.json corrupt or unreadable',
          });
          continue;
        }
        if (!parsed.role_display) {
          if (dryRun) {
            result.display_backfills.push({ canonical, display: canonical });
          } else {
            parsed.role_display = canonical;
            parsed.role = canonical;
            this._safeWrite(fwPath, parsed);
            result.display_backfills.push({ canonical, display: canonical });
          }
        }
        continue;
      }

      // Non-slug folder: needs rename
      if (fs.existsSync(targetPath) && targetPath !== sourcePath) {
        result.skipped_collisions.push({
          source: folder,
          target: canonical,
          reason: 'target folder already exists; manual resolution required',
        });
        continue;
      }

      // Try to read framework to determine display name
      let parsed: Framework | null = null;
      if (fs.existsSync(fwPath)) {
        try {
          parsed = JSON.parse(fs.readFileSync(fwPath, 'utf-8')) as Framework;
        } catch {
          result.skipped_collisions.push({
            source: folder,
            target: canonical,
            reason: 'framework.json corrupt or unreadable',
          });
          continue;
        }
      }

      const display = parsed?.role_display ?? folder;

      if (dryRun) {
        result.renamed.push({ from: folder, to: canonical, display });
        continue;
      }

      fs.renameSync(sourcePath, targetPath);
      const newFwPath = path.join(targetPath, 'framework.json');
      if (fs.existsSync(newFwPath)) {
        try {
          const fw = JSON.parse(fs.readFileSync(newFwPath, 'utf-8')) as Framework;
          fw.role = canonical;
          if (!fw.role_display) {
            fw.role_display = folder;
          }
          this._safeWrite(newFwPath, fw);
        } catch {
          // corrupt; leave alone but still record rename
        }
      }
      result.renamed.push({ from: folder, to: canonical, display });
    }

    return result;
  }

  // ── Candidate Operations ─────────────────────────────────────────────────

  readCandidate(role: string, candidateSlug: string): Candidate {
    const candPath = path.join(
      this.baseDir,
      'roles',
      role,
      'candidates',
      `${candidateSlug}.json`,
    );
    if (!fs.existsSync(candPath)) {
      throw new CandidateNotFoundError(candidateSlug);
    }
    return JSON.parse(fs.readFileSync(candPath, 'utf-8')) as Candidate;
  }

  writeCandidate(role: string, candidate: Candidate): void {
    const slug = candidate.candidate_id;
    const candPath = path.join(
      this.baseDir,
      'roles',
      role,
      'candidates',
      `${slug}.json`,
    );
    this._safeWrite(candPath, candidate);
    this._appendAudit({
      timestamp: new Date().toISOString(),
      tool: 'store',
      action: 'write_candidate',
      details: { role, candidate_id: slug, path: candPath },
      actor: 'system',
    });
  }

  listCandidates(role: string): Candidate[] {
    const candDir = path.join(this.baseDir, 'roles', role, 'candidates');
    if (!fs.existsSync(candDir)) {
      return [];
    }
    return fs
      .readdirSync(candDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) =>
        JSON.parse(
          fs.readFileSync(path.join(candDir, f), 'utf-8'),
        ) as Candidate,
      );
  }

  transitionState(
    role: string,
    candidateSlug: string,
    newState: CandidateState,
    options: {
      approved?: boolean;
      reason?: string;
      actor?: 'system' | 'hm';
    } = {},
  ): Candidate {
    const candidate = this.readCandidate(role, candidateSlug);
    const oldState = candidate.state;

    // 1. Validate transition
    if (!isValidTransition(oldState, newState)) {
      throw new IllegalTransitionError(oldState, newState);
    }

    // 2. Check approval gate
    if (isApprovalRequired(oldState, newState) && !options.approved) {
      throw new ApprovalRequiredError(oldState, newState);
    }

    // 3. Update candidate state
    candidate.state = newState;
    candidate.state_updated = new Date().toISOString();
    candidate.pending_action = this._describePendingAction(newState);

    // 4. Append to timeline
    candidate.timeline.push({
      timestamp: new Date().toISOString(),
      event: `${oldState} → ${newState}`,
      details: {
        reason: options.reason,
        actor: options.actor,
      },
    });

    // 5. Write and audit
    this.writeCandidate(role, candidate);

    return candidate;
  }

  private _describePendingAction(state: CandidateState): string {
    const descriptions: Record<CandidateState, string> = {
      [CandidateState.New]: 'Screen resume',
      [CandidateState.Screening]: 'Complete screening',
      [CandidateState.ScreenedPass]: 'Schedule interview',
      [CandidateState.ScreenedReject]: 'Send rejection',
      [CandidateState.Scheduling]: 'Confirm interview slot',
      [CandidateState.InterviewConfirmed]: 'Conduct interview',
      [CandidateState.InterviewDone]: 'Evaluate interview',
      [CandidateState.Evaluating]: 'Complete evaluation',
      [CandidateState.HomeworkAssigned]: 'Await homework submission',
      [CandidateState.HomeworkSubmitted]: 'Review homework',
      [CandidateState.HomeworkOverdue]: 'Follow up on homework',
      [CandidateState.Calibration]: 'Calibrate scores',
      [CandidateState.DecisionPending]: 'Make hiring decision',
      [CandidateState.Hired]: 'Send offer',
      [CandidateState.Rejected]: 'Send rejection',
      [CandidateState.Withdrawn]: 'Archive candidate',
      [CandidateState.NoShow]: 'Follow up or archive',
    };
    return descriptions[state] ?? 'Unknown action';
  }

  generateCandidateId(role: string): string {
    const today = new Date();
    const dateStr = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('');

    const candidates = this.listCandidates(role);
    const prefix = `C-${dateStr}-`;

    let maxSeq = 0;
    for (const c of candidates) {
      const id = c.candidate_id;
      if (id.startsWith('C-') && id.length >= 14) {
        const seqStr = id.slice(id.lastIndexOf('-') + 1);
        const seq = parseInt(seqStr, 10);
        if (!isNaN(seq) && seq > maxSeq) {
          maxSeq = seq;
        }
      }
    }

    return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
  }

  // ── Resume Operations ────────────────────────────────────────────────────

  writeResumeMarkdown(
    role: string,
    candidateSlug: string,
    markdown: string,
  ): void {
    const resumePath = path.join(
      this.baseDir,
      'roles',
      role,
      'candidates',
      'resumes',
      `${candidateSlug}.md`,
    );
    const dir = path.dirname(resumePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resumePath, markdown, 'utf-8');
  }

  readResumeMarkdown(role: string, candidateSlug: string): string {
    const resumePath = path.join(
      this.baseDir,
      'roles',
      role,
      'candidates',
      'resumes',
      `${candidateSlug}.md`,
    );
    if (!fs.existsSync(resumePath)) {
      throw new Error(`Resume not found: ${candidateSlug}`);
    }
    return fs.readFileSync(resumePath, 'utf-8');
  }

  // ── Conversation Operations ──────────────────────────────────────────────

  createConversation(conversationId: string): void {
    const convDir = path.join(
      this.baseDir,
      'conversations',
      conversationId,
    );
    fs.mkdirSync(convDir, { recursive: true });
  }

  appendMessage(
    conversationId: string,
    message: ConversationMessage,
  ): void {
    const convDir = path.join(
      this.baseDir,
      'conversations',
      conversationId,
    );
    fs.mkdirSync(convDir, { recursive: true });

    const existing = fs.existsSync(convDir)
      ? fs.readdirSync(convDir).filter((f) => f.endsWith('.json'))
      : [];
    const seq = existing.length + 1;
    const filename = `${String(seq).padStart(3, '0')}-${message.direction}.json`;
    const filePath = path.join(convDir, filename);

    this._safeWrite(filePath, message);
  }

  readConversation(conversationId: string): ConversationMessage[] {
    const convDir = path.join(
      this.baseDir,
      'conversations',
      conversationId,
    );
    if (!fs.existsSync(convDir)) {
      return [];
    }
    const files = fs
      .readdirSync(convDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    return files.map(
      (f) =>
        JSON.parse(
          fs.readFileSync(path.join(convDir, f), 'utf-8'),
        ) as ConversationMessage,
    );
  }

  getLatestMessage(conversationId: string): ConversationMessage | null {
    const messages = this.readConversation(conversationId);
    return messages.length > 0 ? messages[messages.length - 1] : null;
  }

  // ── Slot Tracking ────────────────────────────────────────────────────────

  getOfferedSlots(role: string): OfferedSlot[] {
    const candidates = this.listCandidates(role);
    const slots: OfferedSlot[] = [];
    for (const c of candidates) {
      if (c.offered_slots && c.offered_slots.length > 0) {
        slots.push(...c.offered_slots);
      }
    }
    return slots;
  }

  markSlotsOffered(
    role: string,
    candidateSlug: string,
    slots: OfferedSlot[],
  ): void {
    const candidate = this.readCandidate(role, candidateSlug);
    candidate.offered_slots = slots;
    this.writeCandidate(role, candidate);
  }

  releaseSlots(role: string, candidateSlug: string): void {
    const candidate = this.readCandidate(role, candidateSlug);
    candidate.offered_slots = [];
    this.writeCandidate(role, candidate);
  }

  // ── Timeout Operations ───────────────────────────────────────────────────

  checkTimeouts(
    role: string,
  ): Array<{ candidate: Candidate; rule: TimeoutRule; overdue_hours: number }> {
    const candidates = this.listCandidates(role);
    const results: Array<{
      candidate: Candidate;
      rule: TimeoutRule;
      overdue_hours: number;
    }> = [];

    for (const candidate of candidates) {
      const rules = getTimeoutRules(candidate.state);
      for (const rule of rules) {
        // Determine the reference timestamp based on relativeTo
        let referenceTime: number;
        if (rule.relativeTo === 'homework_deadline') {
          if (!candidate.homework_deadline) continue;
          referenceTime = new Date(candidate.homework_deadline).getTime();
        } else if (rule.relativeTo === 'earliest_slot_start') {
          if (!candidate.offered_slots || candidate.offered_slots.length === 0) continue;
          referenceTime = Math.min(
            ...candidate.offered_slots.map((s) => new Date(s.start).getTime()),
          );
        } else if (rule.relativeTo === 'latest_slot_end') {
          if (!candidate.offered_slots || candidate.offered_slots.length === 0) continue;
          referenceTime = Math.max(
            ...candidate.offered_slots.map((s) => new Date(s.end).getTime()),
          );
        } else if (rule.relativeTo === 'interview_date') {
          if (!candidate.confirmed_interview) continue;
          referenceTime = new Date(candidate.confirmed_interview.start).getTime();
        } else {
          // Default: measure from state_updated
          referenceTime = new Date(candidate.state_updated).getTime();
        }

        const now = Date.now();
        const hoursSince = (now - referenceTime) / (1000 * 60 * 60);

        if (rule.hours < 0) {
          // Negative-hour rule: fire when within |hours| window BEFORE the event
          if (hoursSince >= rule.hours && hoursSince < 0) {
            results.push({
              candidate,
              rule,
              overdue_hours: Math.abs(hoursSince - rule.hours),
            });
          }
        } else {
          // Positive-hour rule: fire when overdue by at least rule.hours
          if (hoursSince >= rule.hours) {
            results.push({
              candidate,
              rule,
              overdue_hours: hoursSince - rule.hours,
            });
          }
        }
      }
    }

    return results;
  }

  checkTimeoutsAllRoles(): Array<{
    role: string;
    candidate: Candidate;
    rule: TimeoutRule;
    overdue_hours: number;
  }> {
    const roles = this.listRoles();
    const results: Array<{
      role: string;
      candidate: Candidate;
      rule: TimeoutRule;
      overdue_hours: number;
    }> = [];

    for (const role of roles) {
      const timeouts = this.checkTimeouts(role);
      for (const t of timeouts) {
        results.push({ role, ...t });
      }
    }

    return results;
  }

  // ── Narrative and JD ─────────────────────────────────────────────────────

  writeNarrative(
    role: string,
    candidateSlug: string,
    content: string,
  ): void {
    const narrativePath = path.join(
      this.baseDir,
      'roles',
      role,
      'candidates',
      candidateSlug,
      'narrative.md',
    );
    const dir = path.dirname(narrativePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(narrativePath, content, 'utf-8');
  }

  readNarrative(role: string, candidateSlug: string): string {
    const narrativePath = path.join(
      this.baseDir,
      'roles',
      role,
      'candidates',
      candidateSlug,
      'narrative.md',
    );
    if (!fs.existsSync(narrativePath)) {
      return '';
    }
    return fs.readFileSync(narrativePath, 'utf-8');
  }

  writeJd(role: string, content: string): void {
    const jdPath = path.join(this.baseDir, 'roles', role, 'jd.md');
    const dir = path.dirname(jdPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jdPath, content, 'utf-8');
  }

  readJd(role: string): string {
    const jdPath = path.join(this.baseDir, 'roles', role, 'jd.md');
    if (!fs.existsSync(jdPath)) {
      return '';
    }
    return fs.readFileSync(jdPath, 'utf-8');
  }
}
