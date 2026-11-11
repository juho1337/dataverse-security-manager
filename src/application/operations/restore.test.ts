import { describe, expect, it } from 'vitest';
import { operationToJson } from '../../domain/history/export';
import { deriveStatus, reconcileAbandoned } from '../../domain/history/record';
import { stateChecksum } from '../../domain/history/state';
import type { OperationRecord, PrivilegeDepthState, RoleHeldState, StepRecord, TargetState, UserPlacementState } from '../../domain/history/types';
import { plannedWrite, type OperationResult } from '../../domain/operations';
import { PRIVILEGE_IDS, type CellValue, type DepthId, type PrivilegeCells, type PrivilegeId } from '../../domain/privileges';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { flakyStore, testLedger } from '../../test/ledger';
import type { UserState } from '../buManager/ports';
import { HISTORY_BLOCKED_MESSAGE } from './ledger';
import { OperationRecorder } from './recorder';
import { executeRestore, planRestore, restoreReaders, type RestoreReaders } from './restore';

// Restore: planning (eligibility, current state, conflicts, chains, joint plan) and execution (writer boundary, verification by fresh reads, the
// restoration recorded as a new operation). Everything runs against an in-memory Dataverse; no host is involved (synthetic only).

const ENV = '00000000-0000-4000-8000-000000000002';
const ROLE = '11111111-1111-1111-1111-111111111111';
const ROLE2 = '12121212-1212-1212-1212-121212121212';
const USER = '33333333-3333-3333-3333-333333333333';
const USER2 = '34343434-3434-3434-3434-343434343434';
const BU0 = '50000000-0000-0000-0000-000000000000';
const BU1 = '51000000-0000-0000-0000-000000000000';
const R0 = '60000000-0000-0000-0000-000000000000'; // a role of the original BU
const R1 = '61000000-0000-0000-0000-000000000000'; // a role of the target BU
const R1B = '62000000-0000-0000-0000-000000000000'; // the target BU's copy given by the move
const privOf = Object.fromEntries(PRIVILEGE_IDS.map((p, i) => [p, `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`])) as Record<PrivilegeId, string>;
const nameOfPriv = (id: string): PrivilegeId => PRIVILEGE_IDS.find((p) => privOf[p] === id) as PrivilegeId;

// ---- in-memory Dataverse ---------------------------------------------------------------------------------------------------------------

interface WorldOptions {
  /** Answer for a write, by its description; undefined = accepted. */
  readonly answer?: (kind: string, subject: string) => OperationResult | undefined;
  /** The write is accepted but changes nothing. */
  readonly ignore?: (kind: string, subject: string) => boolean;
  /** Reads stop working after this many reads (to prove "not verified"). */
  readonly readsOkUntil?: number;
  /** The user's role list is partial. */
  readonly partialRoles?: boolean;
  /** Moving a user removes all their direct roles (documented Dataverse behaviour, to be confirmed against the real service). */
  readonly moveWipesRoles?: boolean;
}

function world(init: { depths?: Array<[string, string, DepthId]>; users?: Array<[string, string, string[]]> } = {}, opts: WorldOptions = {}) {
  const depths = new Map<string, DepthId>((init.depths ?? []).map(([r, p, d]) => [`${r}|${p}`, d]));
  const users = new Map<string, { bu: string; roles: Set<string> }>((init.users ?? []).map(([u, bu, roles]) => [u, { bu, roles: new Set(roles) }]));
  const log: string[] = [];
  let reads = 0;
  const readable = () => opts.readsOkUntil === undefined || ++reads <= opts.readsOkUntil;
  const answer = (kind: string, subject: string): OperationResult => opts.answer?.(kind, subject) ?? { outcome: 'notVerified', message: 'accepted', failure: 'none' };
  const writer: SecurityDataWriter = {
    addPrivilege: async (_a, role, priv, depth) => {
      log.push(`add:${nameOfPriv(priv)}:${depth}`);
      const r = answer('add', `${role}|${priv}`);
      if (r.outcome !== 'failed' && !opts.ignore?.('add', `${role}|${priv}`)) depths.set(`${role}|${priv}`, depth);
      return r;
    },
    removePrivilege: async (_a, role, priv) => {
      log.push(`remove:${nameOfPriv(priv)}`);
      const r = answer('remove', `${role}|${priv}`);
      if (r.outcome !== 'failed' && !opts.ignore?.('remove', `${role}|${priv}`)) depths.delete(`${role}|${priv}`);
      return r;
    },
    assignRole: async (_a, user, role) => {
      log.push(`assign:${user}:${role}`);
      const r = answer('assign', `${user}|${role}`);
      if (r.outcome !== 'failed' && !opts.ignore?.('assign', `${user}|${role}`)) users.get(user)?.roles.add(role);
      return r;
    },
    unassignRole: async (_a, user, role) => {
      log.push(`unassign:${user}:${role}`);
      const r = answer('unassign', `${user}|${role}`);
      if (r.outcome !== 'failed' && !opts.ignore?.('unassign', `${user}|${role}`)) users.get(user)?.roles.delete(role);
      return r;
    },
    moveUser: async (_a, user, bu) => {
      log.push(`move:${user}:${bu}`);
      const r = answer('move', `${user}|${bu}`);
      const u = users.get(user);
      if (r.outcome !== 'failed' && u && !opts.ignore?.('move', `${user}|${bu}`)) {
        u.bu = bu;
        if (opts.moveWipesRoles) u.roles.clear();
      }
      return r;
    },
  };
  const readers: RestoreReaders = {
    rolePrivileges: async (_table, roleId) => {
      if (!readable()) return null;
      return Object.fromEntries(
        PRIVILEGE_IDS.map((p) => {
          const d = depths.get(`${roleId}|${privOf[p]}`);
          return [p, (d ? { kind: 'depth', depth: d } : { kind: 'noGrant' }) as CellValue];
        }),
      ) as PrivilegeCells;
    },
    userState: async (userId): Promise<UserState | null> => {
      if (!readable()) return null;
      const u = users.get(userId);
      return u ? { businessUnitId: u.bu, directRoleIds: [...u.roles], rolesComplete: !opts.partialRoles } : null;
    },
  };
  return { depths, users, log, writer, readers };
}

