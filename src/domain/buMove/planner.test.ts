import { describe, expect, it } from 'vitest';
import type { GrantDepth } from '../operations';
import type { PrivilegeId } from '../privileges';
import { BuMovePlanError, planBuMove } from './planner';
import type {
  BuMoveRequest,
  RestoreStrategy,
  Role,
  RolePrivilege,
  RoleChoice,
  RoleSelection,
  SecuritySettings,
  SecuritySnapshot,
  Team,
  UserSummary,
} from './types';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ROOT = id(1);
const BU_A = id(2);
const BU_B = id(3);
const U1 = id(100);

const SETTINGS_ON: SecuritySettings = {
  enableOwnershipAcrossBusinessUnits: true,
  doNotRemoveRolesOnChangeBusinessUnit: false,
  alwaysMoveRecordToOwnerBusinessUnit: true,
  notes: [],
};

const bus = [
  { id: ROOT, name: 'Root', parentId: null, isDisabled: false },
  { id: BU_A, name: 'Unit A', parentId: ROOT, isDisabled: false },
  { id: BU_B, name: 'Unit B', parentId: ROOT, isDisabled: false },
];

const role = (n: number, name: string, bu: string, rootOf: string | null = null, isManaged = false): Role => ({
  id: id(n), name, businessUnitId: bu, parentRoleId: rootOf, parentRootRoleId: rootOf, isManaged,
});
const user = (n: number, bu: string, extra: Partial<UserSummary> = {}): UserSummary => ({
  id: id(n), fullName: `User ${n}`, email: `u${n}@example.test`, businessUnitId: bu, isDisabled: false, isApplicationUser: false, ...extra,
});
const priv = (roleN: number, entity: string, operation: PrivilegeId, depth: GrantDepth): RolePrivilege => ({ roleId: id(roleN), entity, operation, depth });

function snap(over: Partial<SecuritySnapshot> = {}): SecuritySnapshot {
  return {
    businessUnits: bus, roles: [], users: [user(100, BU_A)], teams: [], directAssignments: [], memberships: [],
    settings: SETTINGS_ON, warnings: [], ...over,
  };
}

function req(over: Partial<BuMoveRequest> = {}): BuMoveRequest {
  return {
    targetBusinessUnitId: BU_B, strategy: 'none', selection: { mode: 'none' }, choices: [],
    users: [{ userId: U1, choices: [] }], ...over,
  };
}

const ALL: RoleSelection = { mode: 'allDirectRoles' };
const confirmed = (source: number, chosen: number | null = null): RoleChoice => ({ sourceRoleId: id(source), chosenRoleId: chosen === null ? null : id(chosen), confirmed: true });

/** Source role 10 (Unit A, root) held directly by U1; a lineage copy 11 in Unit B with the same privileges. */
function lineageWorld(over: Partial<SecuritySnapshot> = {}) {
  const roles = [role(10, 'Sales', BU_A), role(11, 'Sales', BU_B, id(10))];
  return snap({ roles, directAssignments: [{ userId: U1, roleId: id(10) }], ...over });
}
const samePrivs = [priv(10, 'account', 'Read', 'Local'), priv(11, 'account', 'Read', 'Local')];

function onlyUser(plan: ReturnType<typeof planBuMove>) {
  const u = plan.users[0];
  if (!u) throw new Error('no user plan');
  return u;
}

describe('request validation', () => {
  it('throws when the target is not in the snapshot or is disabled', () => {
    expect(() => planBuMove(snap(), [], req({ targetBusinessUnitId: id(99) }))).toThrow(BuMovePlanError);
    const disabled = snap({ businessUnits: bus.map((b) => (b.id === BU_B ? { ...b, isDisabled: true } : b)) });
    expect(() => planBuMove(disabled, [], req())).toThrow(/disabled/);
  });
});

describe('per-user status', () => {
  it('reports an unknown user without planning anything', () => {
    const p = onlyUser(planBuMove(snap(), [], req({ users: [{ userId: id(555), choices: [] }] })));
    expect(p).toMatchObject({ status: 'unknownUser', dataComplete: false });
    expect(p.decisions).toEqual([]);
  });

  it('plans nothing for a disabled user and for a user already in the target', () => {
    const disabled = snap({ users: [user(100, BU_A, { isDisabled: true })] });
    expect(onlyUser(planBuMove(disabled, [], req())).status).toBe('disabled');
    const already = snap({ users: [user(100, BU_B)] });
    expect(onlyUser(planBuMove(already, [], req())).status).toBe('alreadyInTargetBusinessUnit');
  });

  it('flags an application user for confirmation', () => {
    const s = snap({ users: [user(100, BU_A, { isApplicationUser: true })] });
    expect(onlyUser(planBuMove(s, [], req())).risks.join(' ')).toMatch(/application user/);
  });
});

