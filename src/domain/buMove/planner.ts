import type { GrantDepth } from '../operations';
import type { PrivilegeId } from '../privileges';
import {
  ASSIGNABILITY_NOTE,
  MATCH_ORDER,
  type BlockReason,
  type BuMovePlan,
  type BuMoveRequest,
  type BusinessUnit,
  type DecisionOutcome,
  type DefaultTeamView,
  type MatchLevel,
  type PrivilegeDifferenceLine,
  type RestoreStrategy,
  type Role,
  type RoleCandidate,
  type RoleChoice,
  type RoleDecision,
  type RoleGrant,
  type RolePrivilege,
  type RoleSelection,
  type SecuritySnapshot,
  type SurvivalExpectation,
  type UserAccess,
  type UserMovePlan,
  type UserMoveRequest,
  type UserMoveStatus,
  type UserSummary,
} from './types';
import { buName, cmp, explainUserAccess } from './userAccess';

// Plans (dry run) the Business Unit move of users and what happens to their direct roles. Pure logic over a snapshot: it issues no
// request and has no write flag. Roles are matched by id, lineage and privileges, never by name alone; a same-name role with different
// privileges is a warning that needs confirmation; nothing is substituted silently and no role is granted unless it was selected.
// Behaviour that Microsoft documents only conditionally is stated as an expectation with its basis.
// Business Unit move planner: when a user moves, which roles are expected to survive and which are assigned again in the target unit. Real-environment behaviour is UNVERIFIED
// until the approved write-test plan (S3) runs.

export const ALWAYS_CANNOT_VERIFY: readonly string[] = [
  'What happens to roles when record ownership across business units is off (the documentation describes the settings only for the on case).',
  "Side effects on the user's manager and direct reports (documented for the deprecated SetBusinessSystemUser message, unverified for the update operation).",
  'Plug-in or workflow side effects in the environment.',
  'Whether you may assign each role (managed state and cross-business-unit assignment rights are not checked).',
  'Whether matched roles hold the same miscellaneous (non-table) privileges: only table privileges are read and compared, so an identical match is identical on table privileges only.',
];

/** Thrown when the request itself is invalid (target missing or disabled); nothing is planned. */
export class BuMovePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuMovePlanError';
  }
}

const DEPTH_RANK: Record<GrantDepth, number> = { Basic: 1, Local: 2, Deep: 3, Global: 4 };

type PrivilegeIndex = ReadonlyMap<string, ReadonlyMap<string, GrantDepth>>;

function privilegeKey(entity: string, operation: PrivilegeId): string {
  return `${entity.toLowerCase()}|${operation}`;
}

function indexPrivileges(privileges: readonly RolePrivilege[]): PrivilegeIndex {
  const map = new Map<string, Map<string, GrantDepth>>();
  for (const p of privileges) {
    let role = map.get(p.roleId);
    if (!role) map.set(p.roleId, (role = new Map()));
    const key = privilegeKey(p.entity, p.operation);
    const existing = role.get(key);
    if (!existing || DEPTH_RANK[p.depth] > DEPTH_RANK[existing]) role.set(key, p.depth);
  }
  return map;
}

function privilegesOf(index: PrivilegeIndex, roleId: string): ReadonlyMap<string, GrantDepth> {
  return index.get(roleId) ?? new Map();
}