// ---- recorded operations ---------------------------------------------------------------------------------------------------------------

const depthState = (d: DepthId, role = ROLE, priv: PrivilegeId = 'Write'): PrivilegeDepthState => ({ kind: 'privilegeDepth', table: 'account', roleId: role, privilegeId: privOf[priv], privilege: priv, depth: d });
const heldState = (held: boolean, user = USER, role = ROLE): RoleHeldState => ({ kind: 'roleHeld', userId: user, roleId: role, held });
const placement = (bu: string, roleIds: string[] | null, user = USER): UserPlacementState => ({ kind: 'userPlacement', userId: user, businessUnitId: bu, roleIds });

interface StepSpec {
  readonly key: string;
  readonly kind: StepRecord['kind'];
  readonly before?: TargetState;
  readonly after?: TargetState;
  readonly outcome?: StepRecord['outcome'];
  readonly verified?: boolean;
  readonly integrity?: 'ok' | 'failed';
}

function op(id: string, endedAt: number, steps: readonly StepSpec[], over: Partial<OperationRecord> = {}): OperationRecord {
  return {
    schemaVersion: 2,
    operationId: id,
    correlationId: `c-${id}`,
    environmentId: ENV,
    actor: 'Owner',
    planHash: 'h',
    source: 'user',
    startedAtMs: endedAt - 100,
    endedAtMs: endedAt,
    steps: steps.map((s, index): StepRecord => {
      const outcome = s.outcome ?? 'succeeded';
      return {
        index,
        key: s.key,
        kind: s.kind,
        description: s.key,
        outcome,
        verified: s.verified ?? outcome === 'succeeded',
        failure: 'none',
        message: 'ok',
        ...(s.before ? { before: s.before } : {}),
        ...(s.after ? { after: s.after } : {}),
        ...(s.before || s.after ? { stateChecksum: stateChecksum(s.key, s.before, s.after), stateIntegrity: s.integrity ?? ('ok' as const) } : {}),
        ...(s.integrity === 'failed' && !s.before && !s.after ? { stateIntegrity: 'failed' as const } : {}),
      };
    }),
    ...over,
  };
}

const addKey = (depth: 'Basic' | 'Local' | 'Deep' | 'Global', priv: PrivilegeId = 'Write', role = ROLE) => plannedWrite.addPrivilege(role, privOf[priv], depth, '').key;
const removeKey = (priv: PrivilegeId = 'Write', role = ROLE) => plannedWrite.removePrivilege(role, privOf[priv], '').key;
const assignKey = (user = USER, role = ROLE) => plannedWrite.assignRole(user, role, '').key;
const unassignKey = (user = USER, role = ROLE) => plannedWrite.unassignRole(user, role, '').key;

/** Write at Basic added at t=1000 (None -> Basic). */
const addedWrite = (id = 'op-add', t = 1_000) => op(id, t, [{ key: addKey('Basic'), kind: 'addPrivilege', before: depthState('None'), after: depthState('Basic') }]);
/** Write raised from Basic to Local at t=2000. */
const raisedWrite = (id = 'op-raise', t = 2_000) => op(id, t, [{ key: addKey('Local'), kind: 'addPrivilege', before: depthState('Basic'), after: depthState('Local') }]);

/** The same operation as an old (schema v1) record: no states at all. */
const legacyOf = (r: OperationRecord): OperationRecord => ({
  ...r,
  schemaVersion: 1,
  steps: r.steps.map((s) => {
    const copy: Record<string, unknown> = { ...s };
    for (const k of ['before', 'after', 'stateChecksum', 'stateIntegrity']) delete copy[k];
    return copy as unknown as StepRecord;
  }),
});

const deps = (w: ReturnType<typeof world>, history: readonly OperationRecord[] = [], environmentId = ENV) => ({ environmentId, history, readers: w.readers, now: () => 9_000 });
const writeDeps = (w: ReturnType<typeof world>, plan: Awaited<ReturnType<typeof planRestore>>, extra: object = {}) => ({ plan, writer: w.writer, readers: w.readers, actor: 'Owner', environmentId: ENV, now: () => 9_000, ...extra });

// ---- eligibility -----------------------------------------------------------------------------------------------------------------------

