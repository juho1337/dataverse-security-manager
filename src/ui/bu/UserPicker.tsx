import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { BuManagerReader } from '../../application/buManager/ports';
import type { UserSummary } from '../../domain/buMove/types';
import type { UserHit } from '../../ports/accessReader';
import type { BuManager } from './useBuManager';

type Search =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly hits: readonly UserHit[]; readonly notes: readonly string[] }
  | { readonly kind: 'error'; readonly message: string };

const statusOf = (u: UserSummary): string | null => (u.isApplicationUser ? 'application user' : u.isDisabled ? 'disabled' : null);

interface Row {
  readonly user: UserSummary;
  /** The business unit name when it is known (a search hit, or a user found by an earlier search); null otherwise. */
  readonly businessUnitName: string | null;
  readonly fromSearch: boolean;
}

/**
 * One table for the whole selection: the search results on top and, in the same table, the users that are already selected (including those
 * an import added or an earlier search found). A checkbox at the start of every row selects or deselects the user and clicking the row does
 * the same; the header checkbox selects all selectable results, and "Clear selection" sits below. Selecting changes nothing in the environment.
 */
export function UserPicker({ reader, manager }: { readonly reader: BuManagerReader; readonly manager: BuManager }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>({ kind: 'idle' });
  const [message, setMessage] = useState('');
  const latest = useRef(0);
  const known = useRef(new Map<string, string | null>()); // business unit names of users seen in a search, for the rows of earlier selections
  const inputId = useId();
  const hintId = useId();
  const headerId = useId();

  const run = async () => {
    const q = query.trim();
    if (q.length < 2) {
      setSearch({ kind: 'idle' });
      setMessage('Type at least 2 characters.');
      return;
    }
    const id = ++latest.current;
    setSearch({ kind: 'loading' });
    setMessage('Searching…');
    const r = await reader.searchUsers(q).catch(() => null);
    if (id !== latest.current) return; // a newer search replaced this one
    if (!r || r.status === 'error') {
      setSearch({ kind: 'error', message: r ? r.message : 'The search failed unexpectedly.' });
      setMessage('The search failed.');
      return;
    }
    const notes = r.status === 'partial' ? r.notes : [];
    for (const h of r.data) known.current.set(h.user.id, h.businessUnitName);
    setSearch({ kind: 'done', hits: r.data, notes });
    setMessage(`${r.data.length} user${r.data.length === 1 ? '' : 's'} found.`);
  };

  const selectedIds = useMemo(() => new Set(manager.selected.map((u) => u.id)), [manager.selected]);
  const hits = search.kind === 'done' ? search.hits : [];
  const resultIds = new Set(hits.map((h) => h.user.id));
  const rows: Row[] = [
    ...hits.map((h): Row => ({ user: h.user, businessUnitName: h.businessUnitName, fromSearch: true })),
    // Selected users that this search did not return stay in the same table.
    ...manager.selected.filter((u) => !resultIds.has(u.id)).map((u): Row => ({ user: u, businessUnitName: known.current.get(u.id) ?? null, fromSearch: false })),
  ];
  const selectable = hits.filter((h) => statusOf(h.user) === null);
  const selectedHits = selectable.filter((h) => selectedIds.has(h.user.id)).length;
  const allSelected = selectable.length > 0 && selectedHits === selectable.length;

  const toggle = (u: UserSummary) => {
    if (statusOf(u) !== null) return;
    if (selectedIds.has(u.id)) {
      manager.removeUser(u.id);
      setMessage(`${u.fullName} was removed from the move.`);
    } else {
      const r = manager.addUsers([u]);
      setMessage(r.added > 0 ? `${u.fullName} was added to the move.` : `${u.fullName} is already in the move.`);
    }
  };

  const toggleAll = () => {
    if (allSelected) {
      for (const h of selectable) manager.removeUser(h.user.id);
      setMessage('All results were removed from the move.');
    } else {
      const r = manager.addUsers(selectable.map((h) => h.user));
      setMessage(`${r.added} user${r.added === 1 ? '' : 's'} added to the move.`);
    }
  };

  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = selectedHits > 0 && !allSelected;
  }, [selectedHits, allSelected]);

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, u: UserSummary) => {
    if ((e.target as HTMLElement).closest('input, button, a, label')) return; // the checkbox and the buttons handle themselves
    toggle(u);
  };

  return (
    <section className="bu-panel" aria-label="Users to move">
      <h3>Users to move</h3>
      <form
        className="bu-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor={inputId}>Search users by name or email</label>
        <input id={inputId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-describedby={hintId} autoComplete="off" />
        <button type="submit">Search</button>
      </form>
      <p id={hintId} className="hint">Tick a row, or click it, to add or remove the user. Disabled and application users are shown but cannot be moved.</p>
      <p className="sr-only" role="status" aria-live="polite">{message}</p>

      {search.kind === 'error' && <p role="alert" className="msg msg-error">{search.message}</p>}
      {search.kind === 'done' && search.notes.length > 0 && <p role="note" className="msg msg-warn">{search.notes.join(' ')}</p>}
      {search.kind === 'done' && hits.length === 0 && <p className="hint">No users match this search.</p>}

      {rows.length > 0 ? (
        <table className="bu-results bu-select-table" aria-label="Users">
          <thead>
            <tr>
              <th scope="col" className="bu-check">
                <input
                  ref={headerBox}
                  id={headerId}
                  type="checkbox"
                  aria-label="Select all results"
                  checked={allSelected}
                  disabled={selectable.length === 0}
                  onChange={toggleAll}
                />
              </th>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Current business unit</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const u = row.user;
              const status = statusOf(u);
              const on = selectedIds.has(u.id);
              const firstExtra = !row.fromSearch && (i === 0 || rows[i - 1]?.fromSearch === true);
              return (
                <tr key={u.id} data-selected={on ? 'true' : undefined} data-disabled={status ? 'true' : undefined} data-extra={!row.fromSearch ? 'true' : undefined} onClick={(e) => onRowClick(e, u)}>
                  <td className="bu-check">
                    <input type="checkbox" aria-label={`Select ${u.fullName}`} checked={on} disabled={status !== null} onChange={() => toggle(u)} />
                  </td>
                  <th scope="row"><span className="bu-name">{u.fullName}</span>{firstExtra && hits.length > 0 && <span className="hint"> · selected earlier, not in this search</span>}</th>
                  <td>{u.email || 'no email'}</td>
                  <td>{row.businessUnitName ?? <span className="hint">not shown</span>}</td>
                  <td>{status ? <span className="bu-badge">{status}</span> : on ? <span className="bu-badge bu-badge-on">selected</span> : <span className="hint">can be moved</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        search.kind !== 'done' && <p className="hint">No users selected yet. Search above or import a list.</p>
      )}

      <div className="bu-select-footer">
        <span role="status">{manager.selected.length === 0 ? 'No users selected.' : `Selected (${manager.selected.length})`}</span>
        <button type="button" onClick={() => manager.clearUsers()} disabled={manager.selected.length === 0}>Clear selection</button>
      </div>
    </section>
  );
}
