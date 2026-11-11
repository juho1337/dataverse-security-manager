import type { OperationRecord, PrivilegeDepthState, RoleHeldState, TargetState, UserPlacementState } from '../../domain/history/types';
import {
  assemblePlan,
  assessOperation,
  blockedItem,
  buildChains,
  decideChain,
  targetOfChain,
  userConflicts,
  type OperationEligibility,
  type RestoreChain,
  type RestoreItem,
  type RestorePlan,
} from '../../domain/history/restore';
import { sameState } from '../../domain/history/state';
import { approvePlan, normalizeId, type ApprovedPlan, type Outcome, type PlannedWrite } from '../../domain/operations';
import type { PrivilegeCells } from '../../domain/privileges';
import type { AccessReader, NameRequest, ResolvedNames } from '../../ports/accessReader';
import type { SecurityDataReader } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { rereadRole } from '../roleEditing/service';
import { userStateReader } from '../buManager/ports';
import type { UserState } from '../buManager/ports';
import { HISTORY_BLOCKED_MESSAGE, openLedger, recordedWriter, type LedgerStep } from './ledger';
import type { OperationRecorder } from './recorder';
import { canonicalDepth, placementState, roleHeldState } from './states';

// RESTORE (issue #325, slice D): the application side. `planRestore` reads the CURRENT state of every target of the selected operations and
// builds one joint plan (domain/history/restore.ts decides); `executeRestore` writes it through the existing approved writer boundary,
// verifies by fresh reads and records the restoration as a NEW operation (source `restore`, naming the operations it reverses).
// A restore is not a retry: a retry repeats an unresolved or failed operation after reconciliation, a restore returns eligible, verified
// changes to the state read before them. Neither is an unconditional replay.

/** The reads a restore needs. Both return null when the state could not be read at all. */
export interface RestoreReaders {
  /** The privilege cells of one role record on one table. */
  rolePrivileges(table: string, roleId: string): Promise<PrivilegeCells | null>;
  /** Business Unit and direct roles of one user (`rolesComplete` false when the role list is partial). */
  userState(userId: string): Promise<UserState | null>;
  /** Display names of users and roles for the preview (reads only, best effort: null when they could not be read). Never stored in the history. */
  names?(request: NameRequest): Promise<ResolvedNames | null>;
}

export function restoreReaders(reader: Pick<SecurityDataReader, 'loadRoleMatrix'>, access: Pick<AccessReader, 'loadUserAccess'> & Partial<Pick<AccessReader, 'resolveNames'>>): RestoreReaders {
  const userState = userStateReader(access);
  return {
    rolePrivileges: (table, roleId) => rereadRole(reader as SecurityDataReader, table, roleId).catch(() => null),
    userState: (userId) => userState(userId).catch(() => null),
    ...(access.resolveNames
      ? {
          names: async (request: NameRequest) => {
            try {
              const r = await access.resolveNames!(request);
              return r.status === 'error' ? null : r.data;
            } catch {
              return null;
            }
          },
        }
      : {}),
  };
}

// ---- reading the current state of one target -----------------------------------------------------------------------------------------------

interface Cache {
  readonly cells: Map<string, Promise<PrivilegeCells | null>>;
  readonly users: Map<string, Promise<UserState | null>>;
}

const newCache = (): Cache => ({ cells: new Map(), users: new Map() });

function cellsOf(readers: RestoreReaders, cache: Cache, table: string, roleId: string): Promise<PrivilegeCells | null> {
  const key = `${table.toLowerCase()}|${normalizeId(roleId)}`;
  let p = cache.cells.get(key);
  if (!p) {
    p = readers.rolePrivileges(table, roleId);
    cache.cells.set(key, p);
  }
  return p;
}

function userOf(readers: RestoreReaders, cache: Cache, userId: string): Promise<UserState | null> {
  const key = normalizeId(userId);
  let p = cache.users.get(key);
  if (!p) {
    p = readers.userState(userId);
    cache.users.set(key, p);
  }
  return p;
}

/** The state of the same target as `shape`, as found now; null when it cannot be read completely (never a guess, never "not held" from a gap). */
async function readCurrent(shape: TargetState, readers: RestoreReaders, cache: Cache): Promise<TargetState | null> {
  if (shape.kind === 'privilegeDepth') {
    const cells = await cellsOf(readers, cache, shape.table, shape.roleId);
    const cell = cells?.[shape.privilege];
    if (!cell || cell.kind === 'unknown' || cell.kind === 'notApplicable') return null;
    const s: PrivilegeDepthState = { ...shape, depth: canonicalDepth(cell) };
    return s;
  }
  const user = await userOf(readers, cache, shape.userId);
  if (!user) return null;
  if (shape.kind === 'roleHeld') {
    const role = normalizeId(shape.roleId);
    const present = user.directRoleIds.map(normalizeId).includes(role);
    // Presence is proof; absence proves nothing when the role list is partial.
    if (!present && !user.rolesComplete) return null;
    const s: RoleHeldState = roleHeldState(shape.userId, shape.roleId, present);
    return s;
  }
  const placement: UserPlacementState = placementState(shape.userId, user);
  return placement.roleIds === null ? null : placement;
}