describe('planRestore: which operations may be restored', () => {
  const blockedCode = async (record: OperationRecord, history: readonly OperationRecord[] = [], environmentId = ENV) => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const plan = await planRestore([record], deps(w, history, environmentId));
    return { code: plan.operations[0]?.code, eligible: plan.operations[0]?.eligible, plan };
  };

  it('a legacy (v1) record is never restored automatically and says why', async () => {
    const r = await blockedCode(legacyOf(addedWrite()));
    expect(r).toMatchObject({ eligible: false, code: 'legacy' });
    expect(r.plan.operations[0]?.reason).toMatch(/before-states/);
    expect(r.plan.plan).toBeNull();
  });

  it('a verified step without a captured before-state blocks the operation (missing historical state)', async () => {
    const noBefore = op('op-x', 1_000, [{ key: addKey('Basic'), kind: 'addPrivilege', after: depthState('Basic') }]);
    expect((await blockedCode(noBefore)).code).toBe('noStates');
  });

  it('states that failed the integrity check are not restorable', async () => {
    const tampered = op('op-x', 1_000, [{ key: addKey('Basic'), kind: 'addPrivilege', integrity: 'failed' }]);
    expect((await blockedCode(tampered)).code).toBe('integrity');
  });

  it('an operation that is not verified, uncertain or interrupted is not restorable', async () => {
    const notVerified = op('op-n', 1_000, [{ key: addKey('Basic'), kind: 'addPrivilege', before: depthState('None'), after: depthState('Basic'), outcome: 'notVerified', verified: false }]);
    expect((await blockedCode(notVerified)).code).toBe('unresolved');
    const running = { ...addedWrite(), endedAtMs: undefined, steps: [{ ...addedWrite().steps[0]!, outcome: 'pending' as const, verified: false }] } as unknown as OperationRecord;
    expect((await blockedCode(running)).code).toBe('inProgress');
    const interrupted = reconcileAbandoned([running], () => false)[0]!;
    expect((await blockedCode(interrupted)).code).toBe('unresolved');
  });

  it('an operation that applied nothing (failed or skipped) has nothing to restore', async () => {
    const failed = op('op-f', 1_000, [{ key: addKey('Basic'), kind: 'addPrivilege', outcome: 'failed', verified: false }]);
    expect((await blockedCode(failed)).code).toBe('nothingApplied');
  });

  it('an operation from another environment is refused', async () => {
    expect((await blockedCode(addedWrite(), [], 'bbbbbbbb-0000-0000-0000-000000000000')).code).toBe('otherEnvironment');
  });

  it('an operation recorded under the organization id stays restorable once the environment id is the key (same verified environment)', async () => {
    const ORG = 'cccccccc-1111-1111-1111-111111111111';
    const recordedUnderOrg = { ...addedWrite(), environmentId: ORG };
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    // without the alias the same record is refused (it names an unknown environment)
    expect((await planRestore([recordedUnderOrg], deps(w, [], ENV))).operations[0]).toMatchObject({ eligible: false, code: 'otherEnvironment' });
    // with the organization id of the verified environment it is eligible
    const plan = await planRestore([recordedUnderOrg], { ...deps(w, [], ENV), environmentAliases: [ORG] });
    expect(plan.operations[0]?.eligible).toBe(true);
    // a foreign environment id is still refused
    const foreign = await planRestore([{ ...addedWrite(), environmentId: 'dddddddd-2222-2222-2222-222222222222' }], { ...deps(w, [], ENV), environmentAliases: [ORG] });
    expect(foreign.operations[0]).toMatchObject({ eligible: false, code: 'otherEnvironment' });
  });

  it('a restore recorded under the other identifier of the same environment still marks the operation as restored', async () => {
    const ORG = 'cccccccc-1111-1111-1111-111111111111';
    const restore = op('op-restore', 3_000, [{ key: removeKey(), kind: 'removePrivilege', before: depthState('Basic'), after: depthState('None') }], { source: 'restore', sourceOperationIds: ['op-add'], environmentId: ORG });
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const plan = await planRestore([addedWrite()], { ...deps(w, [restore], ENV), environmentAliases: [ORG] });
    expect(plan.operations[0]).toMatchObject({ eligible: false, code: 'alreadyRestored' });
  });

  it('an operation already restored by a verified restore is refused (repeat restore)', async () => {
    const restore = op('op-restore', 3_000, [{ key: removeKey(), kind: 'removePrivilege', before: depthState('Basic'), after: depthState('None') }], { source: 'restore', sourceOperationIds: ['op-add'] });
    expect(deriveStatus(restore)).toBe('succeeded');
    expect((await blockedCode(addedWrite(), [restore])).code).toBe('alreadyRestored');
    // a restore that did not verify does not count
    const unverified = op('op-restore', 3_000, [{ key: removeKey(), kind: 'removePrivilege', outcome: 'notVerified', verified: false }], { source: 'restore', sourceOperationIds: ['op-add'] });
    expect((await blockedCode(addedWrite(), [unverified])).code).not.toBe('alreadyRestored');
  });
});

// ---- planning against the current state -----------------------------------------------------------------------------------------------

