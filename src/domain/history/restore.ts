import { DEPTH_IDS } from '../privileges';
import { createWritePlan, normalizeId, plannedWrite, type GrantDepth, type PlannedWrite, type WritePlan } from '../operations';
import { deriveStatus } from './record';
import { sameState, targetKeyOfState, targetKeyOfStep } from './state';
import type { OperationRecord, PrivilegeDepthState, RoleHeldState, StepRecord, TargetState, UserPlacementState } from './types';

// RESTORE (issue #325, slice D). Pure and host-free: which recorded operations may be reversed, how several of them combine into ONE joint plan,
// and what exactly would be written. Nothing here reads Dataverse; the application layer reads the CURRENT state and passes it in.
//
// The rules, in one place:
//  - never a blind inverse: an item is restored only when the state found NOW equals the state the operation RECORDED as its result
//    (`expected`); anything else is a conflict (somebody or something changed it since) and is blocked, never overwritten;
//  - the target state is the state READ before the operation (`desired`); an operation without a captured before-state (legacy, incomplete
//    pre-read, damaged record) is never restored automatically;
//  - several selected operations on the same target are ordered by time and only chain when each one's before-state equals the previous one's
//    after-state; otherwise the chain is ambiguous and blocked;
//  - an operation is restored as a WHOLE: when one of its items is blocked, its other items are withheld too (no silent half restore);
//  - a Business Unit move is restored as one composite item (roles first, then the move back, then the roles it removed) and its side effects
//    on teams, ownership and so on are listed as not verified, never claimed.

export type RestoreBlockCode =
  | 'legacy'
  | 'noStates'
  | 'integrity'
  | 'inProgress'
  | 'unresolved'
  | 'nothingApplied'
  | 'otherEnvironment'
  | 'alreadyRestored'
  | 'ambiguous'
  | 'conflict'
  | 'unreadable'
  | 'incompleteState'
  | 'wholeOperation';

export interface OperationEligibility {
  readonly operationId: string;
  readonly eligible: boolean;
  readonly code?: RestoreBlockCode;
  /** Plain language, safe to show. */
  readonly reason?: string;
}

export interface EligibilityContext {
  readonly environmentId: string;
  /**
   * Every verified identifier of the connected environment (its environment id and its organization id). An operation is recorded under the
   * key that was current when it was confirmed, which is the organization id when the environment id could not be read at that moment; both
   * belong to the same environment, so an operation recorded under either one is of this environment.
   */
  readonly environmentAliases?: readonly string[];
  /** The whole recorded history (to see whether an operation was already restored). */
  readonly history: readonly OperationRecord[];
}

const blocked = (op: OperationRecord, code: RestoreBlockCode, reason: string): OperationEligibility => ({ operationId: op.operationId, eligible: false, code, reason });

const timeOf = (op: OperationRecord): number => op.endedAtMs ?? op.startedAtMs;

/** A step that changed something and was confirmed: verified, with both states captured and different from each other. */
function restorableStep(s: StepRecord): s is StepRecord & { before: TargetState; after: TargetState } {
  return s.outcome === 'succeeded' && s.verified && s.before !== undefined && s.after !== undefined && !sameState(s.before, s.after);
}

/** Roles assigned or removed in the same operation as a move of the same user are part of that move's composite restore. */
function coveredByMove(op: OperationRecord, step: StepRecord): boolean {
  if (step.kind !== 'assignRole' && step.kind !== 'unassignRole') return false;
  const user = step.key.split(':')[1];
  return op.steps.some((m) => m.kind === 'moveUser' && m.key.split(':')[1] === user && restorableStep(m));
}

const environmentIds = (ctx: EligibilityContext): Set<string> => new Set([ctx.environmentId, ...(ctx.environmentAliases ?? [])].map(normalizeId));

/** True when a recorded environment id is the connected environment under any of its verified identifiers. */
export function inEnvironment(recorded: string, ctx: EligibilityContext): boolean {
  return environmentIds(ctx).has(normalizeId(recorded));
}

