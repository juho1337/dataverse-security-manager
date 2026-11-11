import { describe, expect, it } from 'vitest';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type PrivilegeId, type RoleMatrix } from '../../domain/privileges';
import type { OperationAggregate, TablePrivileges } from '../../domain/tablePrivileges';
import { accessToCsv, accessToText, cellWord, matrixToCsv, matrixToText, type ReportMeta } from './tableReports';

const NOW = Date.UTC(2026, 10, 9, 20, 41, 0);
const meta: ReportMeta = { environment: 'Contoso Dev (https://contoso-dev.crm4.dynamics.com)', exportedAtMs: NOW };

const cells = (over: Partial<Record<PrivilegeId, CellValue>> = {}): PrivilegeCells =>
  Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, over[p] ?? ({ kind: 'noGrant' } as CellValue)])) as PrivilegeCells;

const matrix: RoleMatrix = {
  table: { logicalName: 'account', displayName: 'Account', supported: true },
  roles: [
    { roleId: '11111111-1111-1111-1111-111111111111', name: 'Sales Manager', isManaged: true, cells: cells({ Read: { kind: 'depth', depth: 'Global' }, Write: { kind: 'depth', depth: 'Local' } }) },
    { roleId: '22222222-2222-2222-2222-222222222222', name: '=HYPERLINK("http://x")', isManaged: false, cells: cells({ Share: { kind: 'unknown' }, Assign: { kind: 'notApplicable' } }) },
    { roleId: '33333333-3333-3333-3333-333333333333', name: 'Contact jane.doe@contoso.com, "quoted"', cells: cells() },
  ],
};

