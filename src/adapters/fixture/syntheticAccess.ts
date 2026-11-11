import type { Person, TeamNode } from '../../domain/access';
import type { CellValue, PrivilegeId } from '../../domain/privileges';

// Synthetic assignments: fictional people and teams (no customer or legacy material). The overlap is deliberate:
// Ann holds "Project Contributor" directly AND through two teams, Cara directly and through one, one member is an
// application user and one direct user is disabled (both listed, neither counted as a person).

export const BU_HQ = { id: 'bu-hq', name: 'Contoso' } as const;
export const BU_NORTH = { id: 'bu-north', name: 'North' } as const;

const person = (userId: string, name: string, status: Person['status'] = 'Enabled'): Person => ({ userId, name, status });

export const ANN = person('u-ann', 'Ann Admin');
export const BEN = person('u-ben', 'Ben Brooks');
export const CARA = person('u-cara', 'Cara Cole');
export const DAN = person('u-dan', 'Dan Dixon');
export const EVA = person('u-eva', 'Eva Ellis');
export const FINN = person('u-finn', 'Finn Fox', 'Disabled');
export const SVC = person('u-svc', 'Svc Integration', 'ApplicationUser');
/** A membership row whose user record was not read (partial data). */
export const GHOST = person('u-ghost', 'Unknown user (record not read)', 'Unresolved');

const team = (teamId: string, name: string, businessUnitId: string, members: readonly Person[]): TeamNode => ({
  teamId,
  name,
  teamType: 'Owner',
  businessUnitId,
  members,
});

export const T_DELIVERY = team('t-delivery', 'Project Delivery', BU_HQ.id, [ANN, CARA, DAN, SVC]);
export const T_LEADS = team('t-leads', 'Regional Leads', BU_NORTH.id, [ANN, EVA]);
/** The same team with a membership row that could not be resolved (used on the partial-data table). */
export const T_DELIVERY_PARTIAL = team('t-delivery', 'Project Delivery', BU_HQ.id, [ANN, CARA, DAN, SVC, GHOST]);

export interface InstanceSeed {
  readonly roleId: string;
  readonly businessUnit: { readonly id: string; readonly name: string };
  /** Privileges that differ from the logical role's base cells (a changed Business Unit copy). */
  readonly cellOverrides?: Readonly<Partial<Record<PrivilegeId, CellValue>>>;
  readonly directUsers: readonly Person[];
  readonly teams: readonly TeamNode[];
}

/** Business Unit copies per logical (root) role id. Roles without an entry have one empty HQ instance. */
export const INSTANCE_SEEDS: Readonly<Record<string, readonly InstanceSeed[]>> = {
  'r-admin': [{ roleId: 'r-admin', businessUnit: BU_HQ, directUsers: [ANN], teams: [] }],
  'r-contrib': [
    { roleId: 'r-contrib', businessUnit: BU_HQ, directUsers: [ANN, CARA], teams: [T_DELIVERY, T_LEADS] },
    {
      roleId: 'r-contrib-north',
      businessUnit: BU_NORTH,
      cellOverrides: { Delete: { kind: 'depth', depth: 'Local' } },
      directUsers: [BEN, FINN],
      teams: [T_LEADS],
    },
  ],
  'r-reader': [{ roleId: 'r-reader', businessUnit: BU_HQ, directUsers: [], teams: [T_DELIVERY] }],
  'r-agent': [{ roleId: 'r-agent', businessUnit: BU_HQ, directUsers: [DAN, EVA], teams: [] }],
  'r-sales': [{ roleId: 'r-sales', businessUnit: BU_HQ, directUsers: [BEN, EVA], teams: [] }],
  'r-manager': [{ roleId: 'r-manager', businessUnit: BU_HQ, directUsers: [CARA], teams: [T_LEADS] }],
};
