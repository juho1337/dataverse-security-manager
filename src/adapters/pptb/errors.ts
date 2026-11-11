import type { ErrorClass } from '../../ports/securityDataReader';

// The host documents no error classes (every failure is a rejected promise), so classification is by the
// status code and message text the rejection carries. UNVERIFIED against the real host; unknown stays `unknown`.

export type HostErrorKind = 'auth' | 'permission' | 'throttled' | 'network' | 'notFound' | 'connectionChanged' | 'unknown';

export interface ClassifiedError {
  readonly kind: HostErrorKind;
  /** Sanitized, short, safe to show (no tokens). */
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

/**
 * The active host connection is no longer the one the session was verified against (or can no longer be read).
 * Never retried; the whole read is abandoned and no data from it is returned.
 */
export class ConnectionChangedError extends Error {
  constructor() {
    super('The active connection changed during the read, so it was stopped and no data was returned.');
    this.name = 'ConnectionChangedError';
  }
}

/** Thrown by the adapter after retries; carries the classification. */
export class HostCallError extends Error {
  constructor(readonly classified: ClassifiedError) {
    super(classified.message);
    this.name = 'HostCallError';
  }
}

function sanitize(text: string): string {
  return text
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [removed]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function numberAt(obj: unknown, ...path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  const n = typeof cur === 'string' ? Number(cur) : cur;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

export function classifyHostError(error: unknown): ClassifiedError {
  if (error instanceof HostCallError) return error.classified;
  if (error instanceof ConnectionChangedError) return { kind: 'connectionChanged', message: error.message };
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'The host call failed.';
  const message = sanitize(raw || 'The host call failed.');
  const lower = message.toLowerCase();

  const status =
    numberAt(error, 'status') ?? numberAt(error, 'statusCode') ?? numberAt(error, 'response', 'status') ??
    (() => {
      const m = /\b(401|403|404|429|50[234])\b/.exec(message);
      return m ? Number(m[1]) : undefined;
    })();

  // Retry-After in seconds (property, header map or message text).
  let retryAfterSeconds =
    numberAt(error, 'retryAfter') ?? numberAt(error, 'retryAfterSeconds') ?? numberAt(error, 'headers', 'retry-after') ??
    numberAt(error, 'response', 'headers', 'retry-after');
  if (retryAfterSeconds === undefined) {
    const m = /retry[- ]after[^0-9]{0,6}(\d+)/i.exec(message);
    if (m) retryAfterSeconds = Number(m[1]);
  }
  const retryAfterMs = retryAfterSeconds !== undefined ? Math.max(0, retryAfterSeconds) * 1000 : undefined;

  let kind: HostErrorKind = 'unknown';
  if (status === 429 || /throttl|too many requests|service protection|rate limit/.test(lower)) kind = 'throttled';
  else if (status === 401 || /unauthori[sz]ed|aadsts|token (is )?(expired|invalid)|sign[- ]?in required|not authenticated/.test(lower)) kind = 'auth';
  else if (status === 403 || /is missing .{0,80}privilege|access is denied|permission|forbidden|prv(read|write|create|delete|append|assign|share)/.test(lower)) kind = 'permission';
  else if (status === 404 || /does not exist|could not be found|not found/.test(lower)) kind = 'notFound';
  else if (status === 502 || status === 503 || status === 504 || /network|fetch failed|failed to fetch|timeout|timed out|econn|enotfound|etimedout|offline/.test(lower)) kind = 'network';

  return { kind, message, status, retryAfterMs };
}

/** The port has no separate "auth" class; a failed sign-in is reported as `permission` with its own message. */
export function toPortErrorClass(kind: HostErrorKind): ErrorClass {
  return kind === 'auth' || kind === 'connectionChanged' ? 'permission' : kind;
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  /** Cap for the computed exponential backoff only; an explicit server Retry-After is never shortened by it. */
  readonly maxDelayMs?: number;
  /** Longest explicit Retry-After that is waited out (default 120 s). A longer demand stops retrying instead of retrying early. */
  readonly maxRetryAfterMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs a read, retrying throttled calls (honoring Retry-After when the rejection carries it, otherwise exponential
 * backoff with jitter) and network failures (once). Everything else fails immediately. Throws HostCallError.
 */
export async function withRetry<T>(call: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const base = options.baseDelayMs ?? 500;
  const cap = options.maxDelayMs ?? 30_000;
  const retryAfterBudget = options.maxRetryAfterMs ?? 120_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let networkRetries = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      const c = classifyHostError(e);
      const retryable = c.kind === 'throttled' || (c.kind === 'network' && networkRetries < 1);
      if (!retryable || attempt >= maxAttempts) throw new HostCallError(c);
      // The server asked for a delay we will not wait out: stop (never retry earlier than it asked).
      if (c.retryAfterMs !== undefined && c.retryAfterMs > retryAfterBudget) throw new HostCallError(c);
      if (c.kind === 'network') networkRetries++;
      const backoff = Math.min(cap, base * 2 ** (attempt - 1)) * (0.5 + random() / 2);
      await sleep(c.retryAfterMs ?? backoff);
    }
  }
}