describe('role matrix report', () => {
  it('words every cell kind the way the screen does, and never calls an unreadable cell "No grant"', () => {
    expect(cellWord({ kind: 'depth', depth: 'Global' })).toBe('Organization');
    expect(cellWord({ kind: 'depth', depth: 'Basic' })).toBe('User');
    expect(cellWord({ kind: 'noGrant' })).toBe('No grant');
    expect(cellWord({ kind: 'notApplicable' })).toBe('n/a');
    expect(cellWord({ kind: 'unknown' })).toBe('UNKNOWN');
  });

  it('writes a ticket-ready text report: header, filter note, aligned grid, no e-mail addresses', () => {
    const t = matrixToText(matrix, { ...meta, filterNote: 'role search "sales"; relevant roles only' });
    const lines = t.split('\r\n');
    expect(lines[0]).toBe('SECURITY ROLES ON TABLE - Account (account)');
    expect(t).toContain('Environment: Contoso Dev (https://contoso-dev.crm4.dynamics.com)');
    expect(t).toContain('Exported: 2026-11-09 20:41:00 UTC');
    expect(t).toContain('View: role search "sales"; relevant roles only');
    expect(t).toContain('Roles listed: 3');
    const sales = lines.find((l) => l.startsWith('Sales Manager'))!;
    expect(sales).toContain('(managed)');
    expect(sales.split(' | ').map((c) => c.trim())).toEqual(['Sales Manager (managed)', 'No grant', 'Organization', 'Business Unit', 'No grant', 'No grant', 'No grant', 'No grant', 'No grant']);
    expect(t).not.toContain('jane.doe@contoso.com');
    expect(t).toContain('[email removed]');
    expect(t).not.toContain('PARTIAL RESULT');
  });

  it('heads a partial result with its notes so it cannot be taken for complete', () => {
    const t = matrixToText(matrix, { ...meta, partialNotes: ['The privilege catalog was read only in part.'] });
    expect(t).toContain('PARTIAL RESULT');
    expect(t).toContain('  - The privilege catalog was read only in part.');
    expect(t.indexOf('PARTIAL RESULT')).toBeLessThan(t.indexOf('Roles listed'));
    expect(t).toContain('UNKNOWN');
  });

  it('says so when no role is listed instead of printing an empty grid', () => {
    expect(matrixToText({ ...matrix, roles: [] }, meta)).toContain('(no roles to list)');
  });

  it('flags in the CSV which rows are complete: a row with an unreadable cell is "no", and read notes travel with every row of a partial read', () => {
    const lines = matrixToCsv(matrix).trimEnd().split('\r\n');
    expect(lines[2]).toMatch(/,no,$/); // the row with an UNKNOWN cell
    expect(lines[1]).toMatch(/,yes,$/);
    const partial = matrixToCsv(matrix, ['The privilege catalog was read only in part.']).trimEnd().split('\r\n');
    expect(partial.slice(1).every((l) => l.includes(',no,The privilege catalog was read only in part.'))).toBe(true);
  });

  it('writes CSV with a header, role ids, formula-injection protection and RFC 4180 quoting', () => {
    const csv = matrixToCsv(matrix);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Table,Table logical name,Security role,Role id,Managed,Create,Read,Write,Delete,Append,Append To,Assign,Share,Business Unit copies,Complete,Read notes');
    expect(lines[1]).toBe('Account,account,Sales Manager,11111111-1111-1111-1111-111111111111,yes,No grant,Organization,Business Unit,No grant,No grant,No grant,No grant,No grant,,yes,');
    expect(lines[2]!.startsWith(`Account,account,"'=HYPERLINK(""http://x"")"`) || lines[2]!.includes(`'=HYPERLINK`)).toBe(true);
    expect(lines[2]).toContain('UNKNOWN');
    expect(lines[2]).toContain('n/a');
    expect(lines[3]).toContain('[email removed]');
    expect(lines[3]).toContain('""quoted""');
    expect(lines[3]!.split(',').slice(-11, -3).every((c) => c === 'No grant')).toBe(true);
    expect(lines[3]).toContain(',33333333-3333-3333-3333-333333333333,,No grant'); // managed unknown is empty, not guessed
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

const op = (cell: CellValue, contributors: OperationAggregate['contributors'] = [], complete?: boolean): OperationAggregate => ({ cell, contributors, ...(complete === undefined ? {} : { complete }) });
const none = op({ kind: 'noGrant' });

const tables: TablePrivileges[] = [
  {
    logicalName: 'account',
    displayName: 'Account',
    partial: false,
    operations: {
      Create: none,
      Read: op({ kind: 'depth', depth: 'Global' }, [
        { roleId: 'aaaaaaaa-0000-0000-0000-000000000001', roleName: 'Sales Manager', businessUnitName: 'Contoso', depth: 'Global', origins: [{ kind: 'direct' }], determinesAggregate: true },
        { roleId: 'bbbbbbbb-0000-0000-0000-000000000002', roleName: 'Sales Manager', businessUnitName: 'Contoso North', depth: 'Global', origins: [{ kind: 'team', teamId: 't1', teamName: 'Sales Team' }], determinesAggregate: true },
        { roleId: 'cccccccc-0000-0000-0000-000000000003', roleName: 'Viewer', businessUnitName: 'Contoso', depth: 'Basic', origins: [{ kind: 'direct' }, { kind: 'team', teamId: 't1', teamName: 'Sales Team' }], determinesAggregate: false },
      ]),
      Write: none,
      Delete: none,
      Append: none,
      AppendTo: none,
      Assign: op({ kind: 'notApplicable' }),
      Share: op({ kind: 'unknown' }, [], false),
    },
  },
  { logicalName: 'task', displayName: 'Task', partial: true, operations: Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, op({ kind: 'unknown' }, [], false)])) as Record<PrivilegeId, OperationAggregate> },
];

describe('access (user / team) report', () => {
  const subject = { kind: 'user', name: 'Jane Doe (jane.doe@contoso.com)' } as const;

  it('states the subject, the scope limit and every contributing role with its source, keeping same-name roles apart', () => {
    const t = accessToText(subject, tables, { ...meta, filterNote: 'tables containing "a"' });
    expect(t.split('\r\n')[0]).toBe('TABLE PRIVILEGES OF USER - Jane Doe ([email removed])');
    expect(t).toContain('not effective access to a record');
    expect(t).toContain('Tables listed: 2');
    expect(t).toContain('Account (account)');
    expect(t).toContain('Read: Organization from Sales Manager (Contoso, role id aaaaaaaa) direct');
    expect(t).toContain('Read: Organization from Sales Manager (Contoso North, role id bbbbbbbb) via team Sales Team');
    expect(t).toContain('Read: User from Viewer (Contoso, role id cccccccc) direct, via team Sales Team - superseded');
    expect(t).not.toContain('jane.doe@contoso.com');
  });

  it('marks partial tables and unknown cells, and never turns an unknown cell into "No grant"', () => {
    const t = accessToText(subject, tables, { ...meta, partialNotes: ['Some roles could not be read.'] });
    expect(t).toContain('Task (task)  [PARTIAL]');
    expect(t).toContain('PARTIAL RESULT');
    const task = t.split('\r\n').find((l) => l.trimStart().startsWith('UNKNOWN'))!;
    expect(task.split(' | ').every((c) => c.trim() === 'UNKNOWN')).toBe(true);
    const account = t.split('\r\n').find((l) => l.includes('Organization') && l.includes('n/a'))!;
    expect(account).toContain('UNKNOWN'); // Share
  });

  it('flags a contributor list that may be incomplete', () => {
    const partial: TablePrivileges[] = [{ ...tables[0]!, operations: { ...tables[0]!.operations, Read: op({ kind: 'depth', depth: 'Local' }, [], false) } }];
    expect(accessToText(subject, partial, meta)).toContain('Read: the contributor list may be incomplete.');
  });

  it('writes CSV with one row per contributing role and one row for a cell without contributors', () => {
    const csv = accessToCsv(subject, tables);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Subject type,Subject,Table,Table logical name,Privilege,Result,Contributing role,Role id,Business unit,Role depth,Source,Determines result,Complete,Read notes');
    expect(lines.length).toBe(1 + 3 /* three contributors to Account Read */ + 7 /* other Account operations */ + 8 /* Task */);
    const reads = lines.filter((l) => l.includes(',Read,Organization,'));
    expect(reads).toHaveLength(3);
    expect(reads[1]).toContain('Contoso North');
    expect(reads[1]).toContain('via team Sales Team');
    expect(reads[2]).toContain(',direct; via team Sales Team,no');
    expect(lines.filter((l) => l.includes(',UNKNOWN,'))).toHaveLength(9); // Account Share + all eight Task cells
    expect(lines.join('\n')).not.toContain('jane.doe@contoso.com');
  });

  it('carries completeness into the access CSV: per operation and table, and the notes of a partial read on every row', () => {
    const full = accessToCsv(subject, tables).trimEnd().split('\r\n').slice(1);
    const readRows = full.filter((l) => l.includes(',Read,Organization,'));
    expect(readRows.every((l) => l.endsWith(',yes,'))).toBe(true); // complete contributor list
    expect(full.filter((l) => l.includes(',Share,UNKNOWN,')).every((l) => l.includes(',no,'))).toBe(true);
    expect(full.filter((l) => l.includes(',Task,task,')).every((l) => l.includes(',no,'))).toBe(true); // partial table
    const incomplete: TablePrivileges[] = [{ ...tables[0]!, operations: { ...tables[0]!.operations, Read: op({ kind: 'depth', depth: 'Local' }, [{ roleId: 'r1', roleName: 'R', businessUnitName: 'B', depth: 'Local', origins: [{ kind: 'direct' }], determinesAggregate: true }], false) } }];
    const row = accessToCsv(subject, incomplete).trimEnd().split('\r\n').find((l) => l.includes(',Read,Business Unit,'))!;
    expect(row).toMatch(/,no,$/); // the contributor list may be incomplete: not complete
    const noted = accessToCsv(subject, tables, ['Some roles could not be read.']).trimEnd().split('\r\n').slice(1);
    expect(noted.every((l) => l.endsWith(',no,Some roles could not be read.'))).toBe(true); // even a fully read table is not exhaustive
  });

  it('protects every text cell of the CSV against formula injection', () => {
    const risky: TablePrivileges[] = [{ ...tables[0]!, displayName: '=cmd|calc', operations: { ...tables[0]!.operations, Read: op({ kind: 'depth', depth: 'Local' }, [{ roleId: 'r', roleName: '@SUM(1)', businessUnitName: '+BU', depth: 'Local', origins: [{ kind: 'direct' }], determinesAggregate: true }]) } }];
    const csv = accessToCsv({ kind: 'team', name: '-team' }, risky);
    expect(csv).toContain(",'-team,");
    expect(csv).toContain(",'=cmd|calc,");
    expect(csv).toContain(",'@SUM(1),");
    expect(csv).toContain(",'+BU,");
  });
});

describe('role matrix report: Business Unit copies', () => {
  const lineageMatrix: RoleMatrix = {
    table: matrix.table,
    roles: [
      { roleId: '44444444-4444-4444-4444-444444444444', name: 'Copy Differs', cells: cells(), lineage: { instanceCount: 2, instancesDiffer: true, copiesWithoutStoredGrants: 0, anyInstanceGrants: true } },
      { roleId: '55555555-5555-5555-5555-555555555555', name: 'Orphan', cells: cells(), lineage: { instanceCount: 1, instancesDiffer: false, copiesWithoutStoredGrants: 0, anyInstanceGrants: false, rootMissing: true } },
      { roleId: '66666666-6666-6666-6666-666666666666', name: 'Plain', cells: cells(), lineage: { instanceCount: 1, instancesDiffer: false, copiesWithoutStoredGrants: 0, anyInstanceGrants: false } },
    ],
  };

  it('text says the cells are the root role and flags differing copies and a missing root', () => {
    const t = matrixToText(lineageMatrix, meta);
    expect(t).toContain("Each row shows the root role's privileges");
    expect(t).toContain('Copy Differs [Business Unit copies differ]');
    expect(t).toContain('Orphan [root role not loaded]');
    expect(t).not.toContain('Plain [');
  });

  it('CSV names the copies state and never marks such a row Complete', () => {
    const rows = matrixToCsv(lineageMatrix).trimEnd().split('\r\n');
    expect(rows[0]).toContain('Business Unit copies,Complete,Read notes');
    expect(rows[1]).toMatch(/,differ,no,$/);
    expect(rows[2]).toMatch(/,root not loaded,no,$/);
    expect(rows[3]).toMatch(/,,yes,$/);
  });
});