/** Two records belong to the same environment when they carry the same id, or both carry identifiers of the connected environment. */
function sameEnvironmentRecord(a: string, b: string, ctx: EligibilityContext): boolean {
  return normalizeId(a) === normalizeId(b) || (inEnvironment(a, ctx) && inEnvironment(b, ctx));
}

/** Null when the operation may be restored (subject to the current state); otherwise why not. */
export function assessOperation(op: OperationRecord, ctx: EligibilityContext): OperationEligibility {
  if (op.schemaVersion === 1) {
    return blocked(op, 'legacy', 'This operation was recorded before before-states were kept, so it cannot be restored automatically.');
  }
  if (!inEnvironment(op.environmentId, ctx)) {
    return blocked(op, 'otherEnvironment', 'This operation was made in another environment.');
  }
  const restoredBy = ctx.history.find(
    (h) => h.source === 'restore' && h.operationId !== op.operationId && (h.sourceOperationIds ?? []).includes(op.operationId) && sameEnvironmentRecord(h.environmentId, op.environmentId, ctx) && deriveStatus(h) === 'succeeded',
  );
  if (restoredBy) return blocked(op, 'alreadyRestored', 'This operation was already restored by a later restore operation.');
  if (deriveStatus(op) === 'inProgress') return blocked(op, 'inProgress', 'This operation is still running.');

  // A step that FAILED may still have changed something (the final read found another depth than requested): when its recorded states differ,
  // the operation is not restored automatically, so a restore never silently drops a change it cannot account for.
  if (op.steps.some((s) => s.outcome === 'failed' && s.before !== undefined && s.after !== undefined && !sameState(s.before, s.after))) {
    return blocked(op, 'unresolved', 'A step that failed still changed the state (its recorded before and after differ), so the full effect of this operation is not a clean set of confirmed changes. Reconcile it first.');
  }
  const live = op.steps.filter((s) => s.outcome !== 'failed' && s.outcome !== 'skipped');
  const unresolved = live.filter((s) => s.outcome !== 'succeeded' || !s.verified);
  if (unresolved.length > 0) {
    return blocked(op, 'unresolved', 'At least one step is not confirmed (uncertain or not verified), so the effect of this operation is not known. Reconcile it first.');
  }
  const confirmed = live.filter((s) => !coveredByMove(op, s));
  if (confirmed.some((s) => s.stateIntegrity === 'failed')) {
    return blocked(op, 'integrity', 'The recorded states of this operation do not match their checksum, so they cannot be trusted.');
  }
  if (confirmed.some((s) => s.before === undefined || s.after === undefined)) {
    return blocked(op, 'noStates', 'The state before or after this operation was not captured, so it cannot be restored safely.');
  }
  if (!confirmed.some(restorableStep)) {
    return blocked(op, 'nothingApplied', 'This operation did not change anything that can be restored.');
  }
  return { operationId: op.operationId, eligible: true };
}

// ---- chains -----------------------------------------------------------------------------------------------------------------------------

export type RestoreKind = 'privilege' | 'assignment' | 'placement';

interface Link {
  readonly op: OperationRecord;
  readonly step: StepRecord;
  readonly before: TargetState;
  readonly after: TargetState;
}

export interface RestoreChain {
  readonly targetKey: string;
  readonly kind: RestoreKind;
  /** Oldest first. */
  readonly links: readonly Link[];
}

/** One target and what happened to it across the selected operations. Operations are those that passed `assessOperation`. */
export function buildChains(ops: readonly OperationRecord[]): RestoreChain[] {
  const byTarget = new Map<string, Link[]>();
  for (const op of ops) {
    for (const step of op.steps) {
      if (!restorableStep(step) || coveredByMove(op, step)) continue;
      const key = targetKeyOfStep(step);
      if (!key || key !== targetKeyOfState(step.after)) continue;
      const list = byTarget.get(key) ?? [];
      list.push({ op, step, before: step.before, after: step.after });
      byTarget.set(key, list);
    }
  }
  return [...byTarget.entries()].map(([targetKey, links]) => ({
    targetKey,
    kind: targetKey.startsWith('privilege:') ? ('privilege' as const) : targetKey.startsWith('held:') ? ('assignment' as const) : ('placement' as const),
    links: [...links].sort((a, b) => timeOf(a.op) - timeOf(b.op) || (a.op.operationId < b.op.operationId ? -1 : 1)),
  }));
}

