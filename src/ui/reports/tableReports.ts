import { csvCell, redactEmails } from '../../application/buManager/export';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeId, type RoleMatrix, type RoleRow } from '../../domain/privileges';
import type { GrantOrigin, TablePrivileges } from '../../domain/tablePrivileges';
import { DEPTH_LABEL, PRIVILEGE_LABEL } from '../labels';

// Plain-text and CSV reports of what is on screen: the security-role matrix of one table (Role Analyzer) and the table privileges of one user
// or team (Access Explorer). Same vocabulary as the screens (the depth names, "No grant", "n/a"), nothing invented: a cell that could not be
// read is exported as UNKNOWN, never as "No grant". Text is meant to paste into a ticket or an e-mail: no markup, monospace-aligned,
// e-mail addresses removed. CSV cells are protected against spreadsheet formula injection.

export interface ReportMeta {
  /** How the environment is named to a person (connection name / URL). */
  readonly environment: string;
  readonly exportedAtMs: number;
  /** The active view filters in words, so the file says what it leaves out. */
  readonly filterNote?: string;
  /** Notes of a partial read; they head the report so a reader cannot take it for complete. */
  readonly partialNotes?: readonly string[];
}

const UNKNOWN_WORD = 'UNKNOWN';

/** One cell in words, the same wording as the screen. */
export function cellWord(cell: CellValue): string {
  switch (cell.kind) {
    case 'depth':
      return DEPTH_LABEL[cell.depth];
    case 'noGrant':
      return 'No grant';
    case 'notApplicable':
      return 'n/a';
    case 'unknown':
      return UNKNOWN_WORD;
  }
}

const utc = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'unknown time');
const clean = (s: string): string => redactEmails(s).replace(/\s+/g, ' ').trim();

function header(title: string, meta: ReportMeta): string[] {
  const lines = [title, `Environment: ${clean(meta.environment)}`, `Exported: ${utc(meta.exportedAtMs)}`];
  if (meta.filterNote) lines.push(`View: ${clean(meta.filterNote)}`);
  if (meta.partialNotes && meta.partialNotes.length > 0) {
    lines.push('', 'PARTIAL RESULT - parts of the data could not be read; cells marked UNKNOWN are not the same as "No grant":');
    for (const n of meta.partialNotes) lines.push(`  - ${clean(n)}`);
  }
  return lines;
}

/** Left-aligned columns separated by " | ". */
function grid(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join(' | ').trimEnd());
}

// ---------- Role Analyzer: the matrix of one table

const differs = (r: RoleRow): boolean => r.lineage?.instancesDiffer === true || r.summary?.instancesDiffer === true;
/** A row shows the ROOT role's cells; say so when a Business Unit copy disagrees or the root is not loaded. */
const lineageTag = (r: RoleRow): string => (differs(r) ? ' [Business Unit copies differ]' : '') + (r.lineage?.rootMissing ? ' [root role not loaded]' : '');
const copiesCell = (r: RoleRow): string => [differs(r) ? 'differ' : '', r.lineage?.rootMissing ? 'root not loaded' : ''].filter(Boolean).join('; ');

export function matrixToText(matrix: RoleMatrix, meta: ReportMeta): string {
  const t = matrix.table;
  const rows: string[][] = [['Security role', ...PRIVILEGE_IDS.map((p) => PRIVILEGE_LABEL[p])]];
  for (const r of matrix.roles) rows.push([clean(r.name) + (r.isManaged ? ' (managed)' : '') + lineageTag(r), ...PRIVILEGE_IDS.map((p) => cellWord(r.cells[p]))]);
  const lines = [
    ...header(`SECURITY ROLES ON TABLE - ${clean(t.displayName)} (${t.logicalName})`, meta),
    `Roles listed: ${matrix.roles.length}`,
    '',
    ...(matrix.roles.length > 0 ? grid(rows) : ['(no roles to list)']),
    '',
    "Each row shows the root role's privileges; a role marked [Business Unit copies differ] has copies that grant differently (expand the row in the tool).",
    'Depths: User < Business Unit < Parent: Child BU < Organization. "No grant" = the role does not grant it; n/a = the table has no such privilege.',
  ];
  return lines.join('\r\n');
}

/** The notes of a partial read as one CSV cell; empty when the read was complete. They travel with EVERY row so a filtered or split sheet is never mistaken for exhaustive. */
const notesCell = (notes: readonly string[]): string => notes.map(clean).join('; ');