// ---- planning --------------------------------------------------------------------------------------------------------------------------

export interface PlanRestoreDeps {
  /** The environment the restore would be confirmed for (an operation from another environment is never restored). */
  readonly environmentId: string;
  /** Other verified identifiers of the same environment (see `EligibilityContext.environmentAliases`). */
  readonly environmentAliases?: readonly string[];
  /** The whole recorded history, to see whether an operation was already restored. */
  readonly history: readonly OperationRecord[];
  readonly readers: RestoreReaders;
  readonly now?: () => number;
}

/**
 * Builds the joint restore plan for the selected operations: eligibility per operation (with the reason when not), the current state of
 * every target, conflicts with later changes, chronological chains of operations on the same target, and the exact writes. Reads only.
 */
export async function planRestore(selected: readonly OperationRecord[], deps: PlanRestoreDeps): Promise<RestorePlan> {
  const ctx = { environmentId: deps.environmentId, environmentAliases: deps.environmentAliases ?? [], history: deps.history };
  const verdicts: OperationEligibility[] = selected.map((op) => assessOperation(op, ctx));
  const eligible = selected.filter((_, i) => verdicts[i]?.eligible === true);
  const chains: RestoreChain[] = buildChains(eligible);
  const ambiguous = userConflicts(chains);
  const cache = newCache();
  const items: RestoreItem[] = [];
  for (const chain of chains) {
    const current = await readCurrent(targetOfChain(chain), deps.readers, cache);
    items.push(
      ambiguous.has(chain.targetKey)
        ? blockedItem(chain, current, 'ambiguous', 'A Business Unit move and another selected operation touch the same user. Restore them one at a time, newest first.')
        : decideChain(chain, current),
    );
  }
  return assemblePlan(deps.environmentId, verdicts, items, (deps.now ?? Date.now)());
}

// ---- execution -------------------------------------------------------------------------------------------------------------------------

export interface ExecuteRestoreDeps {
  readonly plan: RestorePlan;
  readonly writer: SecurityDataWriter;
  readonly readers: RestoreReaders;
  /** Who confirmed the preview. */
  readonly actor: string;
  /** The environment the preview was confirmed for; the write boundary compares it with the approved environment. */
  readonly environmentId: string;
  /** Other verified identifiers of the same environment: a plan previewed under one of them is still this environment. */
  readonly environmentAliases?: readonly string[];
  readonly recorder?: OperationRecorder;
  readonly now?: () => number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (text: string) => void;
}

export interface RestoreItemResult {
  readonly item: RestoreItem;
  /** `succeeded` ONLY when a fresh read found the state read before the operation. */
  readonly outcome: Outcome;
  readonly message: string;
  /** What the final read found (null when it could not be read). */
  readonly found: TargetState | null;
}

/** What happened to the history entry of this restore: it is shown to the person, never assumed. */
export type RestoreHistory =
  /** The entry was saved (intent and result). */
  | 'recorded'
  /** The intent could not be saved, so nothing was sent and there is no entry. */
  | 'blocked'
  /** The writes happened but saving the final result failed: the entry may be missing or incomplete. */
  | 'saveFailed'
  /** No history was kept (no recorder, or nothing was opened). */
  | 'none';

export interface RestoreResult {
  readonly operationId: string;
  readonly history: RestoreHistory;
  readonly approval: ApprovedPlan;
  readonly items: readonly RestoreItemResult[];
  readonly overall: Outcome;
  /** Why the run stopped before every item was processed; null when it ran through. */
  readonly stoppedReason: string | null;
  /** Operations whose every item was verified back in its earlier state. */
  readonly restoredOperationIds: readonly string[];
}

const SENT_OK: readonly Outcome[] = ['succeeded', 'notVerified'];