// ---- items ------------------------------------------------------------------------------------------------------------------------------

export type RestoreItemStatus = 'restore' | 'alreadyRestored' | 'blocked';

export interface RestoreItem {
  /** The target key (`privilege:<role>:<privilege>`, `held:<user>:<role>`, `user:<user>`). */
  readonly id: string;
  readonly kind: RestoreKind;
  /** The operations that touched this target, newest first. */
  readonly operationIds: readonly string[];
  /** What the newest selected operation recorded as its result: what must be there now for the restore to be safe. */
  readonly expected: TargetState;
  /** What the oldest selected operation read before it ran: where the restore goes. */
  readonly desired: TargetState;
  /** What was found now (null = could not be read). */
  readonly current: TargetState | null;
  readonly status: RestoreItemStatus;
  readonly blockCode?: RestoreBlockCode;
  readonly reason?: string;
  /** The writes, in order (empty unless `status` is `restore`). */
  readonly writes: readonly PlannedWrite[];
  /** Effects the tool cannot read back and therefore does not claim to restore. */
  readonly notVerified: readonly string[];
}

const SIDE_EFFECTS_OF_MOVE = [
  'A Business Unit move can also change team memberships, record ownership and other assignments. The tool does not read or restore those.',
];

function depthWord(state: TargetState): string {
  return state.kind === 'privilegeDepth' ? (state.depth === 'None' ? 'not held' : state.depth) : '';
}

function writesFor(kind: RestoreKind, desired: TargetState, expected: TargetState): PlannedWrite[] {
  if (kind === 'privilege' && desired.kind === 'privilegeDepth' && expected.kind === 'privilegeDepth') {
    const d = desired as PrivilegeDepthState;
    const text = `Restore ${d.privilege} on ${d.table}: ${depthWord(expected)} -> ${depthWord(desired)}`;
    return [d.depth === 'None' ? plannedWrite.removePrivilege(d.roleId, d.privilegeId, text) : plannedWrite.addPrivilege(d.roleId, d.privilegeId, d.depth as GrantDepth, text)];
  }
  if (kind === 'assignment' && desired.kind === 'roleHeld') {
    const d = desired as RoleHeldState;
    return [d.held ? plannedWrite.assignRole(d.userId, d.roleId, `Assign role ${d.roleId} to user ${d.userId} again`) : plannedWrite.unassignRole(d.userId, d.roleId, `Remove role ${d.roleId} from user ${d.userId} (the assignment was added)`)];
  }
  if (kind === 'placement' && desired.kind === 'userPlacement' && expected.kind === 'userPlacement') {
    const d = desired as UserPlacementState;
    const e = expected as UserPlacementState;
    const writes: PlannedWrite[] = [];
    const wanted = new Set(d.roleIds ?? []);
    // 1. roles the operation gave the user (they would not survive the move back and must not be left behind), 2. the move back,
    // 3. every role the user held before (the executor sends only the ones missing after the move).
    for (const r of [...(e.roleIds ?? [])].filter((r) => !wanted.has(r)).sort()) writes.push(plannedWrite.unassignRole(d.userId, r, `Remove role ${r} (the move gave it to the user)`));
    if (normalizeId(e.businessUnitId) !== normalizeId(d.businessUnitId)) writes.push(plannedWrite.moveUser(d.userId, d.businessUnitId, `Move user ${d.userId} back to Business Unit ${d.businessUnitId}`));
    for (const r of [...wanted].sort()) writes.push(plannedWrite.assignRole(d.userId, r, `Assign role ${r} (the user held it before the move; sent only if it is missing)`));
    return writes;
  }
  return [];
}

