import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { applyMatrixFilters, describeFilters, hasHolderFilter, hasPrivilegeFilter, NO_FILTERS } from '../application/roleFilters';
import type { Assignments, MatrixFilters } from '../application/roleFilters';
import type { FamilyView, InstanceView } from '../application/roleDetails';
import { COUNT_LIMITATION, describeCounts, describeFamily, totalUsers } from '../application/roleDetails';
import { formatCount } from '../domain/access';
import type { RoleMatrix as RoleMatrixData, RoleRow } from '../domain/privileges';
import { DEPTH_IDS, PRIVILEGE_IDS } from '../domain/privileges';
import type { PrivilegeId } from '../domain/privileges';
import type { ReadResult, SecurityDataReader } from '../ports/securityDataReader';
import { DepthCells, DepthLegend } from './DepthLetters';
import { InstanceDetail } from './InstanceDetail';
import { DEPTH_COLUMNS, DEPTH_LABEL, describeCell, PRIVILEGE_LABEL } from './labels';
import type { AsyncState } from './useAsync';
import { ViewSwitch } from './ViewSwitch';
import type { MatrixView } from './ViewSwitch';
import { BULK_LIMIT, useRoleDetails } from './useRoleDetails';
import type { DetailState } from './useRoleDetails';
import { ExportBar } from './reports/ExportBar';
import { useReportServices } from './reports/ReportContext';
import { matrixToCsv, matrixToText } from './reports/tableReports';
import { EditableCells } from './edit/EditableCells';
import { EditBar, EditFooter, PreviewDialog, ResultPanel } from './edit/EditPanels';
import { Icon } from './Icon';
import { UsersToolbar } from './UsersToolbar';
import { useRoleEditing } from './edit/useRoleEditing';
import type { RoleEditing } from './edit/useRoleEditing';
import { changes, currentDepth, type EditSession } from '../domain/roleEditing';
import { beginRoleEdit } from '../application/roleEditing/service';
import type { DepthId } from '../domain/privileges';
import type { SecurityDataWriter } from '../ports/securityDataWriter';

/** What editing needs from the shell. Without a writer editing is not offered at all (demo mode, or a host without the Dataverse API). */
export interface EditingConfig {
  readonly writer: SecurityDataWriter | null;
  readonly actor: string;
  readonly environmentId: string;
  /** How the environment is named in the preview (connection name and URL). */
  readonly environmentLabel: string;
}

interface Props {
  readonly state: AsyncState<RoleMatrixData>;
  readonly reader: SecurityDataReader;
  readonly onRetry: () => void;
  readonly editing?: EditingConfig;
  /** Logical name of the selected table; lets a reload of the same table keep the body (expanded rows) mounted. */
  readonly tableKey?: string;
}

/** Staged target depth per privilege for the Depth Matrix letters (a removal is `None`). */
function stagedDepths(session: EditSession): Partial<Record<PrivilegeId, DepthId>> {
  const out: Partial<Record<PrivilegeId, DepthId>> = {};
  for (const c of changes(session)) out[c.privilege] = c.target ?? 'None';
  return out;
}

function effectiveDepths(session: EditSession): Partial<Record<PrivilegeId, (typeof DEPTH_COLUMNS)[number] | null>> {
  const out: Partial<Record<PrivilegeId, (typeof DEPTH_COLUMNS)[number] | null>> = {};
  for (const p of PRIVILEGE_IDS) out[p] = currentDepth(session, p);
  return out;
}

function Legend() {
  return (
    <details className="legend">
      <summary>Legend</summary>
      <ul>
        <li><span aria-hidden="true">○</span> None: the role explicitly grants no access</li>
        <li><span aria-hidden="true">◔</span> User · <span aria-hidden="true">◑</span> Business Unit · <span aria-hidden="true">◕</span> Parent: Child BU · <span aria-hidden="true">●</span> Organization</li>
        <li><span aria-hidden="true">–</span> No grant: the role has no entry for this privilege</li>
        <li><span aria-hidden="true">⊘</span> n/a: the table has no such privilege</li>
        <li><span aria-hidden="true">?</span> Unknown: could not be read; never treated as None</li>
        <li><span aria-hidden="true">≠</span> Differs: the Business Unit copies of this role disagree on this privilege</li>
        <li><span aria-hidden="true">≥</span> At least: the data behind the number is incomplete</li>
      </ul>
    </details>
  );
}

