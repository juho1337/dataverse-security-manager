import { useEffect, useId, useMemo, useState } from 'react';
import { normalizeId } from '../../../domain/operations';
import type { Role, UserAccess } from '../../../domain/buMove/types';
import type { AccessReader, AssignmentContext } from '../../../ports/accessReader';
import { useReadResult } from '../../useAsync';
import { Icon } from '../../Icon';
import { RolePicker } from './RolePicker';
import type { RoleAssignments } from './useRoleAssignments';

// The staging side of direct role assignment. Removing a role sits on the role's own row (UserDetail); adding goes through the role picker
// opened here. Staging writes nothing; the preview dialog (AssignDialogs) is the only way to a write.

export const RECORD_ACCESS_NOTE =
  'Roles decide which privileges a user has and at what depth. Whether the user can open a particular record also depends on ownership, sharing, team membership and field security. Changing a role here does not grant or remove access to individual records.';

interface Props {
  readonly access: UserAccess;
  readonly reader: AccessReader;
  readonly assign: RoleAssignments;
}

/** The bar above the role rows: Add roles, the staged-change summary, Discard and Preview changes. */
export function AssignRoles({ access, reader, assign }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const homeId = access.user.businessUnitId;
  const userKey = normalizeId(access.user.id);
  const chosen = assign.target;
  const [buQuery, setBuQuery] = useState('');
  const buSearchId = useId();
  const context = useReadResult<AssignmentContext>(assign.available && reader.loadAssignmentContext ? () => (reader.loadAssignmentContext as NonNullable<AccessReader['loadAssignmentContext']>)() : null, 'assignctx');
  const ctx = context.state.phase === 'done' && context.state.result.status !== 'error' ? context.state.result.data : null;
  const crossBu = ctx?.crossBuAssignment ?? null;
  // The target Business Unit: the user's home unit until another is chosen (only when the environment allows it); it starts again at home for the next user.
  const buId = chosen?.user === userKey && (crossBu === true || normalizeId(chosen.bu) === normalizeId(homeId)) ? chosen.bu : homeId;
  const isHome = normalizeId(buId) === normalizeId(homeId);
  const units = ctx?.businessUnits ?? [];
  const targetName = isHome ? access.businessUnitName : (units.find((b) => normalizeId(b.id) === normalizeId(buId))?.name ?? 'the chosen business unit');
  const shownUnits = useMemo(() => {
    const q = buQuery.trim().toLowerCase();
    const list = units.filter((b) => !b.isDisabled && (q === '' || b.name.toLowerCase().includes(q) || normalizeId(b.id) === normalizeId(buId)));
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [units, buQuery, buId]);
  const catalog = useReadResult<readonly Role[]>(
    assign.available && reader.listRolesOfBusinessUnit && buId ? () => (reader.listRolesOfBusinessUnit as NonNullable<AccessReader['listRolesOfBusinessUnit']>)(buId) : null,
    `roles:${buId}`,
  );
  // Roles read for every unit looked at are kept in the assignment state (above the tabs), so a preview can name staged roles of a unit the picker no longer shows.
  const loadedRaw = catalog.state.phase === 'done' && catalog.state.result.status !== 'error' ? catalog.state.result.data : null;
  // During the first render after the target unit changed, the hook still holds the previous unit's answer: it is never shown or remembered under the new unit.
  // Each role names its own unit, so the cache is keyed by that, not by the unit the picker currently asks for.
  const loadedNow = loadedRaw && loadedRaw.every((r) => normalizeId(r.businessUnitId) === normalizeId(buId)) ? loadedRaw : null;
  useEffect(() => {
    if (!loadedRaw) return;
    const byUnit = new Map<string, Role[]>();
    for (const r of loadedRaw) byUnit.set(normalizeId(r.businessUnitId), [...(byUnit.get(normalizeId(r.businessUnitId)) ?? []), r]);
    for (const [unit, roles] of byUnit) assign.remember(userKey, unit, roles);
  }, [loadedRaw, userKey, assign]);
  const held = useMemo(() => new Set(access.directRoles.map((g) => normalizeId(g.role.id))), [access.directRoles]);
  const stagedAdd = useMemo(() => new Set([...assign.staged].filter(([, a]) => a === 'assign').map(([id]) => id)), [assign.staged]);
  if (!assign.available) {
    return <p className="access-hint">Role changes are not available here: there is no verified write path to an environment in this session.</p>;
  }
  const busy = assign.phase.kind !== 'idle';
  const loaded = loadedNow;
  const stagedCount = assign.staged.size;
  const complete = access.isComplete;
  const blockedReason = access.user.isDisabled
    ? 'This user is disabled: roles can be removed, but not assigned.'
    : !complete
      ? 'The user’s access was not read completely, so roles cannot be added until it is. Reload the user and try again.'
      : null;

  return (
    <section className="access-section assign-section" aria-label="Change direct roles">
      <div role="group" aria-label="Role change actions" className="assign-bar">
        <button type="button" className="primary" aria-expanded={pickerOpen} disabled={busy} onClick={() => setPickerOpen((o) => !o)}><Icon name="plus" />Add roles</button>
        <span className={`assign-summary${stagedCount > 0 ? ' assign-summary-staged' : ''}`} aria-live="polite">{stagedCount === 0 ? 'No changes staged.' : `${stagedCount} change${stagedCount === 1 ? '' : 's'} staged. Nothing is saved until you preview and confirm.`}</span>
        <button type="button" onClick={() => assign.discard()} disabled={busy || stagedCount === 0}>Discard</button>
        <button type="button" className="primary" onClick={() => assign.openPreview(access, assign.rememberedRoles(userKey), { crossBuAssignment: crossBu, businessUnits: units })} disabled={busy || stagedCount === 0 || !complete}>Preview changes</button>
      </div>
      {!complete && <p className="access-partial" role="alert">The user’s access was not read completely, so changes are not offered until it is. Reload the user and try again.</p>}
      {pickerOpen && (
        <>
          {ctx && (
            <div className="role-picker-bu" role="group" aria-label="Target business unit">
              <p className="access-hint">
                Target business unit: <strong>{targetName}</strong>{isHome ? ' (the user’s home business unit)' : ` (the user’s home business unit is ${access.businessUnitName})`}
              </p>
              {crossBu === true ? (
                <div className="role-picker-search">
                  <label htmlFor={buSearchId}>Search business units</label>
                  <span className="search-field">
                    <Icon name="access" />
                    <input id={buSearchId} type="search" autoComplete="off" placeholder="Type part of a business unit name" value={buQuery} onChange={(e) => setBuQuery(e.target.value)} />
                  </span>
                  <select aria-label="Business unit" value={buId} onChange={(e) => assign.setTarget(userKey, e.target.value)}>
                    {shownUnits.map((b) => <option key={b.id} value={b.id}>{b.name}{normalizeId(b.id) === normalizeId(homeId) ? ' (home)' : ''}</option>)}
                  </select>
                </div>
              ) : (
                <p className="access-hint">
                  {crossBu === false
                    ? 'Roles of other business units cannot be assigned: record ownership across business units is turned off in this environment.'
                    : 'Whether roles of other business units may be assigned could not be read, so only the user’s home business unit is offered.'}
                </p>
              )}
            </div>
          )}
          {!reader.listRolesOfBusinessUnit && <p className="access-hint">The roles of this business unit cannot be listed by this reader.</p>}
          {catalog.state.phase === 'loading' && <p role="status">Loading the roles of {targetName}...</p>}
          {catalog.state.phase === 'done' && catalog.state.result.status === 'error' && (
            <div className="access-error" role="alert">
              <p>The roles of {targetName} could not be loaded: {catalog.state.result.message}</p>
              <button type="button" onClick={catalog.retry}>Retry</button>
            </div>
          )}
          {catalog.state.phase === 'done' && catalog.state.result.status === 'partial' && <p className="access-partial" role="note">Incomplete: {catalog.state.result.notes.join(' ')}</p>}
          {loaded && (
            <RolePicker
              roles={loaded}
              businessUnitName={targetName}
              isHome={isHome}
              heldIds={held}
              stagedIds={stagedAdd}
              blockedReason={blockedReason}
              onToggle={(roleId) => assign.toggle(userKey, roleId, 'assign')}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </>
      )}
      {assign.notice && <p role="alert" className="msg msg-warn">{assign.notice}</p>}
    </section>
  );
}