describe('survival expectations', () => {
  const held = (settings: SecuritySettings, roleBu = BU_A) =>
    onlyUser(planBuMove(snap({ roles: [role(10, 'Sales', roleBu)], directAssignments: [{ userId: U1, roleId: id(10) }], settings }), [], req())).survival[0];

  it('expects retention only when ownership across BUs is on and roles are not removed', () => {
    expect(held({ ...SETTINGS_ON, doNotRemoveRolesOnChangeBusinessUnit: true })?.kind).toBe('expectedRetained');
    expect(held({ ...SETTINGS_ON, doNotRemoveRolesOnChangeBusinessUnit: false })?.kind).toBe('expectedRemoved');
    expect(held({ ...SETTINGS_ON, doNotRemoveRolesOnChangeBusinessUnit: null })?.kind).toBe('unknown');
  });

  it('is unverified when ownership across BUs is off, and unknown when it could not be read', () => {
    expect(held({ ...SETTINGS_ON, enableOwnershipAcrossBusinessUnits: false })?.kind).toBe('unverified');
    expect(held({ ...SETTINGS_ON, enableOwnershipAcrossBusinessUnits: null })?.kind).toBe('unknown');
  });

  it('is unverified for a role that belongs to another business unit than the one the user leaves', () => {
    expect(held({ ...SETTINGS_ON, doNotRemoveRolesOnChangeBusinessUnit: true }, BU_B)?.kind).toBe('unverified');
  });

  it('states every survival as an expectation, never a certainty', () => {
    expect(held(SETTINGS_ON)?.basis).toMatch(/Expected|Unverified|Unknown/);
  });
});

describe('strategy none and role selection', () => {
  it('restores nothing by default but still shows what is expected to be lost', () => {
    const p = onlyUser(planBuMove(lineageWorld(), samePrivs, req({ strategy: 'none', selection: ALL })));
    expect(p.decisions.map((d) => d.outcome)).toEqual(['notRestoring']);
    expect(p.survival).toHaveLength(1);
  });

  it('grants no role unless selected', () => {
    const p = onlyUser(planBuMove(lineageWorld(), samePrivs, req({ strategy: 'new' })));
    expect(p.decisions).toEqual([]);
  });

  it('ignores a specific role the user does not hold directly, with a risk note', () => {
    const s = lineageWorld();
    const p = onlyUser(planBuMove(s, samePrivs, req({ strategy: 'new', selection: { mode: 'specific', roleIds: [id(11)] } })));
    expect(p.decisions).toEqual([]);
    expect(p.risks.join(' ')).toMatch(/not held directly/);
  });

  it('never converts team-derived roles into direct roles', () => {
    const team: Team = { id: id(500), name: 'Support', businessUnitId: BU_A, type: 'Owner', roleIds: [id(12)] };
    const s = lineageWorld({ roles: [role(10, 'Sales', BU_A), role(11, 'Sales', BU_B, id(10)), role(12, 'Support', BU_A)], teams: [team], memberships: [{ userId: U1, teamId: team.id }] });
    const p = onlyUser(planBuMove(s, samePrivs, req({ strategy: 'new', selection: ALL })));
    expect(p.teamRoles.map((g) => g.role.name)).toEqual(['Support']);
    expect(p.decisions.map((d) => d.source.name)).toEqual(['Sales']);
    expect(p.risks.join(' ')).toMatch(/never converted to direct roles/);
  });
});

