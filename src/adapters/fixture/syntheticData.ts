import type { CellValue, DepthId, PrivilegeCells, PrivilegeId, RoleRow, TableInfo } from '../../domain/privileges';
import { PRIVILEGE_IDS } from '../../domain/privileges';

// Synthetic data only: fictional "Contoso" tables and roles, no customer or legacy material.

export const SYNTHETIC_TABLES: readonly TableInfo[] = [
  { logicalName: 'account', displayName: 'Account', supported: true },
  { logicalName: 'contact', displayName: 'Contact', supported: true },
  { logicalName: 'contoso_project', displayName: 'Contoso Project', supported: true },
  { logicalName: 'contoso_task', displayName: 'Contoso Task', supported: true },
  { logicalName: 'contoso_budget', displayName: 'Contoso Budget', supported: true },
  { logicalName: 'contoso_archive', displayName: 'Contoso Archive', supported: true },
  {
    logicalName: 'contoso_auditlog',
    displayName: 'Contoso Audit Log',
    supported: false,
    unsupportedReason: 'No security privileges defined for this table',
  },
];

const d = (depth: DepthId): CellValue => ({ kind: 'depth', depth });
const NO: CellValue = { kind: 'noGrant' };
const NA: CellValue = { kind: 'notApplicable' };
const UNK: CellValue = { kind: 'unknown' };

function cells(values: Partial<Record<PrivilegeId, CellValue>>, fallback: CellValue = NO): PrivilegeCells {
  const out = {} as Record<PrivilegeId, CellValue>;
  for (const p of PRIVILEGE_IDS) out[p] = values[p] ?? fallback;
  return out;
}

function role(roleId: string, name: string, values: Partial<Record<PrivilegeId, CellValue>>, fallback?: CellValue): RoleRow {
  return { roleId, name, cells: cells(values, fallback) };
}

/** Roles for the Contoso Project table (the reference scenario). */
export const PROJECT_ROLES: readonly RoleRow[] = [
  role('r-admin', 'Project Administrator', {
    Create: d('Global'), Read: d('Global'), Write: d('Global'), Delete: d('Global'),
    Append: d('Global'), AppendTo: d('Global'), Assign: d('Global'), Share: d('Global'),
  }),
  role('r-contrib', 'Project Contributor', {
    Create: d('Local'), Read: d('Deep'), Write: d('Local'), Delete: d('Basic'),
    Append: d('Local'), AppendTo: d('Local'), Assign: d('None'), Share: d('Basic'),
  }),
  role('r-reader', 'Project Reader', {
    Create: d('None'), Read: d('Global'), Write: d('None'), Delete: d('None'),
    Append: d('None'), AppendTo: d('Basic'), Assign: d('None'), Share: d('None'),
  }),
  role('r-agent', 'Service Desk Agent', { Read: d('Local'), Append: d('Basic'), AppendTo: d('Basic') }),
  role('r-unrelated', 'Facilities Coordinator', {}),
];

/** A non-ownable table: Assign and Share do not exist for it. */
const NON_OWNABLE: Partial<Record<PrivilegeId, CellValue>> = { Assign: NA, Share: NA };

export const ROLES_BY_TABLE: Readonly<Record<string, readonly RoleRow[]>> = {
  contoso_project: PROJECT_ROLES,
  account: [
    role('r-sales', 'Sales Representative', {
      Create: d('Local'), Read: d('Local'), Write: d('Local'), Delete: d('Basic'),
      Append: d('Local'), AppendTo: d('Local'), Assign: d('Basic'), Share: d('Basic'),
    }),
    role('r-manager', 'Sales Manager', {
      Create: d('Deep'), Read: d('Deep'), Write: d('Deep'), Delete: d('Deep'),
      Append: d('Deep'), AppendTo: d('Deep'), Assign: d('Deep'), Share: d('Deep'),
    }),
    role('r-admin', 'Project Administrator', { Read: d('Global') }),
  ],
  contact: [
    role('r-sales', 'Sales Representative', { Create: d('Local'), Read: d('Local'), Write: d('Basic') }),
    role('r-agent', 'Service Desk Agent', { Read: d('Local'), Write: d('Basic') }),
  ],
  contoso_task: [
    role('r-contrib', 'Project Contributor', {
      Create: d('Local'), Read: d('Local'), Write: d('Local'), Delete: d('Basic'),
      Append: d('Local'), AppendTo: d('Local'), ...NON_OWNABLE,
    }),
    role('r-admin', 'Project Administrator', {
      Create: d('Global'), Read: d('Global'), Write: d('Global'), Delete: d('Global'),
      Append: d('Global'), AppendTo: d('Global'), ...NON_OWNABLE,
    }),
  ],
};

/** Partial-data table: one role's privileges could not be read, so its cells are unknown (never None). */
export const PARTIAL_TABLE = 'contoso_budget';
export const PARTIAL_ROLES: readonly RoleRow[] = [
  role('r-admin', 'Project Administrator', {
    Create: d('Global'), Read: d('Global'), Write: d('Global'), Delete: d('Global'),
    Append: d('Global'), AppendTo: d('Global'), Assign: d('Global'), Share: d('Global'),
  }),
  role('r-contrib', 'Project Contributor', { Read: UNK, Write: UNK, Create: d('Local') }, UNK),
];

/** Table whose role load always fails (error state demonstration). */
export const FAILING_TABLE = 'contoso_archive';