type VisibleRow =
  | { readonly kind: 'role'; readonly key: string; readonly row: RoleRow; readonly open: boolean }
  | { readonly kind: 'status'; readonly key: string; readonly rootRoleId: string; readonly detail: DetailState | undefined }
  | { readonly kind: 'summary'; readonly key: string; readonly view: FamilyView; /** Business Unit copies nobody holds, not listed. */ readonly hidden: number }
  // `parent` is the matrix row that was expanded: the root row and a copy row of the same family return the SAME instances, so every row,
  // key and toggle below an expansion is namespaced by that parent (otherwise both expansions would render duplicate keys).
  | { readonly kind: 'instance'; readonly key: string; readonly parent: string; readonly view: InstanceView; readonly family: FamilyView; readonly open: boolean }
  | { readonly kind: 'detail'; readonly key: string; readonly parent: string; readonly view: InstanceView; readonly family: FamilyView };

const focusable = (r: VisibleRow): boolean => r.kind === 'role' || r.kind === 'instance';
const levelOf = (r: VisibleRow): number => (r.kind === 'role' ? 1 : r.kind === 'detail' ? 3 : 2);

/** The collapsed role row: who holds the role, when that is known (a summary from the reader), otherwise an invitation to expand. */
function roleMeta(r: RoleRow): string {
  const s = r.summary;
  if (!s) return 'Expand to see users and teams';
  const users = formatCount(s.uniqueUsers, s.complete);
  const teams = formatCount(s.teams, s.complete);
  return `${users.text} unique user${s.uniqueUsers === 1 && s.complete ? '' : 's'} · ${teams.text} team${s.teams === 1 && s.complete ? '' : 's'}`;
}

function CellsFor({ cells, differing, view, onAnnounce, onEdit, onBegin }: { cells: RoleRow['cells']; differing?: readonly PrivilegeId[]; view: MatrixView; onAnnounce: (text: string) => void; onEdit?: (p: PrivilegeId, column: (typeof DEPTH_COLUMNS)[number]) => void; onBegin?: () => void }) {
  if (view === 'depth') return <DepthCells cells={cells} differing={differing} onAnnounce={onAnnounce} {...(onEdit ? { onEdit, tabbable: false } : {})} />;
  return (
    <>
      {PRIVILEGE_IDS.map((p) => {
        const c = describeCell(cells[p]);
        const differs = differing?.includes(p) ?? false;
        return (
          <td
            key={p}
            role="gridcell"
            className={`cell cell-${c.tone}${differs ? ' cell-differs' : ''}${onBegin ? ' cell-click' : ''}`}
            {...(onBegin ? { onClick: onBegin, title: 'Click to edit this role' } : {})}
            aria-label={`${PRIVILEGE_LABEL[p]}: ${c.text}${differs ? ', differs from another Business Unit copy' : ''}`}
          >
            <span aria-hidden="true" className="glyph">{c.glyph}</span> {c.text}
            {differs && <span aria-hidden="true" className="differs-mark" title="Differs between Business Unit copies"> ≠</span>}
          </td>
        );
      })}
    </>
  );
}