describe('matching in the target business unit (strategy new)', () => {
  const plan = (s: SecuritySnapshot, privileges: RolePrivilege[], over: Partial<BuMoveRequest> = {}) =>
    onlyUser(planBuMove(s, privileges, req({ strategy: 'new', selection: ALL, ...over })));

  it('restores a lineage copy with identical privileges', () => {
    const d = plan(lineageWorld(), samePrivs).decisions[0];
    expect(d).toMatchObject({ outcome: 'restore', chosen: { level: 'lineage', escalation: false, reducedAccess: false } });
  });

  it('accepts the same name with identical privileges when there is no lineage', () => {
    const s = snap({ roles: [role(10, 'Sales', BU_A), role(11, 'sales', BU_B)], directAssignments: [{ userId: U1, roleId: id(10) }] });
    expect(plan(s, samePrivs).decisions[0]).toMatchObject({ outcome: 'restore', chosen: { level: 'sameNameSamePrivileges' } });
  });

  it('blocks a same-name role with different privileges until confirmed, and flags escalation', () => {
    const privs = [priv(10, 'account', 'Read', 'Local'), priv(11, 'account', 'Read', 'Global')];
    const blocked = plan(lineageWorld(), privs).decisions[0];
    expect(blocked).toMatchObject({ outcome: 'blocked', blockReason: 'differentPrivilegesUnconfirmed' });
    expect(blocked?.chosen).toBeNull();
    const withChoice = plan(lineageWorld(), privs, { choices: [confirmed(10, 11)] }).decisions[0];
    expect(withChoice).toMatchObject({ outcome: 'restore', chosen: { level: 'differentPrivileges', escalation: true, reducedAccess: false } });
    expect(plan(lineageWorld(), privs, { choices: [confirmed(10, 11)] }).risks.join(' ')).toMatch(/Escalation risk/);
  });

  it('flags reduced access and needs confirmation for it', () => {
    const privs = [priv(10, 'account', 'Read', 'Global'), priv(11, 'account', 'Read', 'Local'), priv(10, 'account', 'Write', 'Local')];
    const d = plan(lineageWorld(), privs, { choices: [{ sourceRoleId: id(10), chosenRoleId: id(11), confirmed: false }] }).decisions[0];
    expect(d).toMatchObject({ outcome: 'blocked', chosen: { reducedAccess: true } });
  });

  it('offers only a suggestion for a different name with identical privileges', () => {
    const s = snap({ roles: [role(10, 'Sales', BU_A), role(11, 'Revenue', BU_B)], directAssignments: [{ userId: U1, roleId: id(10) }] });
    expect(plan(s, samePrivs).decisions[0]).toMatchObject({ outcome: 'blocked', blockReason: 'suggestionOnly' });
    expect(plan(s, samePrivs, { choices: [{ sourceRoleId: id(10), chosenRoleId: id(11), confirmed: false }] }).decisions[0]?.outcome).toBe('restore');
  });

  it('blocks as missing when the target business unit has no related role', () => {
    const s = snap({ roles: [role(10, 'Sales', BU_A)], directAssignments: [{ userId: U1, roleId: id(10) }] });
    expect(plan(s, []).decisions[0]).toMatchObject({ outcome: 'blocked', blockReason: 'missing' });
  });

  it('blocks as ambiguous when two roles match equally well, and accepts an explicit choice', () => {
    const s = snap({ roles: [role(10, 'Sales', BU_A), role(11, 'Sales', BU_B), role(12, 'Sales', BU_B)], directAssignments: [{ userId: U1, roleId: id(10) }] });
    const privs = [priv(10, 'account', 'Read', 'Local'), priv(11, 'account', 'Read', 'Local'), priv(12, 'account', 'Read', 'Local')];
    expect(plan(s, privs).decisions[0]).toMatchObject({ outcome: 'blocked', blockReason: 'ambiguous' });
    expect(plan(s, privs, { choices: [{ sourceRoleId: id(10), chosenRoleId: id(12), confirmed: false }] }).decisions[0]?.chosen?.role.id).toBe(id(12));
  });

  it('rejects a chosen role that is not among the candidates of the selected business unit', () => {
    const d = plan(lineageWorld(), samePrivs, { choices: [{ sourceRoleId: id(10), chosenRoleId: id(10), confirmed: true }] }).decisions[0];
    expect(d).toMatchObject({ outcome: 'blocked', blockReason: 'invalidChoice' });
  });

  it('needs confirmation for every match when the privilege data is incomplete', () => {
    const blocked = onlyUser(planBuMove(lineageWorld(), samePrivs, req({ strategy: 'new', selection: ALL }), false));
    expect(blocked.decisions[0]).toMatchObject({ outcome: 'blocked', blockReason: 'privilegeDataIncomplete' });
    expect(blocked.dataComplete).toBe(false);
    const ok = onlyUser(planBuMove(lineageWorld(), samePrivs, req({ strategy: 'new', selection: ALL, choices: [confirmed(10)] }), false));
    expect(ok.decisions[0]?.outcome).toBe('restore');
  });

  it('marks two source roles that resolve to the same target role as a duplicate mapping', () => {
    const s = snap({
      roles: [role(10, 'Sales', BU_A), role(13, 'Sales Lead', BU_A, id(10)), role(11, 'Sales', BU_B, id(10))],
      directAssignments: [{ userId: U1, roleId: id(10) }, { userId: U1, roleId: id(13) }],
    });
    const privs = [priv(10, 'account', 'Read', 'Local'), priv(13, 'account', 'Read', 'Local'), priv(11, 'account', 'Read', 'Local')];
    const decisions = plan(s, privs).decisions;
    expect(decisions.filter((d) => d.outcome === 'restore')).toHaveLength(2);
    expect(decisions.every((d) => d.duplicateMapping)).toBe(true);
    expect(plan(s, privs).expectedOutcome).toMatch(/1 role\(s\) planned to be assigned/);
  });

  it('a per-user choice wins over a batch choice for the same source role', () => {
    const privs = [priv(10, 'account', 'Read', 'Local'), priv(11, 'account', 'Read', 'Local')];
    const s = snap({ roles: [role(10, 'Sales', BU_A), role(11, 'Sales', BU_B), role(12, 'Sales', BU_B)], directAssignments: [{ userId: U1, roleId: id(10) }] });
    const privs3 = [...privs, priv(12, 'account', 'Read', 'Local')];
    const d = onlyUser(planBuMove(s, privs3, req({ strategy: 'new', selection: ALL, choices: [confirmed(10, 11)], users: [{ userId: U1, choices: [confirmed(10, 12)] }] }))).decisions[0];
    expect(d?.chosen?.role.id).toBe(id(12));
  });
});