const itemOf = (chain: RestoreChain, expected: TargetState, desired: TargetState, current: TargetState | null, status: RestoreItemStatus, extra: { blockCode?: RestoreBlockCode; reason?: string; writes?: PlannedWrite[] } = {}): RestoreItem => ({
  id: chain.targetKey,
  kind: chain.kind,
  operationIds: [...chain.links].reverse().map((l) => l.op.operationId),
  expected,
  desired,
  current,
  status,
  ...(extra.blockCode ? { blockCode: extra.blockCode } : {}),
  ...(extra.reason ? { reason: extra.reason } : {}),
  writes: extra.writes ?? [],
  notVerified: chain.kind === 'placement' ? SIDE_EFFECTS_OF_MOVE : [],
});

/** A chain that must not be restored, with the reason. */
export function blockedItem(chain: RestoreChain, current: TargetState | null, code: RestoreBlockCode, reason: string): RestoreItem {
  const first = chain.links[0] as Link;
  const last = chain.links[chain.links.length - 1] as Link;
  return itemOf(chain, last.after, first.before, current, 'blocked', { blockCode: code, reason });
}

/** The state shape to read for a chain (the same target, any time). */
export function targetOfChain(chain: RestoreChain): TargetState {
  return (chain.links[chain.links.length - 1] as Link).after;
}

/** Decides one chain against the state found now. `current` null means it could not be read completely. */
export function decideChain(chain: RestoreChain, current: TargetState | null): RestoreItem {
  const first = chain.links[0] as Link;
  const last = chain.links[chain.links.length - 1] as Link;
  const desired = first.before;
  const expected = last.after;
  const stop = (code: RestoreBlockCode, reason: string): RestoreItem => blockedItem(chain, current, code, reason);

  // The selected operations on one target must follow each other without a gap in the recorded states.
  for (let i = 1; i < chain.links.length; i++) {
    const prev = chain.links[i - 1] as Link;
    const next = chain.links[i] as Link;
    if (timeOf(prev.op) === timeOf(next.op) && prev.op.operationId !== next.op.operationId) {
      return stop('ambiguous', 'Two operations touched this target at the same moment, so their order is not known.');
    }
    if (!sameState(prev.after, next.before)) {
      return stop('ambiguous', 'Something changed this target between two of the selected operations, so they cannot be restored together.');
    }
  }
  if (chain.kind === 'placement') {
    const d = desired as UserPlacementState;
    const e = expected as UserPlacementState;
    if (d.roleIds === null || e.roleIds === null) {
      return stop('incompleteState', 'The roles of the user were not read completely around this move, so the move cannot be restored safely.');
    }
  }
  if (current === null) return stop('unreadable', 'The current state could not be read completely, so nothing can be compared or restored.');
  if (sameState(current, desired)) return itemOf(chain, expected, desired, current, 'alreadyRestored', { reason: 'Already in the restored state.' });
  if (!sameState(current, expected)) {
    return stop('conflict', 'This changed after the operation (the state now differs from what the operation left), so it was not overwritten.');
  }
  return itemOf(chain, expected, desired, current, 'restore', { writes: writesFor(chain.kind, desired, expected) });
}

// ---- the joint plan ---------------------------------------------------------------------------------------------------------------------

export interface RestorePlan {
  readonly environmentId: string;
  /** Every selected operation with its verdict (nothing is dropped silently). */
  readonly operations: readonly OperationEligibility[];
  readonly items: readonly RestoreItem[];
  /** The writes of every item to restore, in order. */
  readonly writes: readonly PlannedWrite[];
  /** The plan to confirm; null when there is nothing to write. */
  readonly plan: WritePlan | null;
  /** Operations with at least one item to write: these are the operations a restore would name as its source. */
  readonly restoredOperationIds: readonly string[];
  readonly readAtMs: number;
}

/**
 * Joint plan from the verdicts, the decided items and the current time. Applies the whole-operation rule: when one item of an operation is blocked
 * its other items are withheld (and so are the other operations sharing a withheld item's chain), repeated until nothing changes.
 */
