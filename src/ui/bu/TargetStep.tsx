import { useId, useMemo, useState } from 'react';
import type { BusinessUnit, UserSummary } from '../../domain/buMove/types';
import type { BuManager } from './useBuManager';

export interface UnitsView {
  readonly loading: boolean;
  readonly error: string | null;
  readonly notes: readonly string[];
  readonly list: readonly BusinessUnit[];
  readonly retry: () => void;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Why a business unit cannot be the target of this move; null when it can. */
export function targetReason(unit: BusinessUnit, selected: readonly UserSummary[]): string | null {
  if (unit.isDisabled) return 'this business unit is disabled';
  if (selected.length > 0 && selected.every((u) => same(u.businessUnitId, unit.id))) {
    return selected.length === 1 ? 'the user is already in this business unit' : 'all selected users are already in this business unit';
  }
  return null;
}

interface Row {
  readonly unit: BusinessUnit;
  readonly depth: number;
}

/** The hierarchy, depth first, siblings by name. A unit whose parent is not in the data is shown at the top level (never dropped, never cyclic). */
export function flattenUnits(units: readonly BusinessUnit[], query: string): readonly Row[] {
  const ids = new Set(units.map((u) => u.id));
  const children = new Map<string | null, BusinessUnit[]>();
  for (const u of units) {
    const parent = u.parentId !== null && ids.has(u.parentId) && u.parentId !== u.id ? u.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), u]);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const q = query.trim().toLowerCase();
  // With a search text a unit is shown when it matches or when something below it matches (so the path to a match stays visible).
  const shown = new Set<string>();
  const walkMatch = (u: BusinessUnit, seen: Set<string>): boolean => {
    if (seen.has(u.id)) return false;
    seen.add(u.id);
    let any = q === '' || u.name.toLowerCase().includes(q);
    for (const c of children.get(u.id) ?? []) any = walkMatch(c, seen) || any;
    if (any) shown.add(u.id);
    return any;
  };
  const seen = new Set<string>();
  for (const root of children.get(null) ?? []) walkMatch(root, seen);
  const rows: Row[] = [];
  const emitted = new Set<string>();
  const emit = (u: BusinessUnit, depth: number) => {
    if (emitted.has(u.id)) return;
    emitted.add(u.id);
    if (shown.has(u.id)) rows.push({ unit: u, depth });
    for (const c of children.get(u.id) ?? []) emit(c, depth + 1);
  };
  for (const root of children.get(null) ?? []) emit(root, 0);
  return rows;
}

/** Step 2: the destination. A searchable hierarchy; units that cannot be chosen say why. Nothing is read or written by choosing. */
export function TargetStep({ manager, units }: { readonly manager: BuManager; readonly units: UnitsView }) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const groupName = useId();
  const rows = useMemo(() => flattenUnits(units.list, query), [units.list, query]);
  const byId = useMemo(() => new Map(units.list.map((u) => [u.id.toLowerCase(), u])), [units.list]);
  const target = units.list.find((u) => u.id === manager.targetId);

  const current = new Map<string, number>();
  for (const u of manager.selected) {
    const name = byId.get(u.businessUnitId.toLowerCase())?.name ?? 'a business unit that was not read';
    current.set(name, (current.get(name) ?? 0) + 1);
  }

  return (
    <section className="bu-panel" aria-label="Target business unit">
      <h3>Where should the {manager.selected.length === 1 ? 'user' : `${manager.selected.length} users`} move?</h3>
      {current.size > 0 && (
        <p className="hint">
          Now in: {[...current.entries()].map(([name, n]) => `${name} (${n} user${n === 1 ? '' : 's'})`).join(', ')}
        </p>
      )}
      {units.loading && <p role="status" className="hint">Loading business units…</p>}
      {units.error && <p role="alert" className="msg msg-error">{units.error} <button type="button" onClick={units.retry}>Retry</button></p>}
      {units.notes.length > 0 && <p role="note" className="msg msg-warn">⚠ {units.notes.join(' ')}</p>}
      <div className="bu-field">
        <label htmlFor={searchId}>Find a business unit</label>
        <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      </div>
      <p className="sr-only" role="status" aria-live="polite">{rows.length} business unit{rows.length === 1 ? '' : 's'} shown.</p>
      {!units.loading && rows.length === 0 && !units.error && <p className="hint">No business unit matches.</p>}
      {rows.length > 0 && (
        <fieldset className="wz-bu-list">
          <legend>Target business unit</legend>
          {rows.map(({ unit, depth }) => {
            const reason = targetReason(unit, manager.selected);
            return (
              <label key={unit.id} className="wz-bu" data-disabled={reason ? 'true' : undefined} style={{ paddingLeft: `${8 + depth * 18}px` }}>
                <input type="radio" name={groupName} value={unit.id} checked={unit.id === manager.targetId} disabled={reason !== null} onChange={() => manager.setTarget(unit.id)} />{' '}
                <span className="bu-name">{unit.name}</span>
                {reason && <span className="hint"> · not available: {reason}</span>}
              </label>
            );
          })}
        </fieldset>
      )}
      <p className="wz-selected" role="status">
        {target ? <>Destination: <strong>{target.name}</strong></> : 'No destination chosen yet.'}
      </p>
    </section>
  );
}