export function RoleMatrix({ state, reader, onRetry, editing, tableKey }: Props) {
  const [filters, setFilters] = useState<MatrixFilters>(NO_FILTERS);
  // The last successful matrix of the selected table: a reload (after an edit) keeps the body, and with it the expanded rows, mounted.
  const last = useRef<{ readonly key: string; readonly result: Exclude<ReadResult<RoleMatrixData>, { status: 'error' }> } | null>(null);
  // The view lives here (above the table-keyed body) so it survives table changes, like the search boxes.
  const [view, setView] = useState<MatrixView>('privilege');
  // The edit state lives here, ABOVE the table-keyed body: an apply that is still running when another table is selected keeps its state, so its
  // result (success, partial, uncertain) is still shown and a second operation cannot be started over it.
  const editor: RoleEditing = useRoleEditing({
    reader,
    writer: editing?.writer ?? null,
    actor: editing?.actor ?? '',
    environmentId: editing?.environmentId ?? '',
    onReload: onRetry,
  });

  const result: ReadResult<RoleMatrixData> | null = state.phase === 'done' ? state.result : null;
  if (result && result.status !== 'error') last.current = { key: result.data.table.logicalName, result };
  const refreshing = state.phase === 'loading' && last.current !== null && tableKey !== undefined && last.current.key === tableKey;
  const shown = refreshing && last.current ? last.current.result : result;

  if (state.phase === 'idle') {
    return <p className="hint empty">Select a table to see which security roles grant privileges on it.</p>;
  }
  if (state.phase === 'loading' && !refreshing) return <p role="status" className="hint">Loading security roles…</p>;
  if (!shown || shown.status === 'error') {
    return (
      <p role="alert" className="msg msg-error">
        Roles could not be loaded{shown ? ` (${shown.errorClass}): ${shown.message}` : ''}{' '}
        <button type="button" onClick={onRetry}>Retry</button>
      </p>
    );
  }

  // Keyed by table: expansion state and loaded details belong to one table; the search boxes live here and persist.
  return (
    <MatrixBody
      key={shown.data.table.logicalName}
      result={shown}
      reader={reader}
      editing={editing}
      editor={editor}
      refreshing={refreshing}
      filters={filters}
      view={view}
      onView={setView}
      onFilters={setFilters}
    />
  );
}

interface BodyProps {
  readonly result: Exclude<ReadResult<RoleMatrixData>, { status: 'error' }>;
  readonly reader: SecurityDataReader;
  readonly editing?: EditingConfig | undefined;
  readonly editor: RoleEditing;
  /** The same table is being read again (after an edit): no new edit may start on the old values. */
  readonly refreshing: boolean;
  readonly filters: MatrixFilters;
  readonly view: MatrixView;
  readonly onView: (v: MatrixView) => void;
  readonly onFilters: (f: MatrixFilters) => void;
}