describe('planRestore: current state, conflicts and chains', () => {
  it('one operation: the state now equals what the operation left, so the exact inverse write is planned', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const plan = await planRestore([addedWrite()], deps(w));
    expect(plan.operations[0]).toMatchObject({ eligible: true });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ status: 'restore', kind: 'privilege', operationIds: ['op-add'] });
    expect(plan.items[0]?.current).toMatchObject({ depth: 'Basic' });
    expect(plan.items[0]?.desired).toMatchObject({ depth: 'None' });
    expect(plan.writes.map((x) => x.kind)).toEqual(['removePrivilege']);
    expect(plan.plan?.writes).toHaveLength(1);
    expect(plan.restoredOperationIds).toEqual(['op-add']);
    expect(w.log).toEqual([]); // planning reads only
  });

  it('a raised depth is restored to the recorded earlier depth, a removal by adding it back', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Local']] });
    expect((await planRestore([raisedWrite()], deps(w))).writes).toMatchObject([{ kind: 'addPrivilege', depth: 'Basic' }]);
    const removed = op('op-rm', 2_000, [{ key: removeKey(), kind: 'removePrivilege', before: depthState('Deep'), after: depthState('None') }]);
    const w2 = world();
    expect((await planRestore([removed], deps(w2))).writes).toMatchObject([{ kind: 'addPrivilege', depth: 'Deep' }]);
  });

  it('an intervening change is a conflict and is never overwritten', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Global']] }); // somebody raised it further after the operation
    const plan = await planRestore([addedWrite()], deps(w));
    expect(plan.items[0]).toMatchObject({ status: 'blocked', blockCode: 'conflict' });
    expect(plan.operations[0]).toMatchObject({ eligible: false, code: 'conflict' });
    expect(plan.plan).toBeNull();
    expect(await executeRestore(writeDeps(w, plan))).toBeNull();
    expect(w.log).toEqual([]);
  });

  it('if the state is already the earlier one nothing is written and it is reported as already restored', async () => {
    const w = world();
    const plan = await planRestore([addedWrite()], deps(w));
    expect(plan.items[0]).toMatchObject({ status: 'alreadyRestored' });
    expect(plan.operations[0]).toMatchObject({ eligible: false, code: 'alreadyRestored' });
    expect(plan.plan).toBeNull();
  });

  it('a state that cannot be read completely is never compared as "not held"', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] }, { readsOkUntil: 0 });
    const plan = await planRestore([addedWrite()], deps(w));
    expect(plan.items[0]).toMatchObject({ status: 'blocked', blockCode: 'unreadable' });
    const partial = world({ users: [[USER, BU0, []]] }, { partialRoles: true });
    const assigned = op('op-as', 1_000, [{ key: assignKey(), kind: 'assignRole', before: heldState(false), after: heldState(true) }]);
    expect((await planRestore([assigned], deps(partial))).items[0]).toMatchObject({ blockCode: 'unreadable' }); // absence is not proof on a partial list
  });

  it('two selected operations on one target chain in time order and restore to the oldest before-state in one write', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Local']] });
    const plan = await planRestore([raisedWrite(), addedWrite()], deps(w)); // selection order does not matter
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ status: 'restore', operationIds: ['op-raise', 'op-add'] });
    expect(plan.items[0]?.expected).toMatchObject({ depth: 'Local' });
    expect(plan.items[0]?.desired).toMatchObject({ depth: 'None' });
    expect(plan.writes.map((x) => x.kind)).toEqual(['removePrivilege']);
    expect([...plan.restoredOperationIds].sort()).toEqual(['op-add', 'op-raise']);
  });

  it('a gap between the recorded states of two selected operations is ambiguous and blocks both', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Local']] });
    const gap = op('op-raise', 2_000, [{ key: addKey('Local'), kind: 'addPrivilege', before: depthState('Deep'), after: depthState('Local') }]); // did not start where op-add ended
    const plan = await planRestore([addedWrite(), gap], deps(w));
    expect(plan.items[0]).toMatchObject({ status: 'blocked', blockCode: 'ambiguous' });
    expect(plan.operations.every((o) => !o.eligible)).toBe(true);
    expect(plan.plan).toBeNull();
  });

  it('restoring only the OLDER of two operations is a conflict because the newer one changed the target', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Local']] });
    const plan = await planRestore([addedWrite()], deps(w)); // op-raise exists in the history but is not selected
    expect(plan.items[0]).toMatchObject({ status: 'blocked', blockCode: 'conflict' });
  });

  it('independent operations form ONE joint plan', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']], users: [[USER, BU0, [ROLE]]] });
    const assigned = op('op-as', 1_500, [{ key: assignKey(), kind: 'assignRole', before: heldState(false), after: heldState(true) }]);
    const plan = await planRestore([addedWrite(), assigned], deps(w));
    expect(plan.writes.map((x) => x.kind)).toEqual(['removePrivilege', 'unassignRole']);
    expect(plan.plan?.writes).toHaveLength(2);
    expect(plan.operations.every((o) => o.eligible)).toBe(true);
  });

  it('an operation is restored as a whole: when one of its items conflicts its other items are withheld, and the verdict says why', async () => {
    const two = op('op-two', 1_000, [
      { key: addKey('Basic', 'Write'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Write'), after: depthState('Basic', ROLE, 'Write') },
      { key: addKey('Basic', 'Read'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Read'), after: depthState('Basic', ROLE, 'Read') },
    ]);
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic'], [ROLE, privOf.Read, 'Global']] }); // Read was changed since
    const plan = await planRestore([two], deps(w));
    expect(plan.items.map((i) => [i.status, i.blockCode])).toEqual([['blocked', 'wholeOperation'], ['blocked', 'conflict']]);
    expect(plan.plan).toBeNull();
    expect(plan.operations[0]).toMatchObject({ eligible: false });
  });

  it('partial eligibility is explicit: an ineligible operation keeps its reason next to the restorable one', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const legacy = { ...addedWrite('op-old', 500), schemaVersion: 1 as const, steps: [] };
    const plan = await planRestore([addedWrite(), legacy], deps(w));
    expect(plan.operations.map((o) => [o.operationId, o.eligible, o.code])).toEqual([['op-add', true, undefined], ['op-old', false, 'legacy']]);
    expect(plan.plan?.writes).toHaveLength(1);
  });
});

// ---- Business Unit move ----------------------------------------------------------------------------------------------------------------

describe('planRestore and executeRestore: a Business Unit move', () => {
  /** The user held R0 in BU0, was moved to BU1 and then given R1 and R1B there. The moveUser step carries the placements; the role steps ride along. */
  const moveOp = (over: Partial<OperationRecord> = {}, before = placement(BU0, [R0]), after = placement(BU1, [R1, R1B])) =>
    op('op-move', 4_000, [
      { key: plannedWrite.moveUser(USER, BU1, '').key, kind: 'moveUser', before, after },
      { key: assignKey(USER, R1), kind: 'assignRole' },
      { key: assignKey(USER, R1B), kind: 'assignRole' },
    ], over);

  it('is one composite item: roles the move gave, the move back, then the earlier roles; side effects are listed as not verified', async () => {
    const w = world({ users: [[USER, BU1, [R1, R1B]]] }, { moveWipesRoles: true });
    const plan = await planRestore([moveOp()], deps(w));
    expect(plan.operations[0]).toMatchObject({ eligible: true });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ kind: 'placement', status: 'restore' });
    expect(plan.writes.map((x) => x.kind)).toEqual(['unassignRole', 'unassignRole', 'moveUser', 'assignRole']);
    expect(plan.items[0]?.notVerified.join(' ')).toMatch(/team memberships/);

    const led = testLedger();
    const result = await executeRestore(writeDeps(w, plan, { recorder: led.recorder }));
    expect(result?.overall).toBe('succeeded');
    expect(result?.items[0]).toMatchObject({ outcome: 'succeeded' });
    expect(w.users.get(USER)).toMatchObject({ bu: BU0 });
    expect([...w.users.get(USER)!.roles]).toEqual([R0]);
    expect(w.log).toEqual([`unassign:${USER}:${R1}`, `unassign:${USER}:${R1B}`, `move:${USER}:${BU0}`, `assign:${USER}:${R0}`]);
  });

  it('only sends the earlier roles the move back did not leave in place', async () => {
    const w = world({ users: [[USER, BU1, [R1, R1B]]] }, { moveWipesRoles: false });
    const plan = await planRestore([moveOp()], deps(w));
    // the move back keeps the user's roles in this world: the earlier role is still missing and is assigned; extra roles were unassigned first
    const result = await executeRestore(writeDeps(w, plan));
    expect(result?.overall).toBe('succeeded');
    expect([...w.users.get(USER)!.roles]).toEqual([R0]);
  });

  it('is blocked when the role lists around the move were not read completely', async () => {
    const w = world({ users: [[USER, BU1, [R1]]] });
    const plan = await planRestore([moveOp({}, placement(BU0, null), placement(BU1, [R1]))], deps(w));
    expect(plan.items[0]).toMatchObject({ status: 'blocked', blockCode: 'incompleteState' });
  });

  it('is a conflict when the user is no longer where the move left them, or holds other roles now', async () => {
    const moved = world({ users: [[USER, BU0, [R0]]] }); // moved again by someone else
    expect((await planRestore([moveOp()], deps(moved))).items[0]).toMatchObject({ status: 'alreadyRestored' }); // identical to the earlier state
    const elsewhere = world({ users: [[USER, '59999999-0000-0000-0000-000000000000', [R1, R1B]]] });
    expect((await planRestore([moveOp()], deps(elsewhere))).items[0]).toMatchObject({ blockCode: 'conflict' });
    const extraRole = world({ users: [[USER, BU1, [R1, R1B, ROLE2]]] });
    expect((await planRestore([moveOp()], deps(extraRole))).items[0]).toMatchObject({ blockCode: 'conflict' });
  });

  it('cannot be combined with another selected operation on the same user (restore them one at a time)', async () => {
    const later = op('op-later', 5_000, [{ key: assignKey(USER, ROLE2), kind: 'assignRole', before: heldState(false, USER, ROLE2), after: heldState(true, USER, ROLE2) }]);
    const w = world({ users: [[USER, BU1, [R1, R1B, ROLE2]]] });
    const plan = await planRestore([moveOp(), later], deps(w));
    expect(plan.plan).toBeNull();
    expect(plan.items.every((i) => i.blockCode === 'ambiguous' || i.blockCode === 'wholeOperation')).toBe(true);
  });
});