function overallOf(items: readonly RestoreItemResult[]): Outcome {
  if (items.length === 0) return 'skipped';
  if (items.every((i) => i.outcome === 'succeeded')) return 'succeeded';
  if (items.every((i) => i.outcome === 'skipped')) return 'skipped';
  if (items.every((i) => i.outcome === 'failed' || i.outcome === 'skipped')) return 'failed';
  if (items.every((i) => i.outcome === 'succeeded' || i.outcome === 'notVerified' || i.outcome === 'skipped')) return 'notVerified';
  return 'partiallyApplied';
}

interface Run {
  readonly item: RestoreItem;
  /** The state read immediately before sending (becomes the `before` of the restore operation). */
  fresh: TargetState | null;
  /** Writes that were actually sent, with what the writer answered. */
  readonly sent: Map<string, { outcome: Outcome; message: string }>;
  skippedReason?: string;
}

/**
 * Called ONLY after a person confirmed the restore preview. Re-reads every target first: if anything changed since the preview nothing is sent
 * (a restore never overwrites a newer change). Then writes through the approved writer in plan order, stops at the first failed or uncertain write,
 * re-reads every target and judges each by whether it is back in the state read before the operation. Null when there is nothing to write.
 */
export async function executeRestore(deps: ExecuteRestoreDeps): Promise<RestoreResult | null> {
  const { plan, readers } = deps;
  const toRun = plan.items.filter((i) => i.status === 'restore');
  if (!plan.plan || toRun.length === 0) return null;
  // The plan was read in ONE environment and is confirmed for it: a different environment now (the connection changed after the preview) is
  // refused before anything is opened or sent. The historical plan is never rebound to another environment.
  const environmentChanged = ![deps.environmentId, ...(deps.environmentAliases ?? [])].some((k) => normalizeId(k) === normalizeId(plan.environmentId));
  const approval = approvePlan(plan.plan, environmentChanged ? plan.environmentId : deps.environmentId, deps.actor, (deps.now ?? Date.now)(), {
    context: { source: 'restore', sourceOperationIds: plan.restoredOperationIds },
  });
  if (environmentChanged) {
    const reason = 'The environment changed after the preview, so nothing was sent. Preview the restore again in the connected environment.';
    return {
      operationId: approval.operationId,
      approval,
      items: toRun.map((item): RestoreItemResult => ({ item, outcome: 'skipped', message: reason, found: null })),
      overall: 'failed',
      stoppedReason: reason,
      restoredOperationIds: [],
      history: 'none',
    };
  }
  const ledger = openLedger(deps.recorder, approval);
  const historyNow = (): RestoreHistory => (!ledger || !deps.recorder ? 'none' : deps.recorder.lastSaveError ? 'saveFailed' : 'recorded');
  const historyBlocked = ledger !== null && !(await ledger.begin());
  const runs: Run[] = toRun.map((item) => ({ item, fresh: null, sent: new Map() }));
  const abort = (reason: string): RestoreResult => {
    const items = runs.map((r): RestoreItemResult => ({ item: r.item, outcome: 'skipped', message: reason, found: null }));
    return { operationId: approval.operationId, approval, items, overall: 'failed', stoppedReason: reason, restoredOperationIds: [], history: historyBlocked ? 'blocked' : 'none' };
  };
  if (historyBlocked) {
    return abort(HISTORY_BLOCKED_MESSAGE);
  }
  const writer = ledger ? recordedWriter(deps.writer, ledger) : deps.writer;

  // 1. Fresh state of every target. A target that is no longer where the operation left it is never overwritten: nothing at all is sent.
  // Targets the preview showed as ALREADY restored (of an operation this run would report as restored) must still be in that state.
  const pre = newCache();
  const settled = plan.items.filter((i) => i.status === 'alreadyRestored' && i.operationIds.some((id) => plan.restoredOperationIds.includes(id)));
  for (const item of settled) {
    const now = await readCurrent(item.desired, readers, pre);
    if (now === null || !sameState(now, item.desired)) {
      const reason = 'Something changed after the preview (a target shown as already restored is not any more), so nothing was sent. Preview the restore again.';
      const result = abort(reason);
      if (ledger) await finishSkipped(ledger, plan.plan.writes, reason);
      return { ...result, history: historyNow() };
    }
  }
  for (const r of runs) {
    r.fresh = await readCurrent(r.item.expected, readers, pre);
    if (r.fresh === null || !sameState(r.fresh, r.item.expected)) {
      const reason = r.fresh === null
        ? 'The current state could not be read completely just before restoring, so nothing was sent.'
        : 'Something changed after the preview, so nothing was sent. Read the history again and preview the restore again.';
      const result = abort(reason);
      if (ledger) await finishSkipped(ledger, plan.plan.writes, reason);
      return { ...result, history: historyNow() };
    }
  }

  // 2. The writes, in plan order.
  let stoppedReason: string | null = null;
  const send = async (write: PlannedWrite, run: Run): Promise<boolean> => {
    // Cancellation is honoured before EVERY request (also after an awaited read or write), and what is left stays unattempted.
    if (deps.isCancelled?.()) {
      stoppedReason = 'Cancelled: the remaining steps were not attempted.';
      return false;
    }
    deps.onProgress?.(write.description);
    let result: { outcome: Outcome; message: string };
    try {
      result = await dispatch(writer, approval, write);
    } catch {
      result = { outcome: 'uncertain', message: 'The write ended with an unexpected error; whether it was applied is not known until it is read again.' };
    }
    run.sent.set(write.key, result);
    if (result.outcome === 'failed') stoppedReason = 'A restore step failed; the remaining steps were not attempted.';
    else if (result.outcome === 'uncertain') stoppedReason = 'A restore step has an uncertain result; the remaining steps were not attempted.';
    return stoppedReason === null;
  };

  for (const run of runs) {
    if (stoppedReason) {
      run.skippedReason = stoppedReason;
      continue;
    }
    if (deps.isCancelled?.()) {
      stoppedReason = 'Cancelled before this item was restored.';
      run.skippedReason = stoppedReason;
      continue;
    }
    const writes = run.item.writes;
    if (run.item.kind !== 'placement') {
      for (const w of writes) if (!(await send(w, run))) break;
      continue;
    }
    // A move back: roles the move gave, the move, then (after reading what the move left) only the earlier roles that are missing.
    const desired = run.item.desired as UserPlacementState;
    let moved = false;
    for (const w of writes) {
      if (stoppedReason) break;
      if (w.kind === 'assignRole') {
        if (!moved) {
          // No move was needed (the user is already in the original Business Unit): the read before restoring already showed their roles.
          if (run.fresh?.kind === 'userPlacement' && run.fresh.roleIds?.map(normalizeId).includes(normalizeId(w.roleId))) continue;
        } else {
          const state = await readers.userState(desired.userId).catch(() => null);
          if (!state || !state.rolesComplete) {
            stoppedReason = 'The user could not be read completely after the move back, so the earlier roles were not assigned.';
            break;
          }
          // An accepted request is not proof: the earlier roles are assigned only when the read shows the user back in the original Business Unit.
          if (normalizeId(state.businessUnitId) !== normalizeId(desired.businessUnitId)) {
            stoppedReason = 'The user is not in the original Business Unit after the move back (the request was accepted but a read does not confirm it), so the earlier roles were not assigned.';
            break;
          }
          if (state.directRoleIds.map(normalizeId).includes(normalizeId(w.roleId))) continue;
        }
      }
      if (!(await send(w, run))) break;
      if (w.kind === 'moveUser') moved = true;
    }
  }

  // 3. Verify: a fresh read of every target that was attempted.
  const post = newCache();
  const results: RestoreItemResult[] = [];
  const found = new Map<string, TargetState | null>();
  for (const run of runs) {
    if (run.sent.size === 0) {
      results.push({ item: run.item, outcome: 'skipped', message: run.skippedReason ?? 'Not attempted.', found: null });
      continue;
    }
    const state = await readCurrent(run.item.expected, readers, post);
    found.set(run.item.id, state);
    const worst = [...run.sent.values()].find((s) => s.outcome === 'failed' || s.outcome === 'uncertain');
    if (state === null) {
      results.push({ item: run.item, outcome: worst?.outcome === 'failed' ? 'failed' : 'notVerified', message: `${worst?.message ?? 'The request was accepted.'} Not verified: the target could not be read again completely.`, found: null });
    } else if (sameState(state, run.item.desired)) {
      results.push({ item: run.item, outcome: 'succeeded', message: 'Confirmed by a re-read: back in the state read before the operation.', found: state });
    } else {
      results.push({
        item: run.item,
        outcome: worst?.outcome === 'uncertain' ? 'uncertain' : 'failed',
        message: worst?.message ?? 'The request was accepted but the re-read does not show the earlier state.',
        found: state,
      });
    }
  }

  // 4. The ledger: one step per planned write, with the states read before and found after, so the restore itself can be audited and restored.
  if (ledger) {
    const steps: LedgerStep[] = plan.plan.writes.map((w) => stepFor(w, runs, results, found));
    await ledger.finish(steps);
  }

  const restored = new Set<string>();
  for (const id of plan.restoredOperationIds) {
    const mine = results.filter((r) => r.item.operationIds.includes(id));
    if (mine.length > 0 && mine.every((r) => r.outcome === 'succeeded')) restored.add(id);
  }
  return { operationId: approval.operationId, approval, items: results, overall: overallOf(results), stoppedReason, restoredOperationIds: [...restored], history: historyNow() };
}