describe('strategy keep, root and custom', () => {
  it('keep is unavailable when ownership across business units is off or unknown', () => {
    for (const v of [false, null]) {
      const s = lineageWorld({ settings: { ...SETTINGS_ON, enableOwnershipAcrossBusinessUnits: v } });
      expect(onlyUser(planBuMove(s, samePrivs, req({ strategy: 'keep', selection: ALL }))).decisions[0]).toMatchObject({ outcome: 'blocked', blockReason: 'keepUnavailable' });
    }
  });

  it('keep assigns the original role again, or skips it when it is expected to be retained', () => {
    const restore = onlyUser(planBuMove(lineageWorld(), samePrivs, req({ strategy: 'keep', selection: ALL })));
    expect(restore.decisions[0]).toMatchObject({ outcome: 'restore', chosen: { role: { id: id(10) }, level: 'lineage' } });
    const retained = lineageWorld({ settings: { ...SETTINGS_ON, doNotRemoveRolesOnChangeBusinessUnit: true } });
    expect(onlyUser(planBuMove(retained, samePrivs, req({ strategy: 'keep', selection: ALL }))).decisions[0]?.outcome).toBe('skipRetained');
  });

  it('root draws candidates from the root business unit, and is blocked when there is no single root', () => {
    const s = snap({ roles: [role(10, 'Sales', BU_A), role(14, 'Sales', ROOT)], directAssignments: [{ userId: U1, roleId: id(10) }] });
    const privs = [priv(10, 'account', 'Read', 'Local'), priv(14, 'account', 'Read', 'Local')];
    expect(onlyUser(planBuMove(s, privs, req({ strategy: 'root', selection: ALL }))).decisions[0]?.chosen?.role.id).toBe(id(14));
    const noRoot = snap({ ...s, businessUnits: bus.map((b) => ({ ...b, parentId: b.id === ROOT ? id(2) : b.parentId })) });
    const p = planBuMove(noRoot, privs, req({ strategy: 'root', selection: ALL }));
    expect(onlyUser(p).decisions[0]).toMatchObject({ outcome: 'blocked', blockReason: 'rootUnavailable' });
    expect(p.warnings.join(' ')).toMatch(/root business unit/);
  });

  it('custom needs a choice, rejects a missing role, and compares a freely chosen role', () => {
    const s = lineageWorld({ roles: [role(10, 'Sales', BU_A), role(11, 'Other', BU_B)] });
    const privs = [priv(10, 'account', 'Read', 'Local'), priv(11, 'account', 'Read', 'Global')];
    const run = (choices: RoleChoice[]) => onlyUser(planBuMove(s, privs, req({ strategy: 'custom', selection: ALL, choices }))).decisions[0];
    expect(run([])).toMatchObject({ blockReason: 'needsChoice' });
    expect(run([confirmed(10, 99)])).toMatchObject({ blockReason: 'invalidChoice' });
    expect(run([{ sourceRoleId: id(10), chosenRoleId: id(11), confirmed: false }])).toMatchObject({ outcome: 'blocked', blockReason: 'differentPrivilegesUnconfirmed' });
    expect(run([confirmed(10, 11)])).toMatchObject({ outcome: 'restore', chosen: { escalation: true } });
  });

  it('a dialog confirmation without the comparison on screen does not count', async () => {
    const { choiceFromDialog } = await import('./types');
    expect(choiceFromDialog(id(10), id(11), true, false).confirmed).toBe(false);
    expect(choiceFromDialog(id(10), id(11), true, true).confirmed).toBe(true);
  });
});

