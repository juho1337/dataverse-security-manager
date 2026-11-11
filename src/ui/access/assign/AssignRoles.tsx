import { useMemo, useState } from 'react';
import { normalizeId } from '../../../domain/operations';
import type { Role, UserAccess } from '../../../domain/buMove/types';
import type { AccessReader } from '../../../ports/accessReader';
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
  const buId = access.user.businessUnitId;
  const catalog = useReadResult<readonly Role[]>(
    assign.available && reader.listRolesOfBusinessUnit && buId ? () => (reader.listRolesOfBusinessUnit as NonNullable<AccessReader['listRolesOfBusinessUnit']>)(buId) : null,
    `roles:${buId}`,
  );
  const userKey = normalizeId(access.user.id);
  const held = useMemo(() => new Set(access.directRoles.map((g) => normalizeId(g.role.id))), [access.directRoles]);
  const stagedAdd = useMemo(() => new Set([...assign.staged].filter(([, a]) => a === 'assign').map(([id]) => id)), [assign.staged]);
  if (!assign.available) {
    return <p className="access-hint">Role changes are not available here: there is no verified write path to an environment in this session.</p>;
  }
  const busy = assign.phase.kind !== 'idle';
  const loaded = catalog.state.phase === 'done' && catalog.state.result.status !== 'error' ? catalog.state.result.data : null;
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
        <button type="button" className="primary" onClick={() => assign.openPreview(access, loaded ?? [])} disabled={busy || stagedCount === 0 || !complete}>Preview changes</button>
      </div>
      {!complete && <p className="access-partial" role="alert">The user’s access was not read completely, so changes are not offered until it is. Reload the user and try again.</p>}
      {pickerOpen && (
        <>
          {!reader.listRolesOfBusinessUnit && <p className="access-hint">The roles of this business unit cannot be listed by this reader.</p>}
          {catalog.state.phase === 'loading' && <p role="status">Loading the roles of {access.businessUnitName}...</p>}
          {catalog.state.phase === 'done' && catalog.state.result.status === 'error' && (
            <div className="access-error" role="alert">
              <p>The roles of {access.businessUnitName} could not be loaded: {catalog.state.result.message}</p>
              <button type="button" onClick={catalog.retry}>Retry</button>
            </div>
          )}
          {catalog.state.phase === 'done' && catalog.state.result.status === 'partial' && <p className="access-partial" role="note">Incomplete: {catalog.state.result.notes.join(' ')}</p>}
          {loaded && (
            <RolePicker
              roles={loaded}
              businessUnitName={access.businessUnitName}
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