async function dispatch(writer: SecurityDataWriter, approval: ApprovedPlan, w: PlannedWrite): Promise<{ outcome: Outcome; message: string }> {
  switch (w.kind) {
    case 'addPrivilege':
      return writer.addPrivilege(approval, w.roleId, w.privilegeId, w.depth);
    case 'removePrivilege':
      return writer.removePrivilege(approval, w.roleId, w.privilegeId);
    case 'assignRole':
      return writer.assignRole(approval, w.userId, w.roleId);
    case 'unassignRole':
      return writer.unassignRole(approval, w.userId, w.roleId);
    case 'moveUser':
      return writer.moveUser(approval, w.userId, w.targetBusinessUnitId);
  }
}

async function finishSkipped(ledger: NonNullable<ReturnType<typeof openLedger>>, writes: readonly PlannedWrite[], reason: string): Promise<void> {
  await ledger.finish(writes.map((w) => ({ key: w.key, outcome: 'skipped' as const, message: reason })));
}

/** The ledger step of one planned write, judged by its item's verification (never by the accepted request alone). */
function stepFor(w: PlannedWrite, runs: readonly Run[], results: readonly RestoreItemResult[], found: ReadonlyMap<string, TargetState | null>): LedgerStep {
  const run = runs.find((r) => r.item.writes.some((x) => x.key === w.key));
  const result = results.find((r) => r.item === run?.item);
  const sent = run?.sent.get(w.key);
  if (!run || !result) return { key: w.key, outcome: 'skipped', message: 'Not attempted.' };
  const after = found.get(run.item.id) ?? null;
  const before = run.fresh;
  if (!sent) {
    // A step of a verified move back that needed no request (the role was still held, the user was already there) is a verified no-op, not an
    // unattempted step: it carries its unchanged state, so the history agrees with the verified result.
    if (run.item.kind === 'placement' && result.outcome === 'succeeded' && after?.kind === 'userPlacement' && after.roleIds !== null) {
      const noop = { outcome: 'succeeded' as const, message: 'Already in place; nothing needed to be sent. Confirmed by a re-read.' };
      if (w.kind === 'moveUser') return { key: w.key, ...noop, before: after, after };
      if (w.kind === 'assignRole' || w.kind === 'unassignRole') {
        const held = roleHeldState(w.userId, w.roleId, after.roleIds.map(normalizeId).includes(normalizeId(w.roleId)));
        return { key: w.key, ...noop, before: held, after: held };
      }
    }
    return { key: w.key, outcome: 'skipped', message: result.outcome === 'skipped' ? result.message : 'Nothing needed to be sent for this step.' };
  }
  if (run.item.kind !== 'placement') {
    return {
      key: w.key,
      outcome: result.outcome,
      message: result.message,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };
  }
  // A step of a move back is judged against the state its own write was meant to reach.
  const state = after && after.kind === 'userPlacement' ? after : null;
  const desired = run.item.desired as UserPlacementState;
  const roles = state?.roleIds?.map(normalizeId) ?? null;
  const reached =
    state === null
      ? null
      : w.kind === 'moveUser'
        ? normalizeId(state.businessUnitId) === normalizeId(desired.businessUnitId)
        : w.kind === 'assignRole'
          ? roles?.includes(normalizeId(w.roleId)) ?? null
          : w.kind === 'unassignRole'
            ? roles === null ? null : !roles.includes(normalizeId(w.roleId))
            : null;
  const outcome: Outcome = reached === true ? 'succeeded' : reached === false ? 'failed' : SENT_OK.includes(sent.outcome) ? 'notVerified' : sent.outcome;
  return {
    key: w.key,
    outcome,
    message: reached === true ? 'Confirmed by a re-read.' : sent.message,
    ...(w.kind === 'moveUser' && before && after ? { before, after } : {}),
    ...(w.kind !== 'moveUser' && before?.kind === 'userPlacement' && before.roleIds !== null && (w.kind === 'assignRole' || w.kind === 'unassignRole')
      ? { before: roleHeldState(w.userId, w.roleId, before.roleIds.map(normalizeId).includes(normalizeId(w.roleId))) }
      : {}),
    ...(w.kind !== 'moveUser' && state?.roleIds && (w.kind === 'assignRole' || w.kind === 'unassignRole')
      ? { after: roleHeldState(w.userId, w.roleId, roles?.includes(normalizeId(w.roleId)) === true) }
      : {}),
  };
}