function splitKey(key: string): { entity: string; operation: PrivilegeId } {
  const i = key.lastIndexOf('|');
  return { entity: key.slice(0, i), operation: key.slice(i + 1) as PrivilegeId };
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- survival (what the move is expected to do to each current direct role) ------------------------------------------------

function survival(s: SecuritySnapshot, user: UserSummary, grant: RoleGrant): SurvivalExpectation {
  const settings = s.settings;
  const base = { role: grant.role, roleBusinessUnitName: grant.roleBusinessUnitName };
  if (grant.role.businessUnitId !== user.businessUnitId) {
    return {
      ...base,
      kind: 'unverified',
      basis:
        'Unverified: the documentation states retention only for roles of the business unit the user is leaving; this role belongs to another business unit. Planned as removed.',
    };
  }
  if (settings.enableOwnershipAcrossBusinessUnits === true) {
    if (settings.doNotRemoveRolesOnChangeBusinessUnit === true) {
      return {
        ...base,
        kind: 'expectedRetained',
        basis: 'Expected to be retained (documented behaviour: record ownership across business units is on and DoNotRemoveRolesOnChangeBusinessUnit is true).',
      };
    }
    if (settings.doNotRemoveRolesOnChangeBusinessUnit === false) {
      return {
        ...base,
        kind: 'expectedRemoved',
        basis:
          'Expected to be removed by the move (documented behaviour: record ownership across business units is on and DoNotRemoveRolesOnChangeBusinessUnit is false).',
      };
    }
    return { ...base, kind: 'unknown', basis: 'Unknown: DoNotRemoveRolesOnChangeBusinessUnit could not be read. Planned as removed.' };
  }
  if (settings.enableOwnershipAcrossBusinessUnits === false) {
    return {
      ...base,
      kind: 'unverified',
      basis:
        'Unverified: record ownership across business units is off; the documentation says roles can be removed but does not describe the settings for this case. Planned as removed.',
    };
  }
  return { ...base, kind: 'unknown', basis: 'Unknown: whether record ownership across business units is on could not be read. Planned as removed.' };
}

function expectedRetained(s: SecuritySnapshot, user: UserSummary, role: Role): boolean {
  return (
    role.businessUnitId === user.businessUnitId &&
    s.settings.enableOwnershipAcrossBusinessUnits === true &&
    s.settings.doNotRemoveRolesOnChangeBusinessUnit === true
  );
}

// ---- matching (evidence ladder) ---------------------------------------------------------------------------------------------

const lineageShared = (a: Role, b: Role): boolean => (a.parentRootRoleId ?? a.id) === (b.parentRootRoleId ?? b.id);

/** Null when the role is unrelated (no lineage, name or privilege evidence) and `explicitChoice` is false. */
function evaluate(index: PrivilegeIndex, source: Role, candidate: Role, explicitChoice: boolean): RoleCandidate | null {
  const ps = privilegesOf(index, source.id);
  const pc = privilegesOf(index, candidate.id);
  const diffs: PrivilegeDifferenceLine[] = [];
  let escalation = false;
  let reduced = false;
  for (const key of [...new Set([...ps.keys(), ...pc.keys()])].sort(ordinal)) {
    const sd = ps.get(key);
    const cd = pc.get(key);
    if (sd !== undefined && cd !== undefined && sd === cd) continue;
    const { entity, operation } = splitKey(key);
    diffs.push({ entity, operation, sourceDepth: sd ?? null, candidateDepth: cd ?? null });
    if (cd !== undefined && (sd === undefined || DEPTH_RANK[cd] > DEPTH_RANK[sd])) escalation = true;
    if (sd !== undefined && (cd === undefined || DEPTH_RANK[cd] < DEPTH_RANK[sd])) reduced = true;
  }
  const identical = diffs.length === 0;
  const lineage = source.id === candidate.id || lineageShared(source, candidate);
  const sameName = (source.name ?? '').trim().toLowerCase() === (candidate.name ?? '').trim().toLowerCase();

  let level: MatchLevel;
  if (identical) level = lineage ? 'lineage' : sameName ? 'sameNameSamePrivileges' : 'suggestionOnly';
  else if (lineage || sameName || explicitChoice) level = 'differentPrivileges';
  else return null;
  return { role: candidate, businessUnitName: '', level, differences: diffs, escalation, reducedAccess: reduced };
}

function named(s: SecuritySnapshot, c: RoleCandidate): RoleCandidate {
  return { ...c, businessUnitName: buName(s, c.role.businessUnitId) };
}

function pool(s: SecuritySnapshot, index: PrivilegeIndex, source: Role, roles: readonly Role[]): RoleCandidate[] {
  const list: RoleCandidate[] = [];
  for (const role of roles) {
    const c = evaluate(index, source, role, false);
    if (c) list.push(named(s, c));
  }
  return list;
}

const holdsDirectly = (s: SecuritySnapshot, userId: string, roleId: string): boolean =>
  s.directAssignments.some((a) => a.userId === userId && a.roleId === roleId);

function decide(
  s: SecuritySnapshot,
  index: PrivilegeIndex,
  strategy: RestoreStrategy,
  source: Role,
  user: UserSummary,
  target: BusinessUnit,
  root: BusinessUnit | null,
  choice: RoleChoice | undefined,
  privilegesComplete: boolean,
): RoleDecision {
  const srcBu = buName(s, source.businessUnitId);
  const make = (
    outcome: DecisionOutcome,
    blockReason: BlockReason,
    chosen: RoleCandidate | null,
    candidates: readonly RoleCandidate[],
    explanation: string,
  ): RoleDecision => ({ source, sourceBusinessUnitName: srcBu, outcome, blockReason, chosen, candidates, duplicateMapping: false, explanation });

  if (strategy === 'none') {
    return make('notRestoring', 'none', null, [], "Strategy 'none': this role is not restored. See the survival expectation for what the move is expected to do to it.");
  }

  let candidates: RoleCandidate[];
  switch (strategy) {
    case 'keep':
      if (s.settings.enableOwnershipAcrossBusinessUnits !== true) {
        return make(
          'blocked',
          'keepUnavailable',
          null,
          [],
          s.settings.enableOwnershipAcrossBusinessUnits === false
            ? 'Keeping the original role needs record ownership across business units, which is off. Choose another strategy.'
            : 'Whether record ownership across business units is on could not be read, so keeping the original role cannot be offered. Choose another strategy.',
        );
      }
      candidates = [named(s, evaluate(index, source, source, true) as RoleCandidate)];
      break;
    case 'new':
      candidates = pool(s, index, source, s.roles.filter((r) => r.businessUnitId === target.id));
      break;
    case 'root':
      if (!root) return make('blocked', 'rootUnavailable', null, [], 'The root business unit could not be determined.');
      candidates = pool(s, index, source, s.roles.filter((r) => r.businessUnitId === root.id));
      break;
    default: {
      // custom: the user picks the role and its business unit
      if (!choice || !choice.chosenRoleId) return make('blocked', 'needsChoice', null, [], 'Custom strategy: choose the role to assign for this source role.');
      const picked = s.roles.find((r) => r.id === choice.chosenRoleId);
      if (!picked) return make('blocked', 'invalidChoice', null, [], 'The chosen role does not exist.');
      candidates = [named(s, evaluate(index, source, picked, true) as RoleCandidate)];
    }
  }
  candidates.sort((a, b) => MATCH_ORDER[a.level] - MATCH_ORDER[b.level] || cmp(a.role.name, b.role.name) || cmp(a.role.id, b.role.id));

  let selected: RoleCandidate;
  if (strategy === 'keep' || strategy === 'custom') {
    selected = candidates[0] as RoleCandidate;
  } else if (choice?.chosenRoleId) {
    const found = candidates.find((c) => c.role.id === choice.chosenRoleId);
    if (!found) return make('blocked', 'invalidChoice', null, candidates, 'The chosen role is not one of the candidates in the selected business unit.');
    selected = found;
  } else {
    if (candidates.length === 0) return make('blocked', 'missing', null, candidates, 'No role related to this one exists in the selected business unit.');
    const best = (candidates[0] as RoleCandidate).level;
    const atBest = candidates.filter((c) => c.level === best);
    if (best === 'suggestionOnly') {
      return make('blocked', 'suggestionOnly', null, candidates, 'Only a suggestion exists: a role with a different name and identical privileges. Choose it explicitly to use it.');
    }
    if (best === 'differentPrivileges') {
      return make('blocked', 'differentPrivilegesUnconfirmed', null, candidates, 'A role with the same name or lineage exists but its privileges differ. Review the differences and confirm a choice.');
    }
    if (atBest.length > 1) return make('blocked', 'ambiguous', null, candidates, 'More than one role matches equally well. Choose one.');
    selected = atBest[0] as RoleCandidate;
  }

  const needsConfirmation = selected.level === 'differentPrivileges' || selected.escalation || selected.reducedAccess;
  if (needsConfirmation && !choice?.confirmed) {
    return make(
      'blocked',
      selected.level === 'differentPrivileges' ? 'differentPrivilegesUnconfirmed' : 'escalationOrReductionUnconfirmed',
      selected,
      candidates,
      `The chosen role's privileges differ from the original${selected.escalation ? ' and include more access (escalation risk)' : ''}${selected.reducedAccess ? ' and include less access (reduced access)' : ''}. Confirm to use it.`,
    );
  }

  if (!privilegesComplete && !choice?.confirmed) {
    return make(
      'blocked',
      'privilegeDataIncomplete',
      selected,
      candidates,
      `The privileges of the roles could not be read completely, so the match with ${selected.role.name} cannot be trusted. Confirm to use it anyway.`,
    );
  }

  if (expectedRetained(s, user, selected.role) && holdsDirectly(s, user.id, selected.role.id)) {
    return make('skipRetained', 'none', selected, candidates, 'Expected to be retained by the move, so it is not assigned again.');
  }
  return make(
    'restore',
    'none',
    selected,
    candidates,
    'Planned to be assigned after the move. After the move the actual roles are re-read and only what is then missing is assigned.',
  );
}

function markDuplicates(decisions: readonly RoleDecision[]): RoleDecision[] {
  const counts = new Map<string, number>();
  for (const d of decisions) {
    if (d.chosen && (d.outcome === 'restore' || d.outcome === 'skipRetained')) counts.set(d.chosen.role.id, (counts.get(d.chosen.role.id) ?? 0) + 1);
  }
  return decisions.map((d) =>
    d.chosen && (d.outcome === 'restore' || d.outcome === 'skipRetained') && (counts.get(d.chosen.role.id) ?? 0) > 1
      ? { ...d, duplicateMapping: true, explanation: `${d.explanation} Duplicate mapping: another source role resolves to the same role; it is assigned once.` }
      : d,
  );
}

// ---- context: default teams, risks, outcome ---------------------------------------------------------------------------------

function defaultTeam(s: SecuritySnapshot, businessUnitId: string): DefaultTeamView {
  const team = s.teams.find((t) => t.type === 'Default' && t.businessUnitId === businessUnitId);
  const ids = team ? [...new Set(team.roleIds)] : [];
  const roles = ids.flatMap((id) => s.roles.filter((r) => r.id === id));
  const unresolvedRoleIds = ids.filter((id) => !s.roles.some((r) => r.id === id));
  return { businessUnitName: buName(s, businessUnitId), roles, unresolvedRoleIds };
}

function moveRisks(
  s: SecuritySnapshot,
  fromName: string,
  target: BusinessUnit,
  decisions: readonly RoleDecision[],
  access: UserAccess,
  before: DefaultTeamView,
  after: DefaultTeamView,
): string[] {
  const out: string[] = [];
  const settings = s.settings;
  if (settings.alwaysMoveRecordToOwnerBusinessUnit === true) {
    out.push(`Records owned by the user are expected to move to ${target.name} (documented behaviour when record ownership across business units is on).`);
  } else if (settings.alwaysMoveRecordToOwnerBusinessUnit === false) {
    out.push(`Records owned by the user are expected to stay in ${fromName}; the user cannot access them without a role from that business unit (documented behaviour).`);
  } else {
    out.push(`Unknown whether records owned by the user move to ${target.name} (the setting could not be read).`);
  }
  out.push(`The user leaves the default team of ${fromName} and joins the default team of ${target.name} automatically (documented).`);
  for (const [label, view] of [['leaves', before], ['joins', after]] as const) {
    if (view.unresolvedRoleIds.length > 0) {
      out.push(
        `Data gap: the default team of ${view.businessUnitName} (which the user ${label}) reports ${view.unresolvedRoleIds.length} role(s) that are not in the role list, so its access is unknown, not "none".`,
      );
    }
  }
  if (before.roles.length > 0) out.push(`Roles carried by the default team of ${fromName} stop applying: ${before.roles.map((r) => r.name).join(', ')}.`);
  if (after.roles.length > 0) out.push(`Roles carried by the default team of ${target.name} start applying: ${after.roles.map((r) => r.name).join(', ')}.`);
  if (access.teamRoles.length > 0) out.push("The user's other team memberships and their roles are not changed by the move and are never converted to direct roles.");

  for (const d of decisions) {
    if (d.outcome === 'blocked') out.push(`Blocked: ${d.source.name} - ${d.explanation}`);
    if (d.chosen?.escalation) out.push(`Escalation risk: ${d.chosen.role.name} has more access than ${d.source.name}.`);
    if (d.chosen?.reducedAccess) out.push(`Reduced access: ${d.chosen.role.name} has less access than ${d.source.name}.`);
  }

  // Based on what is expected after the move, not on what is held now: a role of the target business unit that the user holds today is
  // planned as removed (see survival), so it does not count unless a restore brings it back.
  const plannedInTarget = decisions.some(
    (d) => (d.outcome === 'restore' || d.outcome === 'skipRetained') && d.chosen !== null && d.chosen.role.businessUnitId === target.id,
  );
  if (!plannedInTarget) out.push(`No role of ${target.name} is planned. Microsoft documents that at least one security role from the new business unit must be assigned to the user.`);
  return out;
}

function expectedOutcomeText(
  user: UserSummary,
  target: BusinessUnit,
  strategy: RestoreStrategy,
  surv: readonly SurvivalExpectation[],
  decisions: readonly RoleDecision[],
): string {
  const restore = new Set(decisions.filter((d) => d.outcome === 'restore').map((d) => (d.chosen as RoleCandidate).role.id)).size;
  // Retention is a property of the current roles and the settings, whatever is selected for restore, so it is counted from the survival expectations.
  const skip = surv.filter((x) => x.kind === 'expectedRetained').length;
  const blocked = decisions.filter((d) => d.outcome === 'blocked').length;
  const lost = surv.filter((x) => x.kind !== 'expectedRetained').length;
  return (
    `${user.fullName} would move to ${target.name} (strategy: ${strategy}). ` +
    `${lost} of ${surv.length} direct role(s) are expected or assumed to be removed, ` +
    `${restore} role(s) planned to be assigned, ${skip} expected to be retained, ${blocked} blocked. These are expectations, not guarantees.`
  );
}

// ---- per user ---------------------------------------------------------------------------------------------------------------

function selectSources(access: UserAccess, selection: RoleSelection, risks: string[]): readonly RoleGrant[] {
  switch (selection.mode) {
    case 'allDirectRoles':
      return access.directRoles;
    case 'specific': {
      for (const id of selection.roleIds.filter((rid) => access.directRoles.every((g) => g.role.id !== rid))) {
        risks.push(`Selected role ${id} is not held directly by this user and is ignored.`);
      }
      return access.directRoles.filter((g) => selection.roleIds.includes(g.role.id));
    }
    default:
      return [];
  }
}

const lastChoice = (choices: readonly RoleChoice[], sourceRoleId: string): RoleChoice | undefined =>
  [...choices].reverse().find((c) => c.sourceRoleId === sourceRoleId);

function short(
  user: UserSummary,
  status: UserMoveStatus,
  text: string,
  from: string,
  target: BusinessUnit,
  strategy: RestoreStrategy,
  access: UserAccess,
  risks: string[],
): UserMovePlan {
  return {
    user,
    status,
    statusText: text,
    currentBusinessUnit: from,
    targetBusinessUnit: target.name,
    strategy,
    directRoles: access.directRoles,
    teamRoles: access.teamRoles,
    survival: [],
    decisions: [],
    defaultTeamBefore: null,
    defaultTeamAfter: null,
    risks: [text, ...risks],
    cannotVerifyBeforeMove: [],
    expectedOutcome: text,
    dataComplete: access.isComplete,
  };
}

function planUser(
  s: SecuritySnapshot,
  index: PrivilegeIndex,
  req: BuMoveRequest,
  ureq: UserMoveRequest,
  target: BusinessUnit,
  root: BusinessUnit | null,
  privilegesComplete: boolean,
): UserMovePlan {
  const strategy = ureq.strategy ?? req.strategy;
  const user = s.users.find((u) => u.id === ureq.userId);
  if (!user) {
    const unknown: UserSummary = { id: ureq.userId, fullName: '(unknown user)', email: '', businessUnitId: '', isDisabled: false, isApplicationUser: false };
    return {
      user: unknown,
      status: 'unknownUser',
      statusText: 'The user is not in the environment data.',
      currentBusinessUnit: null,
      targetBusinessUnit: target.name,
      strategy,
      directRoles: [],
      teamRoles: [],
      survival: [],
      decisions: [],
      defaultTeamBefore: null,
      defaultTeamAfter: null,
      risks: ['The user id was not found; nothing is planned.'],
      cannotVerifyBeforeMove: [],
      expectedOutcome: 'Nothing planned: unknown user.',
      dataComplete: false,
    };
  }

  const access = explainUserAccess(s, user.id);
  const fromName = buName(s, user.businessUnitId);
  const risks: string[] = [];
  if (!access.isComplete) risks.push(...access.warnings);

  if (user.isDisabled) return short(user, 'disabled', 'The user is disabled; no move is planned.', fromName, target, strategy, access, risks);
  if (user.businessUnitId === target.id) {
    return short(user, 'alreadyInTargetBusinessUnit', 'The user is already in the target business unit; nothing to move.', fromName, target, strategy, access, risks);
  }
  if (user.isApplicationUser) risks.push('This is an application user: confirm that moving it is intended.');

  const surv = access.directRoles.map((g) => survival(s, user, g));
  const selection = ureq.selection ?? req.selection;
  const sources = selectSources(access, selection, risks);
  const decisions = markDuplicates(
    sources.map((g) => decide(s, index, strategy, g.role, user, target, root, lastChoice(ureq.choices, g.role.id) ?? lastChoice(req.choices, g.role.id), privilegesComplete)),
  );

  const before = defaultTeam(s, user.businessUnitId);
  const after = defaultTeam(s, target.id);
  risks.push(...moveRisks(s, fromName, target, decisions, access, before, after));
  const cannot = [...ALWAYS_CANNOT_VERIFY];
  if (s.settings.enableOwnershipAcrossBusinessUnits === null) cannot.push('Whether record ownership across business units is enabled (the setting could not be read).');
  return {
    user,
    status: 'ready',
    statusText: 'Ready to plan.',
    currentBusinessUnit: fromName,
    targetBusinessUnit: target.name,
    strategy,
    directRoles: access.directRoles,
    teamRoles: access.teamRoles,
    survival: surv,
    decisions,
    defaultTeamBefore: before,
    defaultTeamAfter: after,
    risks,
    cannotVerifyBeforeMove: cannot,
    expectedOutcome: expectedOutcomeText(user, target, strategy, surv, decisions),
    dataComplete: access.isComplete && privilegesComplete && before.unresolvedRoleIds.length === 0 && after.unresolvedRoleIds.length === 0,
  };
}

/**
 * @param privilegesComplete False when the privilege data has gaps (rows that could not be read). Roles are then compared on incomplete
 * data, so no match is accepted without an explicit confirmation.
 */
export function planBuMove(
  snapshot: SecuritySnapshot,
  privileges: readonly RolePrivilege[],
  request: BuMoveRequest,
  privilegesComplete = true,
): BuMovePlan {
  const target = snapshot.businessUnits.find((b) => b.id === request.targetBusinessUnitId);
  if (!target) throw new BuMovePlanError('The target business unit is not in the snapshot.');
  // Dataverse refuses to move a user into a disabled business unit: say so now instead of failing user by user during the execution.
  if (target.isDisabled) throw new BuMovePlanError(`The target business unit '${target.name}' is disabled; users cannot be moved into it. Choose another business unit.`);

  const index = indexPrivileges(privileges);
  const roots = snapshot.businessUnits.filter((b) => b.parentId === null);
  const warnings = snapshot.warnings.map((w) => `Data gap: ${w}`);
  warnings.push(...snapshot.settings.notes);
  if (!privilegesComplete) warnings.push('The privilege data could not be read completely: role matches cannot be compared reliably and each needs your confirmation.');
  if (roots.length !== 1) warnings.push(roots.length === 0 ? 'No root business unit was found.' : 'More than one root business unit was found.');

  const root = roots.length === 1 ? (roots[0] as BusinessUnit) : null;
  const users = request.users.map((u) => planUser(snapshot, index, request, u, target, root, privilegesComplete));
  return { targetBusinessUnitId: target.id, targetBusinessUnitName: target.name, settings: snapshot.settings, users, warnings };
}

export { ASSIGNABILITY_NOTE };
