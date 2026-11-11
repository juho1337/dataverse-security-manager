import { useId, useMemo, useState, type MouseEvent } from 'react';
import type { Role } from '../../../domain/buMove/types';
import { normalizeId } from '../../../domain/operations';
import { Icon } from '../../Icon';

const LIMIT = 100;

interface Props {
  /** Every role of the user's Business Unit. */
  readonly roles: readonly Role[];
  readonly businessUnitName: string;
  /** Normalized ids of the roles the user already holds directly. */
  readonly heldIds: ReadonlySet<string>;
  /** Normalized ids staged to be added. */
  readonly stagedIds: ReadonlySet<string>;
  /** Why nothing can be added at all (a disabled user, data read only in part); null when roles can be chosen. */
  readonly blockedReason: string | null;
  readonly onToggle: (roleId: string) => void;
  readonly onClose: () => void;
}

/**
 * The searchable, multi-select role table. It works like the user selection of the BU Manager: a checkbox at the start of every row (clicking
 * the row does the same), a search that filters the table, and a status column that tells assigned from assignable. Choosing only stages a
 * change: nothing is written until the preview is confirmed. The list scrolls inside the table area, so the actions above it stay in view.
 */
export function RolePicker({ roles, businessUnitName, heldIds, stagedIds, blockedReason, onToggle, onClose }: Props) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q === '' ? roles : roles.filter((r) => r.name.toLowerCase().includes(q));
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [roles, query]);
  const shown = matches.slice(0, LIMIT);

  const onRow = (e: MouseEvent<HTMLTableRowElement>, r: Role) => {
    if (blockedReason !== null || heldIds.has(normalizeId(r.id))) return;
    if ((e.target as HTMLElement).closest('input, button, a, label')) return; // the checkbox handles itself
    onToggle(r.id);
  };

  return (
    <section className="role-picker" aria-label="Add roles">
      <div className="role-picker-head">
        <h4><span className="rp-head-icon" aria-hidden="true"><Icon name="roles" /></span>Add roles from {businessUnitName}</h4>
        <button type="button" onClick={onClose}>Done</button>
      </div>
      {blockedReason && <p className="access-partial" role="note">{blockedReason}</p>}
      <p className="access-hint role-picker-info">A user can hold only the roles of their own business unit. To give a role of another business unit, move the user there first in BU Manager.</p>
      <div className="role-picker-search">
        <label htmlFor={searchId}>Search roles</label>
        <span className="search-field">
          <Icon name="access" />
          <input id={searchId} type="search" autoComplete="off" placeholder="Type part of a role name" value={query} onChange={(e) => setQuery(e.target.value)} />
        </span>
      </div>
      <p className="access-live" role="status" aria-live="polite">
        {matches.length} role{matches.length === 1 ? '' : 's'} found{stagedIds.size > 0 ? `, ${stagedIds.size} chosen to add` : ''}. Nothing is saved until you preview and confirm.
      </p>
      {matches.length === 0 ? (
        <p className="access-hint">No role matches this search.</p>
      ) : (
        <div className="role-table-scroll">
          <table className="role-table" aria-label={`Roles of ${businessUnitName}`}>
            <thead>
              <tr>
                <th scope="col" className="role-check"><span className="sr-only">Choose</span></th>
                <th scope="col">Role</th>
                <th scope="col">Business unit</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const key = normalizeId(r.id);
                const held = heldIds.has(key);
                const chosen = stagedIds.has(key);
                return (
                  <tr key={r.id} data-state={held ? 'held' : chosen ? 'chosen' : 'free'} onClick={(e) => onRow(e, r)}>
                    <td className="role-check">
                      <input type="checkbox" aria-label={`${r.name}${held ? ' (already assigned)' : ''}`} checked={held || chosen} disabled={held || blockedReason !== null} onChange={() => onToggle(r.id)} />
                    </td>
                    <th scope="row"><span className="access-result-name">{r.name}</span></th>
                    <td>{businessUnitName}</td>
                    <td>
                      {held ? <span className="access-badge">already assigned</span> : chosen ? <span className="access-badge access-badge-on">will be added</span> : <span className="access-result-meta">can be added</span>}
                      {r.isManaged && <span className="access-badge access-badge-managed" title="Managed roles belong to a solution; they can be assigned, but not edited here.">managed</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {matches.length > shown.length && <p className="access-hint">Showing the first {LIMIT} of {matches.length} roles. Narrow the search to find the others.</p>}
    </section>
  );
}