// ---- executing -------------------------------------------------------------------------------------------------------------------------

describe('executeRestore', () => {
  it('writes through the writer, verifies by a fresh read and records the restoration as a NEW operation that names what it reversed', async () => {
    const led = testLedger();
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const plan = await planRestore([addedWrite()], deps(w));
    const result = await executeRestore(writeDeps(w, plan, { recorder: led.recorder }));
    expect(result).toMatchObject({ overall: 'succeeded', stoppedReason: null, restoredOperationIds: ['op-add'] });
    expect(result?.items[0]).toMatchObject({ outcome: 'succeeded', found: { depth: 'None' } });
    expect(w.depths.size).toBe(0);
    expect(w.log).toEqual(['remove:Write']);

    const [rec] = await led.records();
    expect(rec).toMatchObject({ operationId: result?.operationId, source: 'restore', sourceOperationIds: ['op-add'], schemaVersion: 2, actor: 'Owner', environmentId: ENV });
    expect(deriveStatus(rec!)).toBe('succeeded');
    expect(rec?.steps[0]).toMatchObject({ kind: 'removePrivilege', verified: true, before: { depth: 'Basic' }, after: { depth: 'None' }, stateIntegrity: 'ok' });
  });

  it('the restoration is itself restorable and a repeat restore is refused once it is in the history', async () => {
    const led = testLedger();
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const first = await executeRestore(writeDeps(w, await planRestore([addedWrite()], deps(w)), { recorder: led.recorder }));
    const restoreRecord = (await led.records())[0]!;
    // repeat restore of the same operation
    const again = await planRestore([addedWrite()], deps(w, [restoreRecord]));
    expect(again.operations[0]).toMatchObject({ eligible: false, code: 'alreadyRestored' });
    // a stale plan executed a second time sends nothing: the state is no longer where the operation left it
    const stale = await planRestore([addedWrite()], deps(world({ depths: [[ROLE, privOf.Write, 'Basic']] })));
    const log = w.log.length;
    expect(await executeRestore(writeDeps(w, stale))).toMatchObject({ stoppedReason: expect.stringContaining('Something changed') });
    expect(w.log).toHaveLength(log);
    // restoring the restoration puts the change back
    const undo = await planRestore([restoreRecord], deps(w, [restoreRecord]));
    expect(undo.writes).toMatchObject([{ kind: 'addPrivilege', depth: 'Basic' }]);
    expect(first?.restoredOperationIds).toEqual(['op-add']);
  });

  it('a chain of two operations restores in one write to the oldest before-state and both are reported restored', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Local']] });
    const plan = await planRestore([raisedWrite(), addedWrite()], deps(w));
    const result = await executeRestore(writeDeps(w, plan));
    expect(result?.overall).toBe('succeeded');
    expect(w.depths.size).toBe(0);
    expect([...(result?.restoredOperationIds ?? [])].sort()).toEqual(['op-add', 'op-raise']);
  });

  it('a state that changed after the preview sends nothing at all', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const plan = await planRestore([addedWrite()], deps(w));
    w.depths.set(`${ROLE}|${privOf.Write}`, 'Deep'); // changed between preview and confirmation
    const result = await executeRestore(writeDeps(w, plan));
    expect(w.log).toEqual([]);
    expect(result?.items[0]).toMatchObject({ outcome: 'skipped' });
    expect(result?.stoppedReason).toMatch(/Something changed/);
    expect(w.depths.get(`${ROLE}|${privOf.Write}`)).toBe('Deep');
  });

  it('an accepted request the re-read does not confirm is failed, never succeeded', async () => {
    const led = testLedger();
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] }, { ignore: () => true });
    const result = await executeRestore(writeDeps(w, await planRestore([addedWrite()], deps(w)), { recorder: led.recorder }));
    expect(result?.items[0]).toMatchObject({ outcome: 'failed', found: { depth: 'Basic' } });
    expect(result?.restoredOperationIds).toEqual([]);
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ outcome: 'failed', verified: false });
    expect(deriveStatus(rec!)).toBe('failed');
  });

  it('a re-read that cannot be completed leaves the item not verified', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] }, { readsOkUntil: 2 }); // plan read + pre-send read work, the verifying read does not
    const result = await executeRestore(writeDeps(w, await planRestore([addedWrite()], deps(w))));
    expect(result?.items[0]).toMatchObject({ outcome: 'notVerified', found: null });
    expect(result?.overall).toBe('notVerified');
  });

  it('a permission failure stops the run: later items are skipped and nothing is called verified', async () => {
    const led = testLedger();
    const w = world(
      { depths: [[ROLE, privOf.Write, 'Basic'], [ROLE, privOf.Read, 'Basic']] },
      { answer: (kind) => (kind === 'remove' ? { outcome: 'failed', message: 'The account lacks a privilege.', failure: 'permission' } : undefined) },
    );
    const second = op('op-read', 1_500, [{ key: addKey('Basic', 'Read'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Read'), after: depthState('Basic', ROLE, 'Read') }]);
    const result = await executeRestore(writeDeps(w, await planRestore([addedWrite(), second], deps(w)), { recorder: led.recorder }));
    expect(result?.items.map((i) => i.outcome)).toEqual(['failed', 'skipped']);
    expect(result?.stoppedReason).toMatch(/failed/);
    expect(result?.overall).toBe('failed');
    expect(w.log).toEqual(['remove:Write']);
    const [rec] = await led.records();
    expect(rec?.steps.map((s) => [s.outcome, s.failure])).toEqual([['failed', 'permission'], ['skipped', 'none']]);
  });

  it('a changed connection or identity mid-way (a refusal by the boundary) stops the rest and is recorded with its class', async () => {
    const led = testLedger();
    const w = world(
      { depths: [[ROLE, privOf.Write, 'Basic'], [ROLE, privOf.Read, 'Basic']] },
      { answer: (_kind, subject) => (subject.includes(privOf.Read) ? { outcome: 'failed', message: 'The environment id could not be verified. No change was sent.', failure: 'identity', dispatched: false } : undefined) },
    );
    const second = op('op-read', 1_500, [{ key: addKey('Basic', 'Read'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Read'), after: depthState('Basic', ROLE, 'Read') }]);
    const result = await executeRestore(writeDeps(w, await planRestore([addedWrite(), second], deps(w)), { recorder: led.recorder }));
    expect(result?.items.map((i) => i.outcome)).toEqual(['succeeded', 'failed']);
    expect(result?.overall).toBe('partiallyApplied');
    expect(result?.restoredOperationIds).toEqual(['op-add']);
    const [rec] = await led.records();
    expect(rec?.steps[1]).toMatchObject({ outcome: 'failed', failure: 'identity' });
  });

  it('an uncertain write stops the run and the item is uncertain until it is read again', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] }, { answer: () => ({ outcome: 'uncertain', message: 'The connection failed.', failure: 'connection' }), ignore: () => true });
    const result = await executeRestore(writeDeps(w, await planRestore([addedWrite()], deps(w))));
    expect(result?.items[0]).toMatchObject({ outcome: 'uncertain' });
    expect(result?.stoppedReason).toMatch(/uncertain/);
  });

  it('cancellation before an item skips it', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const result = await executeRestore(writeDeps(w, await planRestore([addedWrite()], deps(w)), { isCancelled: () => true }));
    expect(w.log).toEqual([]);
    expect(result?.items[0]).toMatchObject({ outcome: 'skipped' });
  });

  it('a history that cannot be written sends nothing', async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    const recorder = new OperationRecorder(flakyStore(0));
    const result = await executeRestore(writeDeps(w, await planRestore([addedWrite()], deps(w)), { recorder }));
    expect(w.log).toEqual([]);
    expect(result?.stoppedReason).toBe(HISTORY_BLOCKED_MESSAGE);
  });

  it('returns null when there is nothing to write', async () => {
    const w = world();
    expect(await executeRestore(writeDeps(w, await planRestore([addedWrite()], deps(w))))).toBeNull();
  });

  it('assignments: an assignment is undone by removing the role and a removal by assigning it again', async () => {
    const w = world({ users: [[USER, BU0, [ROLE]], [USER2, BU0, []]] });
    const assigned = op('op-as', 1_000, [{ key: assignKey(), kind: 'assignRole', before: heldState(false), after: heldState(true) }]);
    const removed = op('op-un', 1_100, [{ key: unassignKey(USER2, ROLE), kind: 'unassignRole', before: heldState(true, USER2), after: heldState(false, USER2) }]);
    const plan = await planRestore([assigned, removed], deps(w));
    expect(plan.writes.map((x) => x.kind)).toEqual(['assignRole', 'unassignRole']); // assignments first, removals last
    const result = await executeRestore(writeDeps(w, plan));
    expect(result?.overall).toBe('succeeded');
    expect([...w.users.get(USER)!.roles]).toEqual([]);
    expect([...w.users.get(USER2)!.roles]).toEqual([ROLE]);
  });

  it('works with the real readers wired over reader ports', async () => {
    const readers = restoreReaders(
      {
        loadRoleMatrix: async () => ({ status: 'error', errorClass: 'unknown', message: 'x' }),
      },
      { loadUserAccess: async () => ({ status: 'error', errorClass: 'unknown', message: 'x' }) },
    );
    expect(await readers.rolePrivileges('account', ROLE)).toBeNull();
    expect(await readers.userState(USER)).toBeNull();
  });
});

