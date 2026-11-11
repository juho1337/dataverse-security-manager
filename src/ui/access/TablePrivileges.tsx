import { useId, useMemo, useState } from 'react';
import type { TablePrivilegeAnalysis } from '../../application/access/tablePrivileges';
import { PRIVILEGE_IDS, type PrivilegeId } from '../../domain/privileges';
import { removalEffect, type GrantOrigin, type OperationAggregate, type TablePrivileges } from '../../domain/tablePrivileges';
import type { ReadResult } from '../../ports/accessReader';
import { describeLetter } from '../depthMatrix';
import { DepthLegend } from '../DepthLetters';
import { DEPTH_COLUMNS, DEPTH_LABEL, PRIVILEGE_LABEL, PRIVILEGE_LETTER, describeCell } from '../labels';
import { ExportBar } from '../reports/ExportBar';
import { useReportServices } from '../reports/ReportContext';
import { accessToCsv, accessToText } from '../reports/tableReports';
import { useReadResult } from '../useAsync';
import { ViewSwitch, type MatrixView } from '../ViewSwitch';

const PAGE = 100;

interface Selected {
  readonly table: string;
  readonly operation: PrivilegeId;
}

const originText = (o: GrantOrigin): string => (o.kind === 'direct' ? 'Direct' : `Via team ${o.teamName}`);