export function matrixToCsv(matrix: RoleMatrix, partialNotes: readonly string[] = []): string {
  const head = ['Table', 'Table logical name', 'Security role', 'Role id', 'Managed', ...PRIVILEGE_IDS.map((p) => PRIVILEGE_LABEL[p]), 'Business Unit copies', 'Complete', 'Read notes'];
  const out = [head.map(csvCell).join(',')];
  for (const r of matrix.roles) {
    const complete = partialNotes.length === 0 && copiesCell(r) === '' && PRIVILEGE_IDS.every((p) => r.cells[p].kind !== 'unknown');
    const cells = [matrix.table.displayName, matrix.table.logicalName, r.name, r.roleId, r.isManaged === undefined ? '' : r.isManaged ? 'yes' : 'no', ...PRIVILEGE_IDS.map((p) => cellWord(r.cells[p])), copiesCell(r), complete ? 'yes' : 'no', notesCell(partialNotes)];
    out.push(cells.map((c) => csvCell(redactEmails(c))).join(','));
  }
  return `${out.join('\r\n')}\r\n`;
}

// ---------- Access Explorer: the table privileges of one user or team

export interface AccessSubject {
  readonly kind: 'user' | 'team';
  readonly name: string;
}

const originWord = (o: GrantOrigin): string => (o.kind === 'direct' ? 'direct' : `via team ${clean(o.teamName)}`);
const SHORT = (id: string): string => id.slice(0, 8);

export function accessToText(subject: AccessSubject, tables: readonly TablePrivileges[], meta: ReportMeta): string {
  const lines = [
    ...header(`TABLE PRIVILEGES OF ${subject.kind.toUpperCase()} - ${clean(subject.name)}`, meta),
    '',
    'Role-derived privileges only: ownership, sharing, the user hierarchy and field security are not evaluated, so this is not effective access to a record.',
    `Tables listed: ${tables.length}`,
  ];
  for (const t of tables) {
    lines.push('', `${clean(t.displayName)} (${t.logicalName})${t.partial ? '  [PARTIAL]' : ''}`);
    lines.push(...grid([PRIVILEGE_IDS.map((p) => PRIVILEGE_LABEL[p]), PRIVILEGE_IDS.map((p) => cellWord(t.operations[p].cell))]).map((l) => `  ${l}`));
    for (const p of PRIVILEGE_IDS) {
      const op = t.operations[p];
      if (op.cell.kind !== 'depth') continue;
      for (const c of op.contributors) {
        const origins = c.origins.map(originWord).join(', ');
        lines.push(`  ${PRIVILEGE_LABEL[p]}: ${DEPTH_LABEL[c.depth]} from ${clean(c.roleName)} (${clean(c.businessUnitName)}, role id ${SHORT(c.roleId)}) ${origins}${c.determinesAggregate ? '' : ' - superseded'}`);
      }
      if (op.complete === false) lines.push(`  ${PRIVILEGE_LABEL[p]}: the contributor list may be incomplete.`);
    }
  }
  return lines.join('\r\n');
}

export function accessToCsv(subject: AccessSubject, tables: readonly TablePrivileges[], partialNotes: readonly string[] = []): string {
  const head = ['Subject type', 'Subject', 'Table', 'Table logical name', 'Privilege', 'Result', 'Contributing role', 'Role id', 'Business unit', 'Role depth', 'Source', 'Determines result', 'Complete', 'Read notes'];
  const out = [head.map(csvCell).join(',')];
  const row = (cells: readonly string[]) => out.push(cells.map((c) => csvCell(redactEmails(c))).join(','));
  for (const t of tables) {
    for (const p of PRIVILEGE_IDS as readonly PrivilegeId[]) {
      const op = t.operations[p];
      const base = [subject.kind, subject.name, t.displayName, t.logicalName, PRIVILEGE_LABEL[p], cellWord(op.cell)];
      // Complete = every role and grant that could contribute was read; anything less (an unknown cell, a partial table or contributor list, a partial read) is "no".
      const tail = [partialNotes.length === 0 && !t.partial && op.complete !== false && op.cell.kind !== 'unknown' ? 'yes' : 'no', notesCell(partialNotes)];
      if (op.cell.kind !== 'depth' || op.contributors.length === 0) {
        row([...base, '', '', '', '', '', '', ...tail]);
        continue;
      }
      for (const c of op.contributors) row([...base, c.roleName, c.roleId, c.businessUnitName, DEPTH_LABEL[c.depth], c.origins.map(originWord).join('; '), c.determinesAggregate ? 'yes' : 'no', ...tail]);
    }
  }
  return `${out.join('\r\n')}\r\n`;
}