describe('review findings: environment binding, move confirmation, ordering, failed steps, revalidation', () => {
  /** One role edit: Write added (None -> Basic) and Read removed (Basic -> None); the recorded steps send the addition first, like the editor. */
  const editOp = (over: Partial<OperationRecord> = {}) =>
    op('op-edit', 5_000, [
      { key: addKey('Basic', 'Write'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Write'), after: depthState('Basic', ROLE, 'Write') },
      { key: removeKey('Read'), kind: 'removePrivilege', before: depthState('Basic', ROLE, 'Read'), after: depthState('None', ROLE, 'Read') },
    ], over);
  const afterEdit = () => world({ depths: [[ROLE, privOf.Write, 'Basic']] }); // Write is held, Read is not (the state the edit left)

  it('a restore planned in one environment is refused in another: nothing is opened or sent', async () => {
    const w = afterEdit();
    const plan = await planRestore([editOp()], deps(w));
    const led = testLedger();
    const other = 'bbbbbbbb-0000-0000-0000-000000000000';
    const result = await executeRestore(writeDeps(w, plan, { environmentId: other, recorder: led.recorder }));
    expect(w.log).toEqual([]);
    expect(result).toMatchObject({ overall: 'failed' });
    expect(result?.stoppedReason).toMatch(/environment changed/);
    expect(await led.records()).toHaveLength(0);
  });

  it('a move back the read does not confirm stops before the earlier roles are assigned', async () => {
    const w = world({ users: [[USER, BU1, [R1, R1B]]] }, { ignore: (kind) => kind === 'move' }); // the move is accepted and changes nothing
    const move = op('op-move', 4_000, [
      { key: plannedWrite.moveUser(USER, BU1, '').key, kind: 'moveUser', before: placement(BU0, [R0]), after: placement(BU1, [R1, R1B]) },
      { key: assignKey(USER, R1), kind: 'assignRole' },
      { key: assignKey(USER, R1B), kind: 'assignRole' },
    ]);
    const plan = await planRestore([move], deps(w));
    const result = await executeRestore(writeDeps(w, plan));
    expect(w.log.some((l) => l.startsWith(`assign:${USER}:${R0}`))).toBe(false);
    expect(result?.stoppedReason).toMatch(/not in the original Business Unit/);
    expect(result?.items[0]?.outcome).not.toBe('succeeded');
  });

  it('additions go before reductions, so a failed addition leaves the reduction unsent', async () => {
    const ok = afterEdit();
    const plan = await planRestore([editOp()], deps(ok));
    expect(plan.writes.map((x) => x.kind)).toEqual(['addPrivilege', 'removePrivilege']); // Read added back, then Write removed
    await executeRestore(writeDeps(ok, plan));
    expect(ok.log).toEqual(['add:Read:Basic', 'remove:Write']);

    const bad = world({ depths: [[ROLE, privOf.Write, 'Basic']] }, { answer: (kind) => (kind === 'add' ? { outcome: 'failed', message: 'denied', failure: 'permission' } : undefined) });
    const plan2 = await planRestore([editOp()], deps(bad));
    const result = await executeRestore(writeDeps(bad, plan2));
    expect(bad.log).toEqual(['add:Read:Basic']); // the removal of Write was never sent: no access is lost
    expect(bad.depths.get(`${ROLE}|${privOf.Write}`)).toBe('Basic');
    expect(result?.overall).not.toBe('succeeded');
  });

  it('an operation with a failed step that still changed the state is not restored on the strength of its other steps', async () => {
    const half = op('op-half', 5_000, [
      { key: addKey('Basic', 'Write'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Write'), after: depthState('Basic', ROLE, 'Write') },
      { key: addKey('Basic', 'Read'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Read'), after: depthState('Local', ROLE, 'Read'), outcome: 'failed', verified: false },
    ]);
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic'], [ROLE, privOf.Read, 'Local']] });
    const plan = await planRestore([half], deps(w));
    expect(plan.operations[0]).toMatchObject({ eligible: false, code: 'unresolved' });
    expect(plan.plan).toBeNull();
  });

  it('a target shown as already restored must still be restored when the run starts', async () => {
    const both = op('op-both', 5_000, [
      { key: addKey('Basic', 'Write'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Write'), after: depthState('Basic', ROLE, 'Write') },
      { key: addKey('Basic', 'Read'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Read'), after: depthState('Basic', ROLE, 'Read') },
    ]);
    const w = world({ depths: [[ROLE, privOf.Read, 'Basic']] }); // Write is back to None already, Read still needs restoring
    const plan = await planRestore([both], deps(w));
    expect(plan.items.map((i) => i.status).sort()).toEqual(['alreadyRestored', 'restore']);
    w.depths.set(`${ROLE}|${privOf.Write}`, 'Global'); // changed after the preview
    const result = await executeRestore(writeDeps(w, plan));
    expect(w.log).toEqual([]);
    expect(result?.restoredOperationIds).toEqual([]);
    expect(result?.stoppedReason).toMatch(/already restored/);
  });
});

describe('review findings (round 2): cancellation, no-op history, shared chains', () => {
  const moveWith = (afterRoles: string[]) =>
    op('op-move', 4_000, [
      { key: plannedWrite.moveUser(USER, BU1, '').key, kind: 'moveUser', before: placement(BU0, [R0]), after: placement(BU1, afterRoles) },
      { key: assignKey(USER, R1), kind: 'assignRole' },
    ]);

  it('cancelling while a Business Unit restore runs stops before the next request, including the move', async () => {
    const w = world({ users: [[USER, BU1, [R1, R1B]]] });
    const move = op('op-move', 4_000, [
      { key: plannedWrite.moveUser(USER, BU1, '').key, kind: 'moveUser', before: placement(BU0, [R0]), after: placement(BU1, [R1, R1B]) },
      { key: assignKey(USER, R1), kind: 'assignRole' },
      { key: assignKey(USER, R1B), kind: 'assignRole' },
    ]);
    const plan = await planRestore([move], deps(w));
    const result = await executeRestore(writeDeps(w, plan, { isCancelled: () => w.log.length >= 1 })); // cancelled while the first removal ran
    expect(w.log).toEqual([`unassign:${USER}:${R1}`]); // no further request, in particular no move
    expect(result?.stoppedReason).toMatch(/Cancelled/);
    expect(result?.overall).not.toBe('succeeded');
  });

  it('a role the move back left in place is a verified no-op step, so the history agrees with the verified result', async () => {
    const w = world({ users: [[USER, BU1, [R0, R1]]] }); // R0 is still held after the move back
    const led = testLedger();
    const plan = await planRestore([moveWith([R0, R1])], deps(w));
    const result = await executeRestore(writeDeps(w, plan, { recorder: led.recorder }));
    expect(result?.overall).toBe('succeeded');
    expect(w.log).toEqual([`unassign:${USER}:${R1}`, `move:${USER}:${BU0}`]); // R0 was not assigned again
    const [rec] = await led.records();
    expect(rec?.steps.map((x) => x.outcome)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(deriveStatus(rec!)).toBe('succeeded');
    const noop = rec!.steps.find((x) => x.kind === 'assignRole')!;
    expect(noop.before).toEqual(noop.after);
  });

  it('an operation sharing an already-restored target with a blocked operation is withheld, not reported as restored', async () => {
    const A = op('op-a', 1_000, [
      { key: addKey('Basic', 'Read'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Read'), after: depthState('Basic', ROLE, 'Read') },
      { key: addKey('Basic', 'Write'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Write'), after: depthState('Basic', ROLE, 'Write') },
    ]);
    const B = op('op-b', 2_000, [
      { key: addKey('Local', 'Read'), kind: 'addPrivilege', before: depthState('Basic', ROLE, 'Read'), after: depthState('Local', ROLE, 'Read') },
      { key: addKey('Basic', 'Delete'), kind: 'addPrivilege', before: depthState('None', ROLE, 'Delete'), after: depthState('Basic', ROLE, 'Delete') },
    ]);
    // Read is back to None (already restored), Write was changed by someone (A is blocked), Delete is as B left it
    const w = world({ depths: [[ROLE, privOf.Write, 'Global'], [ROLE, privOf.Delete, 'Basic']] });
    const plan = await planRestore([A, B], deps(w));
    expect(plan.operations.find((o) => o.operationId === 'op-a')?.eligible).toBe(false);
    expect(plan.operations.find((o) => o.operationId === 'op-b')?.eligible).toBe(false); // B depends on the chain A blocks
    expect(plan.plan).toBeNull();
    const result = await executeRestore(writeDeps(w, plan));
    expect(result).toBeNull();
    expect(w.log).toEqual([]);
  });
});

describe('the result says what happened to the history entry', () => {
  const planFor = async () => {
    const w = world({ depths: [[ROLE, privOf.Write, 'Basic']] });
    return { w, plan: await planRestore([addedWrite()], deps(w)) };
  };
  it('recorded, saveFailed, blocked and none are told apart', async () => {
    const a = await planFor();
    expect((await executeRestore(writeDeps(a.w, a.plan, { recorder: testLedger().recorder })))?.history).toBe('recorded');
    const b = await planFor();
    expect((await executeRestore(writeDeps(b.w, b.plan)))?.history).toBe('none');
    const c = await planFor();
    const lost = await executeRestore(writeDeps(c.w, c.plan, { recorder: new OperationRecorder(flakyStore(1)) })); // the intent is saved, the result is not
    expect(lost?.history).toBe('saveFailed');
    expect(lost?.overall).toBe('succeeded'); // the write happened and is verified; only the entry is incomplete
    const d = await planFor();
    const blockedRun = await executeRestore(writeDeps(d.w, d.plan, { recorder: new OperationRecorder(flakyStore(0)) }));
    expect(blockedRun?.history).toBe('blocked');
    expect(d.w.log).toEqual([]);
  });
  it('the write descriptions of a Business Unit restore name the roles and the Business Unit', async () => {
    const w = world({ users: [[USER, BU1, [R1, R1B]]] });
    const move = op('op-move', 4_000, [
      { key: plannedWrite.moveUser(USER, BU1, '').key, kind: 'moveUser', before: placement(BU0, [R0]), after: placement(BU1, [R1, R1B]) },
      { key: assignKey(USER, R1), kind: 'assignRole' },
    ]);
    const plan = await planRestore([move], deps(w));
    const text = plan.writes.map((x) => x.description).join(' | ');
    expect(text).toContain(R1);
    expect(text).toContain(R0);
    expect(text).toContain(BU0);
  });
});

describe('exports are unaffected by recorded states', () => {
  it('the JSON export of a v2 record carries no states', () => {
    const text = operationToJson(addedWrite(), 9_000);
    expect(text).not.toContain('privilegeDepth');
    expect(text).not.toContain('stateChecksum');
  });
});
