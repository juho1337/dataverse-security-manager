import type { DepthId } from './privileges';

// Write plans, confirmation and results. Mirrors the XrmToolBox write contract (Core/Writing): the user confirms an exact,
// ordered plan for exactly one environment; anything outside that confirmation is refused. Pure and host-free.

export type WriteKind = 'addPrivilege' | 'removePrivilege' | 'assignRole' | 'unassignRole' | 'moveUser';

/** Depths a privilege can be granted at (None is removal, a separate kind). */
export type GrantDepth = Exclude<DepthId, 'None'>;

interface PlannedWriteBase {
  /** Stable identity of this write inside a plan; a write whose key is not in the approved plan is refused. */
  readonly key: string;
  /** Plain language shown in confirmation, results and audit. No tokens or record contents. */
  readonly description: string;
}

export type PlannedWrite =
  | (PlannedWriteBase & { readonly kind: 'addPrivilege'; readonly roleId: string; readonly privilegeId: string; readonly depth: GrantDepth })
  | (PlannedWriteBase & { readonly kind: 'removePrivilege'; readonly roleId: string; readonly privilegeId: string })
  | (PlannedWriteBase & { readonly kind: 'assignRole'; readonly userId: string; readonly roleId: string })
  | (PlannedWriteBase & { readonly kind: 'unassignRole'; readonly userId: string; readonly roleId: string })
  | (PlannedWriteBase & { readonly kind: 'moveUser'; readonly userId: string; readonly targetBusinessUnitId: string });

export function normalizeId(id: string): string {
  return id.trim().replace(/^\{|\}$/g, '').toLowerCase();
}

export const plannedWrite = {
  addPrivilege(roleId: string, privilegeId: string, depth: GrantDepth, description: string): PlannedWrite {
    const r = normalizeId(roleId);
    const p = normalizeId(privilegeId);
    return { kind: 'addPrivilege', key: `addPrivilege:${r}:${p}:${depth}`, description, roleId: r, privilegeId: p, depth };
  },
  removePrivilege(roleId: string, privilegeId: string, description: string): PlannedWrite {
    const r = normalizeId(roleId);
    const p = normalizeId(privilegeId);
    return { kind: 'removePrivilege', key: `removePrivilege:${r}:${p}`, description, roleId: r, privilegeId: p };
  },
  assignRole(userId: string, roleId: string, description: string): PlannedWrite {
    const u = normalizeId(userId);
    const r = normalizeId(roleId);
    return { kind: 'assignRole', key: `assignRole:${u}:${r}`, description, userId: u, roleId: r };
  },
  unassignRole(userId: string, roleId: string, description: string): PlannedWrite {
    const u = normalizeId(userId);
    const r = normalizeId(roleId);
    return { kind: 'unassignRole', key: `unassignRole:${u}:${r}`, description, userId: u, roleId: r };
  },
  moveUser(userId: string, targetBusinessUnitId: string, description: string): PlannedWrite {
    const u = normalizeId(userId);
    const b = normalizeId(targetBusinessUnitId);
    return { kind: 'moveUser', key: `moveUser:${u}:${b}`, description, userId: u, targetBusinessUnitId: b };
  },
} as const;

/** An ordered, non-empty, duplicate-free list of writes. `hash` changes when any write is added, removed, changed or reordered. */
export interface WritePlan {
  readonly writes: readonly PlannedWrite[];
  readonly hash: string;
}

/** Synchronous 53-bit string hash (cyrb53). It binds a confirmation to a plan; it is not a security primitive. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Canonical text of everything that decides what a write does (the description is shown to people, not executed, but is bound too). */
export function canonicalWrite(write: PlannedWrite): string {
  return JSON.stringify(Object.keys(write).sort().map((k) => [k, (write as unknown as Record<string, unknown>)[k]]));
}

/** The hash binds the full contents of every write, not only the keys. */
export function planHashOf(writes: readonly PlannedWrite[]): string {
  return hashText(writes.map(canonicalWrite).join('\n'));
}

export function createWritePlan(writes: readonly PlannedWrite[]): WritePlan {
  if (writes.length === 0) throw new Error('A write plan needs at least one write.');
  const keys = writes.map((w) => w.key);
  if (new Set(keys).size !== keys.length) throw new Error('A write plan cannot contain the same write twice.');
  return Object.freeze({ writes: Object.freeze([...writes]), hash: planHashOf(writes) });
}

export const DEFAULT_APPROVAL_LIFETIME_MS = 15 * 60 * 1000;