describe('context and risks', () => {
  it('describes default-team effects and the documented target-role requirement', () => {
    const defA: Team = { id: id(600), name: 'Unit A', businessUnitId: BU_A, type: 'Default', roleIds: [id(10)] };
    const defB: Team = { id: id(601), name: 'Unit B', businessUnitId: BU_B, type: 'Default', roleIds: [id(11)] };
    const s = lineageWorld({ teams: [defA, defB] });
    const p = onlyUser(planBuMove(s, samePrivs, req()));
    const text = p.risks.join('\n');
    expect(text).toMatch(/stop applying: Sales/);
    expect(text).toMatch(/start applying: Sales/);
    expect(text).toMatch(/No role of Unit B is planned/);
    expect(p.defaultTeamBefore?.roles.map((r) => r.id)).toEqual([id(10)]);
  });

  it('marks a default team that reports an unknown role as incomplete, never as "no access"', () => {
    const defB: Team = { id: id(601), name: 'Unit B', businessUnitId: BU_B, type: 'Default', roleIds: [id(11), id(999)] };
    const p = onlyUser(planBuMove(lineageWorld({ teams: [defB] }), samePrivs, req()));
    expect(p.dataComplete).toBe(false);
    expect(p.defaultTeamAfter?.unresolvedRoleIds).toEqual([id(999)]);
    expect(p.risks.join(' | ')).toMatch(/Data gap: the default team of Unit B \(which the user joins\)/);
    const before: Team = { id: id(602), name: 'Unit A', businessUnitId: BU_A, type: 'Default', roleIds: [id(998)] };
    const q = onlyUser(planBuMove(lineageWorld({ teams: [before] }), samePrivs, req()));
    expect(q.dataComplete).toBe(false);
    expect(q.risks.join(' | ')).toMatch(/\(which the user leaves\)/);
  });

  it('does not warn about a missing target role once a restore into the target is planned', () => {
    const p = onlyUser(planBuMove(lineageWorld(), samePrivs, req({ strategy: 'new', selection: ALL })));
    expect(p.risks.join('\n')).not.toMatch(/No role of Unit B is planned/);
  });

  it('describes record ownership consequences from the setting, including unknown', () => {
    const text = (v: boolean | null) => onlyUser(planBuMove(snap({ settings: { ...SETTINGS_ON, alwaysMoveRecordToOwnerBusinessUnit: v } }), [], req())).risks[0];
    expect(text(true)).toMatch(/expected to move/);
    expect(text(false)).toMatch(/expected to stay/);
    expect(text(null)).toMatch(/Unknown whether/);
  });

  it('carries data gaps and settings notes into the plan and into the user risks', () => {
    const s = snap({ warnings: ['3 role rows missing'], settings: { ...SETTINGS_ON, notes: ['Setting X read from default'] } });
    const plan = planBuMove(s, [], req());
    expect(plan.warnings).toEqual(expect.arrayContaining(['Data gap: 3 role rows missing', 'Setting X read from default']));
    expect(onlyUser(plan).dataComplete).toBe(false);
  });

  it('always lists what cannot be verified before the move, plus unreadable settings', () => {
    const p = onlyUser(planBuMove(snap({ settings: { ...SETTINGS_ON, enableOwnershipAcrossBusinessUnits: null } }), [], req()));
    expect(p.cannotVerifyBeforeMove.length).toBeGreaterThan(5);
    expect(p.cannotVerifyBeforeMove.join(' ')).toMatch(/could not be read/);
  });

  it('is deterministic: the same inputs give the same plan', () => {
    const a = JSON.stringify(planBuMove(lineageWorld(), samePrivs, req({ strategy: 'new', selection: ALL })));
    const b = JSON.stringify(planBuMove(lineageWorld(), samePrivs, req({ strategy: 'new', selection: ALL })));
    expect(a).toBe(b);
  });
});

// Keeps the RestoreStrategy import meaningful for the compiler and documents the full set.
const ALL_STRATEGIES: RestoreStrategy[] = ['none', 'keep', 'new', 'root', 'custom'];
describe('strategies', () => {
  it('every strategy produces a plan without throwing', () => {
    for (const strategy of ALL_STRATEGIES) expect(() => planBuMove(lineageWorld(), samePrivs, req({ strategy, selection: ALL }))).not.toThrow();
  });
});