export function assemblePlan(
  environmentId: string,
  verdicts: readonly OperationEligibility[],
  decided: readonly RestoreItem[],
  readAtMs: number,
): RestorePlan {
  let items = [...decided];
  const blockedOps = new Set<string>();
  for (;;) {
    const before = blockedOps.size;
    for (const i of items) if (i.status === 'blocked') for (const id of i.operationIds) blockedOps.add(id);
    // A target shared with a blocked operation (also one that is "already restored") ties its other operations to that block: restoring them
    // alone would stop short of the state the chain was meant to reach, so they are withheld too rather than reported as restored.
    for (const i of items) if (i.status !== 'blocked' && i.operationIds.some((id) => blockedOps.has(id))) for (const id of i.operationIds) blockedOps.add(id);
    items = items.map((i) =>
      i.status === 'restore' && i.operationIds.some((id) => blockedOps.has(id))
        ? { ...i, status: 'blocked' as const, blockCode: 'wholeOperation' as const, reason: 'Another part of the same operation cannot be restored, so this part is withheld (an operation is restored as a whole).', writes: [] }
        : i,
    );
    if (blockedOps.size === before) break;
  }
  const operations = verdicts.map((v): OperationEligibility => {
    if (!v.eligible) return v;
    const mine = items.filter((i) => i.operationIds.includes(v.operationId));
    const hit = mine.find((i) => i.status === 'blocked');
    if (hit) return { operationId: v.operationId, eligible: false, code: hit.blockCode ?? 'conflict', reason: hit.reason ?? 'This operation cannot be restored.' };
    if (mine.length > 0 && mine.every((i) => i.status === 'alreadyRestored')) {
      return { operationId: v.operationId, eligible: false, code: 'alreadyRestored', reason: 'Everything this operation changed is already back in its earlier state.' };
    }
    return v;
  });
  // Additions and increases go first and reductions last (like a role edit): when something fails midway a person is never left with less access
  // than before the restore started. Execution runs the items in this order and stops at the first failure.
  const order = (i: RestoreItem): number => {
    if (i.kind === 'privilege' && i.desired.kind === 'privilegeDepth' && i.expected.kind === 'privilegeDepth') return DEPTH_IDS.indexOf(i.desired.depth) > DEPTH_IDS.indexOf(i.expected.depth) ? 0 : 1;
    if (i.kind === 'assignment' && i.desired.kind === 'roleHeld') return i.desired.held ? 0 : 1;
    return 2;
  };
  items = items.map((i, n) => ({ i, n })).sort((a, b) => order(a.i) - order(b.i) || a.n - b.n).map((x) => x.i);
  const toWrite = items.filter((i) => i.status === 'restore');
  const writes = toWrite.flatMap((i) => i.writes);
  const restoredOperationIds = [...new Set(toWrite.flatMap((i) => i.operationIds))];
  return {
    environmentId: normalizeId(environmentId),
    operations,
    items,
    writes,
    plan: writes.length > 0 ? createWritePlan(writes) : null,
    restoredOperationIds,
    readAtMs,
  };
}

/** Selected operations on one user where a Business Unit move is among them cannot be combined with other operations on that user. */
export function userConflicts(chains: readonly RestoreChain[]): Set<string> {
  const placements = new Set(chains.filter((c) => c.kind === 'placement').map((c) => c.targetKey.slice('user:'.length)));
  const bad = new Set<string>();
  for (const c of chains) {
    if (c.kind === 'assignment') {
      const user = c.targetKey.split(':')[1] as string;
      if (placements.has(user)) {
        const opsHere = new Set(c.links.map((l) => l.op.operationId));
        const placement = chains.find((p) => p.kind === 'placement' && p.targetKey === `user:${user}`);
        const placementOps = new Set(placement?.links.map((l) => l.op.operationId) ?? []);
        if ([...opsHere].some((id) => !placementOps.has(id))) {
          bad.add(c.targetKey);
          bad.add(`user:${user}`);
        }
      }
    }
  }
  return bad;
}