/** Where an operation came from when it is not an ordinary user action (a recovery names its source). */
export interface OperationContext {
  readonly source: 'user' | 'recovery' | 'retry' | 'restore';
  /** The operation a retry follows. */
  readonly sourceOperationId?: string;
  /** The operations a restore reverses (a restore names every operation it restores). */
  readonly sourceOperationIds?: readonly string[];
}

/**
 * Proof that a person confirmed exactly this plan for exactly this environment. Created only by `approvePlan` (the
 * confirmation step). Bound to the plan hash and the environment id, and it expires.
 */
export interface ApprovedPlan {
  readonly plan: WritePlan;
  readonly planHash: string;
  readonly environmentId: string;
  readonly approvedBy: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  /** Names this confirmed operation in every audit record, result and export. Random; says nothing about people or data. */
  readonly operationId: string;
  readonly context: OperationContext;
}

function newOperationId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function approvePlan(
  plan: WritePlan,
  environmentId: string,
  approvedBy: string,
  nowMs: number,
  options: { readonly lifetimeMs?: number; readonly context?: OperationContext; readonly operationId?: string } = {},
): ApprovedPlan {
  if (!environmentId.trim()) throw new Error('The environment id is required.');
  if (!approvedBy.trim()) throw new Error('Who confirmed the plan is required.');
  const lifetime = options.lifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
  if (!(lifetime > 0)) throw new Error('The approval lifetime must be positive.');
  return Object.freeze({
    plan,
    planHash: plan.hash,
    environmentId: normalizeId(environmentId),
    approvedBy: approvedBy.trim(),
    approvedAtMs: nowMs,
    expiresAtMs: nowMs + lifetime,
    operationId: options.operationId ?? newOperationId(),
    context: options.context ?? ({ source: 'user' } as OperationContext),
  });
}

/**
 * The write of the confirmed plan that write claims to be, or null when the plan was altered after confirmation, no write has that
 * key, or the supplied write differs in any content from the confirmed one (same key, other role/user/privilege/depth/kind).
 */
export function approvedWriteFor(approval: ApprovedPlan, write: PlannedWrite): PlannedWrite | null {
  if (planHashOf(approval.plan.writes) !== approval.planHash || approval.plan.hash !== approval.planHash) return null;
  const approved = approval.plan.writes.find((w) => w.key === write.key);
  return approved && canonicalWrite(approved) === canonicalWrite(write) ? approved : null;
}

/** Null when `write` may be executed now against `environmentId`; otherwise the reason it may not. */
export function approvalRefusal(approval: ApprovedPlan, write: PlannedWrite, environmentId: string, nowMs: number): string | null {
  if (nowMs > approval.expiresAtMs) return 'The confirmation has expired. Review the plan and confirm again.';
  if (normalizeId(environmentId) !== approval.environmentId) {
    return 'The plan was confirmed for a different environment. Review the plan and confirm again.';
  }
  const approved = approvedWriteFor(approval, write);
  if (!approved) return 'This change is not part of the confirmed plan.';
  return null;
}

/**
 * `succeeded` is produced only by verification code (a re-read confirmed the end state). A host call that returns without
 * error yields `notVerified`, never success. `uncertain` means the request may or may not have been applied (timeout,
 * connection loss); it is resolved only by re-reading.
 */
export type Outcome = 'succeeded' | 'failed' | 'skipped' | 'partiallyApplied' | 'notVerified' | 'uncertain';

/** Why a step did not go through, in terms an administrator acts on. */
export type FailureClass = 'none' | 'validation' | 'permission' | 'throttling' | 'connection' | 'timeout' | 'execution' | 'identity' | 'history';

export interface OperationResult {
  readonly outcome: Outcome;
  /** Plain language, no service text and no record data. */
  readonly message: string;
  readonly failure: FailureClass;
  /** Troubleshooting only: kind of failure and Dataverse error code. Never record data, names or secrets. */
  readonly technical?: string;
  /** False when the write was refused BEFORE any request left (nothing was sent); true when a request was sent; absent when not known (treated as sent). */
  readonly dispatched?: boolean;
}

export function notVerified(message: string): OperationResult {
  return { outcome: 'notVerified', message, failure: 'none' };
}

export function refused(failure: FailureClass, message: string, technical?: string): OperationResult {
  // A refusal always happens before dispatch: nothing was sent.
  return technical === undefined ? { outcome: 'failed', message, failure, dispatched: false } : { outcome: 'failed', message, failure, technical, dispatched: false };
}

/** One audit record. Ids and plain language only. */
export interface AuditRecord {
  readonly timestampMs: number;
  readonly actor: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly kind: WriteKind;
  readonly key: string;
  readonly description: string;
  readonly result: OperationResult;
}