function MatrixBody({ result, reader, editing: editingConfig, editor, refreshing, filters, view, onView, onFilters }: BodyProps) {
  const { table } = result.data;
  // The edit session belongs to one table: its cells are only drawn on that table (another table can have the same role id).
  const session = editor.phase.kind !== 'idle' && editor.phase.session.table === table.logicalName ? editor.phase.session : null;
  const canStartEdit = editor.available && editor.phase.kind === 'idle' && !refreshing;
  const colCount = (view === 'depth' ? DEPTH_COLUMNS.length : PRIVILEGE_IDS.length) + 1;
  const [announcement, setAnnouncement] = useState('');
  const details = useRoleDetails(reader, table.logicalName);
  const assignmentsOf = useCallback(
    (roleId: string): Assignments => {
      const s = details.states[roleId];
      return s ? (s.phase === 'loading' ? 'loading' : s.result) : undefined;
    },
    [details.states],
  );
  const filtered = useMemo(() => applyMatrixFilters(result.data.roles, filters, assignmentsOf), [result.data.roles, filters, assignmentsOf]);
  // The total over the listed roles, and the button that reads everyone's users (the single roles still open by expanding them, as before).
  const listedIds = useMemo(() => filtered.rows.map((r) => r.roleId), [filtered.rows]);
  const usersTotal = useMemo(() => totalUsers(listedIds, (id) => details.states[id]), [listedIds, details.states]);
  const refreshUsers = () => {
    const notRead = listedIds.filter((id) => !details.states[id]);
    if (notRead.length > 0) details.ensureMany(notRead);
    else details.refreshMany(listedIds);
  };
  const patch = (p: Partial<MatrixFilters>) => onFilters({ ...filters, ...p });
  const toggle = <T,>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const anyFilter = filters.search.trim() !== '' || filters.showAll || hasPrivilegeFilter(filters) || hasHolderFilter(filters);
  // The export is what the screen shows: the filtered roles, with the filters named in the file.
  const services = useReportServices();
  const exportMatrix = useMemo<RoleMatrixData>(() => ({ ...result.data, roles: filtered.rows }), [result.data, filtered.rows]);
  const exportMeta = () => ({
    environment: services.environment,
    exportedAtMs: services.now(),
    filterNote: describeFilters(filters, filtered, (d) => DEPTH_LABEL[d], (p) => PRIVILEGE_LABEL[p]),
    ...(result.status === 'partial' ? { partialNotes: result.notes } : {}),
  });

  // Expansion state survives filtering: it lives here, not in the filtered rows. `toggled` holds keys the user flipped
  // away from their default (roles closed; an instance open only when it is the single copy of its role).
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const isOpen = useCallback((key: string, defaultOpen: boolean) => toggled.has(key) !== defaultOpen, [toggled]);
  const flip = useCallback((key: string) => setToggled((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }), []);

  const visible = useMemo(() => {
    const out: VisibleRow[] = [];
    for (const row of filtered.rows) {
      const key = `r:${row.roleId}`;
      const open = isOpen(key, false);
      out.push({ kind: 'role', key, row, open });
      if (!open) continue;
      const detail = details.states[row.roleId];
      if (!detail || detail.phase === 'loading' || detail.result.status === 'error') {
        out.push({ kind: 'status', key: `s:${row.roleId}`, rootRoleId: row.roleId, detail });
        continue;
      }
      const family = describeFamily(detail.result);
      // A Business Unit copy that no user and no team holds says nothing about this role: it is not listed (counted in the summary instead). Only
      // when the data is complete, and never the only copy (an expanded role always shows something).
      const unused = (i: (typeof family.instances)[number]) => family.complete && i.instance.directUsers.length === 0 && i.instance.teams.length === 0;
      const used = family.instances.filter((i) => !unused(i));
      const listed = used.length > 0 ? used : family.instances.slice(0, 1);
      out.push({ kind: 'summary', key: `m:${row.roleId}`, view: family, hidden: family.instances.length - listed.length });
      const single = listed.length === 1;
      for (const view of listed) {
        const ikey = `i:${row.roleId}:${view.instance.roleId}`;
        const iopen = isOpen(ikey, single);
        out.push({ kind: 'instance', key: ikey, parent: row.roleId, view, family, open: iopen });
        if (iopen) out.push({ kind: 'detail', key: `d:${row.roleId}:${view.instance.roleId}`, parent: row.roleId, view, family });
      }
    }
    return out;
  }, [filtered.rows, details.states, isOpen]);

  // Roving focus over the role and instance rows (one tab stop for the whole grid).
  const focusKeys = useMemo(() => visible.filter(focusable).map((r) => r.key), [visible]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = activeKey && focusKeys.includes(activeKey) ? activeKey : (focusKeys[0] ?? null);
  const refs = useRef(new Map<string, HTMLTableRowElement>());
  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setActiveKey(key);
    refs.current.get(key)?.focus();
  };

  const toggleRole = (row: RoleRow) => {
    const key = `r:${row.roleId}`;
    if (!isOpen(key, false)) details.ensure(row.roleId);
    flip(key);
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: VisibleRow) => {
    if (e.target !== e.currentTarget || !focusable(row)) return;
    const i = focusKeys.indexOf(row.key);
    const open = row.kind === 'role' ? row.open : row.kind === 'instance' ? row.open : false;
    const toggle = () => (row.kind === 'role' ? toggleRole(row.row) : flip(row.key));
    const rowsByKey = visible.filter(focusable);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(focusKeys[Math.min(i + 1, focusKeys.length - 1)]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(focusKeys[Math.max(i - 1, 0)]);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(focusKeys[0]);
        break;
      case 'End':
        e.preventDefault();
        focusRow(focusKeys[focusKeys.length - 1]);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!open) toggle();
        else {
          const next = rowsByKey[i + 1];
          if (next && levelOf(next) > levelOf(row)) focusRow(next.key);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (open) toggle();
        else {
          for (let j = i - 1; j >= 0; j--) {
            const candidate = rowsByKey[j];
            if (candidate && levelOf(candidate) < levelOf(row)) {
              focusRow(candidate.key);
              break;
            }
          }
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        toggle();
        break;
      case 'e':
      case 'E':
        if (row.kind === 'role' && canStartEdit) {
          e.preventDefault();
          editor.begin(result.data, row.row, result.status === 'partial');
        }
        break;
      default:
    }
  };

  const rowProps = (row: VisibleRow) => {
    const isFocusable = focusable(row);
    return {
      role: 'row' as const,
      'aria-level': levelOf(row),
      ...(isFocusable ? { 'aria-expanded': row.kind === 'role' || row.kind === 'instance' ? row.open : undefined } : {}),
      tabIndex: isFocusable ? (row.key === active ? 0 : -1) : undefined,
      ref: isFocusable
        ? (el: HTMLTableRowElement | null) => {
            if (el) refs.current.set(row.key, el);
            else refs.current.delete(row.key);
          }
        : undefined,
      onFocus: isFocusable ? () => setActiveKey(row.key) : undefined,
      onKeyDown: isFocusable ? (e: KeyboardEvent<HTMLTableRowElement>) => onRowKeyDown(e, row) : undefined,
    };
  };

  const fullRow = (node: ReactNode, cls = '') => (
    <td role="gridcell" colSpan={colCount} className={`wide ${cls}`.trim()}>{node}</td>
  );

  const renderRow = (row: VisibleRow): ReactNode => {
    switch (row.kind) {
      case 'role': {
        const s = row.row.summary;
        // Who holds the role: exact once the assignments were read (the row was expanded), a summary or an invitation before that.
        const loaded = details.states[row.row.roleId];
        const family = loaded && loaded.phase !== 'loading' && loaded.result.status !== 'error' ? describeFamily(loaded.result) : null;
        const metaText = family ? describeCounts(family.counts, family.complete) : roleMeta(row.row);
        // Editing is always on for a role that can be edited: a click on a cell starts it. A role that cannot be edited says why, once.
        // Whether a role CAN be edited is a property of the role, shown at all times (also while another role is being edited); only starting an edit
        // needs an idle editor.
        const editability = editor.available && !refreshing ? beginRoleEdit(result.data, row.row, result.status === 'partial') : null;
        const start = canStartEdit ? editability : null;
        const begin = start?.ok ? () => editor.begin(result.data, row.row, result.status === 'partial') : undefined;
        const stageFromIdle = begin ? (p: PrivilegeId, column: (typeof DEPTH_COLUMNS)[number]) => {
          begin();
          // The same toggle as inside an edit session: a click on the depth the role already grants removes the grant (staging that same depth would be a no-op).
          const held = row.row.cells[p];
          editor.stage(p, held.kind === 'depth' && held.depth === column ? null : column);
        } : undefined;
        return (
          <tr key={row.key} {...rowProps(row)} className="row-role">
            <th role="rowheader" scope="row" className="sticky">
              <button type="button" tabIndex={-1} className="twisty" aria-expanded={row.open} aria-label={`${row.open ? 'Collapse' : 'Expand'} ${row.row.name}`} title={row.open ? 'Hide users and teams' : 'Show users and teams'} onClick={() => toggleRole(row.row)}>
                <Icon name="chevron" />
              </button>{' '}
              <span className="role-name">{row.row.name}</span>
              {editability && !editability.ok && <span className="role-readonly" title={editability.reason}> (read-only)</span>}
              <span className="meta" title={metaText}>{metaText}</span>
              {(s?.instancesDiffer ?? row.row.lineage?.instancesDiffer) && <span className="badge badge-differs">Instances differ</span>}
              {row.row.lineage?.rootMissing && <span className="badge badge-differs">Root role not loaded</span>}
              {session && editor.editingRoleId === row.row.roleId && <span className="badge badge-editing">Editing</span>}
            </th>
            {session && editor.editingRoleId === row.row.roleId ? (
              view === 'depth' ? (
                <DepthCells
                  cells={session.original}
                  staged={stagedDepths(session)}
                  effective={effectiveDepths(session)}
                  onAnnounce={setAnnouncement}
                  {...(editor.phase.kind === 'editing' ? { onEdit: (p: PrivilegeId, column: (typeof DEPTH_COLUMNS)[number]) => editor.stage(p, currentDepth(session, p) === column ? null : column) } : {})}
                />
              ) : (
                <EditableCells session={session} onStage={editor.stage} disabled={editor.phase.kind !== 'editing'} />
              )
            ) : (
              <CellsFor cells={row.row.cells} view={view} onAnnounce={setAnnouncement} {...(stageFromIdle ? { onEdit: stageFromIdle } : {})} {...(begin ? { onBegin: begin } : {})} />
            )}
          </tr>
        );
      }
      case 'status': {
        const d = row.detail;
        if (!d || d.phase === 'loading') {
          return <tr key={row.key} role="row" aria-level={2}>{fullRow(<p role="status" className="hint">Loading assignments…</p>)}</tr>;
        }
        const err = d.result.status === 'error' ? d.result : null;
        return (
          <tr key={row.key} role="row" aria-level={2}>
            {fullRow(
              <p role="alert" className="msg msg-error">
                Assignments could not be loaded{err ? ` (${err.errorClass}): ${err.message}` : ''}{' '}
                <button type="button" onClick={() => details.retry(row.rootRoleId)}>Retry</button>
              </p>,
            )}
          </tr>
        );
      }
      case 'summary': {
        const v = row.view;
        return (
          <tr key={row.key} role="row" aria-level={2} className="row-summary">
            {fullRow(
              <>
                {!v.complete && (
                  <p role="status" className="msg msg-warn">
                    <strong>Partial result.</strong> {v.notes.join(' ') || 'Some referenced users could not be read.'} Counts are shown as lower bounds (≥).
                  </p>
                )}
                <p className="hint"><strong>{v.family.name}</strong>: {describeCounts(v.counts, v.complete)}</p>
                {row.hidden > 0 && <p className="hint">{row.hidden} Business Unit cop{row.hidden === 1 ? 'y' : 'ies'} that no user or team holds {row.hidden === 1 ? 'is' : 'are'} not listed.</p>}
                {v.differing.length > 0 && (
                  <p className="hint">The copies differ on: {v.differing.map((p) => PRIVILEGE_LABEL[p]).join(', ')}.</p>
                )}
                <p className="hint limitation">{COUNT_LIMITATION}</p>
              </>,
            )}
          </tr>
        );
      }
      case 'instance':
        return (
          <tr key={row.key} {...rowProps(row)} className="row-instance">
            <th role="rowheader" scope="row" className="sticky indent">
              <button type="button" tabIndex={-1} className="twisty" aria-expanded={row.open} aria-label={`${row.open ? 'Collapse' : 'Expand'} ${row.view.instance.businessUnitName} copy`} title={row.open ? 'Hide the users and teams of this copy' : 'Show the users and teams of this copy'} onClick={() => flip(row.key)}>
                <Icon name="chevron" />
              </button>{' '}
              <span className="role-name">Business Unit: {row.view.instance.businessUnitName}</span>
              <span className="meta">{describeCounts(row.view.counts, row.family.complete)}</span>
            </th>
            {/* A Business Unit copy is only a name that holds users and teams: its privileges are the role's (shown on the role row), so no letters here. */}
            <td role="gridcell" colSpan={colCount - 1} className="instance-holders" />
          </tr>
        );
      case 'detail':
        return (
          <tr key={row.key} role="row" aria-level={3} className="row-detail">
            {fullRow(
              <InstanceDetail
                view={row.view}
                complete={row.family.complete}
                isTeamOpen={(teamId) => isOpen(`t:${row.parent}:${row.view.instance.roleId}:${teamId}`, false)}
                onToggleTeam={(teamId) => flip(`t:${row.parent}:${row.view.instance.roleId}:${teamId}`)}
              />,
            )}
          </tr>
        );
    }
  };

  return (
    <section className="matrix" aria-label={`${view === 'depth' ? 'Depth' : 'Privilege'} matrix for ${table.displayName}`}>
      <ViewSwitch value={view} onChange={onView} />
      <div className="matrix-tools">
        <label className="field-label" htmlFor="role-search">Search roles</label>
        <input id="role-search" type="search" value={filters.search} onChange={(e) => patch({ search: e.target.value })} placeholder="Role name" />
        <label className="check">
          <input type="checkbox" checked={filters.showAll} onChange={(e) => patch({ showAll: e.target.checked })} />
          Show all roles
        </label>
        <ExportBar
          label={`security roles on ${table.displayName}`}
          fileBase={`table-${table.logicalName}-roles`}
          disabled={filtered.rows.length === 0}
          text={() => matrixToText(exportMatrix, exportMeta())}
          csv={() => matrixToCsv(exportMatrix, exportMeta().partialNotes ?? [])}
        />
        {view === 'depth' ? <DepthLegend /> : <Legend />}
      </div>
      <details className="filters" open={hasPrivilegeFilter(filters) || hasHolderFilter(filters) || undefined}>
        <summary>More filters{hasPrivilegeFilter(filters) || hasHolderFilter(filters) ? ' (active)' : ''}</summary>
        <fieldset>
          <legend>Privilege</legend>
          {PRIVILEGE_IDS.map((p) => (
            <label key={p} className="check">
              <input type="checkbox" checked={filters.privileges.includes(p)} onChange={() => patch({ privileges: toggle(filters.privileges, p) })} />
              {PRIVILEGE_LABEL[p]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Granted depth</legend>
          {DEPTH_IDS.map((d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={filters.depths.includes(d)} onChange={() => patch({ depths: toggle(filters.depths, d) })} />
              {DEPTH_LABEL[d]}
            </label>
          ))}
        </fieldset>
        <p className="hint">Pick privileges and/or depths: a role stays when it grants one of the picked depths (or anything, if no depth is picked) on one of the picked privileges. A role with an unreadable cell stays too.</p>
        <label className="field-label" htmlFor="role-holder">Held by user or team</label>
        <input id="role-holder" type="search" value={filters.holder} onChange={(e) => patch({ holder: e.target.value })} placeholder="User, team or team member name" />
        <label className="field-label" htmlFor="role-bu">Business Unit</label>
        <input id="role-bu" type="search" value={filters.businessUnit} onChange={(e) => patch({ businessUnit: e.target.value })} placeholder="Business Unit name" />
        {anyFilter && <button type="button" onClick={() => onFilters(NO_FILTERS)}>Clear all filters</button>}
      </details>
      {hasHolderFilter(filters) && (
        <div role="status" className="msg msg-warn">
          Holders and Business Units are known only for roles whose assignments are loaded.
          {filtered.notChecked.length > 0 && (
            <>
              {' '}{filtered.notChecked.length} role{filtered.notChecked.length === 1 ? ' is' : 's are'} not checked yet and not listed.{' '}
              <button type="button" onClick={() => details.ensureMany(filtered.notChecked)}>
                Load assignments for {Math.min(filtered.notChecked.length, BULK_LIMIT)} role{Math.min(filtered.notChecked.length, BULK_LIMIT) === 1 ? '' : 's'}
              </button>
            </>
          )}
          {filtered.couldNotCheck > 0 && <> {filtered.couldNotCheck} role{filtered.couldNotCheck === 1 ? '' : 's'} could not be checked and {filtered.couldNotCheck === 1 ? 'is' : 'are'} listed anyway.</>}
        </div>
      )}
      {result.status === 'partial' && (
        <div role="status" className="msg msg-warn">
          <strong>Partial result.</strong> {result.notes.join(' ')}
        </div>
      )}
      {refreshing && <p role="status" className="hint">Reading the role again from Dataverse…</p>}
      {editor.phase.kind === 'idle' && editor.notice && <p role="alert" className="msg msg-warn">{editor.notice}</p>}
      <EditBar editing={editor} />
      <ResultPanel editing={editor} />
      <PreviewDialog editing={editor} environmentLabel={editingConfig?.environmentLabel ?? 'the connected environment'} />
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <div className="matrix-scroll">
        <table role="treegrid" aria-label={`Roles with privileges on ${table.displayName}`}>
          <caption>
            <div className="caption-row">
              <span>
                Roles with privileges on {table.displayName} <code>{table.logicalName}</code>
              </span>
              <UsersToolbar total={usersTotal} onLoad={refreshUsers} />
            </div>
          </caption>
          <thead>
            <tr role="row">
              <th role="columnheader" scope="col" className="sticky">Security role</th>
              {view === 'depth'
                ? DEPTH_COLUMNS.map((d) => <th key={d} role="columnheader" scope="col">{DEPTH_LABEL[d]}</th>)
                : PRIVILEGE_IDS.map((p) => <th key={p} role="columnheader" scope="col">{PRIVILEGE_LABEL[p]}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.rows.length === 0 && (
              <tr role="row"><td role="gridcell" colSpan={colCount} className="hint">No roles match.</td></tr>
            )}
            {visible.map((row) => <Fragment key={row.key}>{renderRow(row)}</Fragment>)}
          </tbody>
        </table>
      </div>
      <EditFooter editing={editor} />
      {filtered.hiddenCount > 0 && (
        <p className="hint">{filtered.hiddenCount} role{filtered.hiddenCount === 1 ? '' : 's'} hidden (grant nothing on this table). Use “Show all roles” to list them.</p>
      )}
      <p className="hint limitation">{COUNT_LIMITATION}</p>
    </section>
  );
}