/** What the aggregate of one operation is made of: every contributing role instance with its source, and what removing one of them would do. */
function Provenance({ table, operation, subject }: { readonly table: TablePrivileges; readonly operation: PrivilegeId; readonly subject: 'user' | 'team' }) {
  const op: OperationAggregate = table.operations[operation];
  const cell = op.cell;
  const label = `${table.displayName} · ${PRIVILEGE_LABEL[operation]}`;
  const top = op.contributors.find((c) => c.determinesAggregate);
  return (
    <section className="tp-sources" aria-label="Privilege sources" aria-live="polite">
      <h4>{label}: {cell.kind === 'depth' ? DEPTH_LABEL[cell.depth] : describeCell(cell).text}</h4>
      <p className="access-hint"><code>{table.logicalName}</code></p>
      {cell.kind === 'noGrant' && <p>No role {subject === 'team' ? 'of this team' : 'of this user'} grants this privilege.</p>}
      {cell.kind === 'notApplicable' && <p>This table has no {PRIVILEGE_LABEL[operation]} privilege.</p>}
      {cell.kind === 'unknown' && <p role="note" className="access-partial">It could not be determined, because the roles or their privileges were not read completely. It is not the same as no grant.</p>}
      {cell.kind === 'depth' && (
        <>
          <p>The result is the highest explicit grant among the roles below. A lower depth is implied by it and is not a separate grant.</p>
          <ul className="tp-contributors" aria-label="Contributing roles">
            {op.contributors.map((c) => {
              const effect = removalEffect(op, c.roleId);
              return (
                <li key={c.roleId} data-decides={c.determinesAggregate ? 'true' : undefined}>
                  <span className="role-row-main">
                    <strong>{c.roleName}</strong>
                    <span className="access-result-meta">· {c.businessUnitName} · role id {c.roleId.slice(0, 8)}</span>
                    <span className="access-badge">{DEPTH_LABEL[c.depth]}</span>
                    {c.origins.map((o) => <span key={originText(o)} className="access-badge">{originText(o)}</span>)}
                    <span className={`access-badge${c.determinesAggregate ? ' access-badge-on' : ''}`}>{c.determinesAggregate ? 'determines the result' : `superseded by ${top?.roleName ?? 'a higher grant'}`}</span>
                  </span>
                  <span className="access-result-meta">
                    {effect.kind === 'nothing' && 'Removing this role would not change the result: another role grants the same depth or a higher one.'}
                    {effect.kind === 'lowers' && effect.to && `Removing this role would lower the result to ${DEPTH_LABEL[effect.to]}.`}
                    {effect.kind === 'removes' && 'Removing this role would remove this privilege: no other role grants it.'}
                    {effect.kind === 'unknown' && 'What removing this role would do is not known: some roles or grants could not be read, and an unread role may also grant this privilege.'}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function PrivilegeView({ rows, selected, onSelect }: { readonly rows: readonly TablePrivileges[]; readonly selected: Selected | null; readonly onSelect: (s: Selected) => void }) {
  return (
    <div className="matrix-scroll">
      <table className="tp-table" aria-label="Table privileges by privilege">
        <thead>
          <tr>
            <th scope="col">Table</th>
            {PRIVILEGE_IDS.map((p) => <th key={p} scope="col">{PRIVILEGE_LABEL[p]}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.logicalName}>
              <th scope="row">{t.displayName}<span className="meta"><code>{t.logicalName}</code>{t.partial ? ' · incomplete' : ''}</span></th>
              {PRIVILEGE_IDS.map((p) => {
                const d = describeCell(t.operations[p].cell);
                const on = selected?.table === t.logicalName && selected.operation === p;
                return (
                  <td key={p} className={`cell cell-${d.tone}`}>
                    <button type="button" className="tp-cell" aria-pressed={on} aria-label={`${t.displayName}: ${PRIVILEGE_LABEL[p]}: ${d.text}`} onClick={() => onSelect({ table: t.logicalName, operation: p })}>
                      <span aria-hidden="true">{d.glyph}</span> {d.text}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DepthView({ rows, selected, onSelect }: { readonly rows: readonly TablePrivileges[]; readonly selected: Selected | null; readonly onSelect: (s: Selected) => void }) {
  return (
    <div className="matrix-scroll">
      <table className="tp-table" aria-label="Table privileges by depth">
        <thead>
          <tr>
            <th scope="col">Table</th>
            {DEPTH_COLUMNS.map((c) => <th key={c} scope="col">{DEPTH_LABEL[c]}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.logicalName}>
              <th scope="row">{t.displayName}<span className="meta"><code>{t.logicalName}</code>{t.partial ? ' · incomplete' : ''}</span></th>
              {DEPTH_COLUMNS.map((column) => (
                <td key={column} className="cell depth-cell">
                  <span role="group" aria-label={`${DEPTH_LABEL[column]} privileges`} className="letters">
                    {PRIVILEGE_IDS.map((p) => {
                      const l = describeLetter(p, t.operations[p].cell, column);
                      const on = selected?.table === t.logicalName && selected.operation === p;
                      return (
                        <button key={p} type="button" className={`letter letter-${l.state} letter-edit`} data-state={l.state} data-priv={p} aria-pressed={on} aria-label={`${t.displayName}, ${DEPTH_LABEL[column]}: ${l.name}`} title={l.name} onClick={() => onSelect({ table: t.logicalName, operation: p })}>
                          <span aria-hidden="true">{l.shown}</span>
                        </button>
                      );
                    })}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="access-hint">Letters: {PRIVILEGE_IDS.map((p) => `${PRIVILEGE_LETTER[p]} ${PRIVILEGE_LABEL[p]}`).join(', ')}.</p>
    </div>
  );
}

interface Props {
  /** Reads the analysis; null while there is nothing to analyze yet. */
  readonly load: (() => Promise<ReadResult<TablePrivilegeAnalysis>>) | null;
  /** Changes when the analysis must be read again (another person, or their roles changed). */
  readonly loadKey: string;
  readonly subject: 'user' | 'team';
  /** Name of the user or team, for the exported report. */
  readonly subjectName?: string;
}

/**
 * The Table privileges view: which Dataverse tables the roles of a user (or of a team) grant privileges on, at what depth, and exactly which
 * role instances and assignment paths contribute. Role-derived privilege only; it is not effective access to a record.
 */
export function TablePrivilegesPanel({ load, loadKey, subject, subjectName }: Props) {
  const services = useReportServices();
  const result = useReadResult<TablePrivilegeAnalysis>(load, `tp:${loadKey}`);
  const [view, setView] = useState<MatrixView>('privilege');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Selected | null>(null);
  const searchId = useId();

  const state = result.state;
  const analysis = state.phase === 'done' && state.result.status !== 'error' ? state.result.data : null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const tables = analysis?.tables ?? [];
    return q === '' ? tables : tables.filter((t) => t.displayName.toLowerCase().includes(q) || t.logicalName.toLowerCase().includes(q));
  }, [analysis, query]);
  const shown = filtered.slice(0, limit);
  // The export is every table that matches the search (not only the page on screen), with the search named in the file.
  const reportMeta = () => ({
    environment: services.environment,
    exportedAtMs: services.now(),
    filterNote: query.trim() ? `table name contains "${query.trim()}"` : 'all tables with at least one grant',
    ...(state.phase === 'done' && state.result.status === 'partial' ? { partialNotes: state.result.notes } : {}),
  });
  const selectedTable = selected ? analysis?.tables.find((t) => t.logicalName === selected.table) ?? null : null;

  return (
    <section className="tp" aria-label="Table privileges">
      <p className="access-hint">
        The privileges the roles {subject === 'team' ? 'assigned to this team' : 'of this user'} grant on each table. {subject === 'team' ? 'This is what the team’s own roles grant, not what its members effectively have. ' : ''}
        Ownership, sharing, the business unit hierarchy and field security are not evaluated, so this is not access to a particular record.
      </p>
      {state.phase === 'loading' && <p role="status">Reading the privileges of the roles…</p>}
      {state.phase === 'done' && state.result.status === 'error' && (
        <div className="access-error" role="alert">
          <p>The table privileges could not be loaded: {state.result.message}</p>
          <button type="button" onClick={result.retry}>Retry</button>
        </div>
      )}
      {state.phase === 'done' && state.result.status === 'partial' && <p className="access-partial" role="alert">Incomplete: {state.result.notes.join(' ')} Cells that could not be determined are shown as unknown, never as no grant.</p>}
      {analysis && (
        <>
          {analysis.roles.length === 0 ? (
            state.phase === 'done' && state.result.status === 'partial' ? (
              <p className="access-hint">No roles could be read for this {subject}, so nothing can be said about its table privileges. This is not the same as having no roles.</p>
            ) : (
              <p className="access-hint">{subject === 'team' ? 'This team has no roles assigned' : 'This user has no roles'}, so there are no table privileges to show.</p>
            )
          ) : (
            <>
              <div className="matrix-tools">
                <div className="bu-field">
                  <label htmlFor={searchId}>Find a table</label>
                  <input id={searchId} type="search" autoComplete="off" placeholder="Display or logical name" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
                </div>
                <ViewSwitch value={view} onChange={setView} />
                <ExportBar
                  label={`table privileges of this ${subject}`}
                  fileBase={`${subject}-table-privileges`}
                  disabled={filtered.length === 0}
                  text={() => accessToText({ kind: subject, name: subjectName ?? `(${subject})` }, filtered, reportMeta())}
                  csv={() => accessToCsv({ kind: subject, name: subjectName ?? `(${subject})` }, filtered, reportMeta().partialNotes ?? [])}
                />
              </div>
              <p className="access-live" role="status" aria-live="polite">
                {filtered.length} table{filtered.length === 1 ? '' : 's'} with at least one grant from {analysis.roles.length} role{analysis.roles.length === 1 ? '' : 's'}.
              </p>
              {view === 'depth' && <DepthLegend />}
              {filtered.length === 0 ? (
                <p className="access-hint">No table matches this search.</p>
              ) : view === 'privilege' ? (
                <PrivilegeView rows={shown} selected={selected} onSelect={setSelected} />
              ) : (
                <DepthView rows={shown} selected={selected} onSelect={setSelected} />
              )}
              {filtered.length > shown.length && (
                <p className="access-hint">Showing {shown.length} of {filtered.length} tables. <button type="button" onClick={() => setLimit((l) => l + PAGE)}>Show more</button></p>
              )}
              {selectedTable && selected ? <Provenance table={selectedTable} operation={selected.operation} subject={subject} /> : <p className="access-hint">Select a cell to see which roles contribute to it.</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}
