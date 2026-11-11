import { useId, useState } from 'react';
import { groupTeamRoles, originText, SCOPE_NOTICE, statusLabel } from '../../application/access/userAccessView';
import type { AccessComparison } from '../../application/access/userAccessView';
import { loadComparison } from '../../application/access/loadComparison';
import type { RoleGrant, UserAccess } from '../../domain/buMove/types';
import type { AccessReader, UserHit } from '../../ports/accessReader';
import { useReadResult, type AsyncState } from '../useAsync';
import { loadUserTablePrivileges } from '../../application/access/tablePrivileges';
import { AssignRoles, RECORD_ACCESS_NOTE } from './assign/AssignRoles';
import { RefreshButton } from '../RefreshButton';
import { TablePrivilegesPanel } from './TablePrivileges';
import type { RoleAssignments } from './assign/useRoleAssignments';
import { normalizeId } from '../../domain/operations';

/** The two views of a selected user or team: its security roles, and the table privileges those roles grant. */
export function DetailTabs({ tab, onChange }: { readonly tab: 'roles' | 'tables'; readonly onChange: (t: 'roles' | 'tables') => void }) {
  return (
    <div role="group" aria-label="Show" className="access-filter detail-tabs">
      <button type="button" aria-pressed={tab === 'roles'} onClick={() => onChange('roles')}>Security roles</button>
      <button type="button" aria-pressed={tab === 'tables'} onClick={() => onChange('tables')}>Table privileges</button>
    </div>
  );
}

/** The one short notice about what role privileges are: not access to individual records. The full wording is one click away. */
export function ScopeNotice() {
  return (
    <details className="access-scope" role="note">
      <summary>Roles show privileges, not access to individual records.</summary>
      <p>{SCOPE_NOTICE}</p>
      <p>{RECORD_ACCESS_NOTE}</p>
    </details>
  );
}

function GrantList({ grants, empty, complete }: { readonly grants: readonly RoleGrant[]; readonly empty: string; readonly complete: boolean }) {
  if (grants.length === 0) return <p className="access-hint">{complete ? empty : 'None could be shown. Because some data could not be read, this does not mean there are none.'}</p>;
  return (
    <ul className="access-grants">
      {grants.map((g) => (
        <li key={`${g.role.id}|${g.team?.id ?? 'direct'}`}>
          <strong>{g.role.name}</strong> <span className="access-result-meta">(role business unit: {g.roleBusinessUnitName})</span>
          <div className="access-origin">Origin: {originText(g)}</div>
        </li>
      ))}
    </ul>
  );
}

/** Direct roles, one compact row each: name, business unit, origin and (when changes are possible) the Remove button on the same row. */
function DirectRoleRows({ grants, assign, userId, complete }: { readonly grants: readonly RoleGrant[]; readonly assign: RoleAssignments | undefined; readonly userId: string; readonly complete: boolean }) {
  if (grants.length === 0) return <p className="access-hint">{complete ? 'No roles are assigned directly to this user.' : 'None could be shown. Because some data could not be read, this does not mean there are none.'}</p>;
  const busy = assign ? assign.phase.kind !== 'idle' : false;
  return (
    <ul className="role-rows" aria-label="Direct roles that can be removed">
      {grants.map((g) => {
        const removing = assign?.staged.get(normalizeId(g.role.id)) === 'unassign';
        return (
          <li key={g.role.id} data-staged={removing ? 'remove' : undefined}>
            <span className="role-row-main">
              <strong>{g.role.name}</strong> <span className="access-result-meta">· {g.roleBusinessUnitName}</span>
              <span className="access-badge">Direct</span>
              {removing && <span className="access-badge">will be removed</span>}
              <span className="access-origin">Origin: {originText(g)}</span>
            </span>
            {assign?.available && (
              <button type="button" aria-pressed={removing} disabled={busy || !complete} onClick={() => assign.toggle(normalizeId(userId), g.role.id, 'unassign')}>
                {removing ? 'Keep' : 'Remove'}<span className="sr-only"> {g.role.name}</span>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Roles that come through a team: shown in the same row style, with the reason there is no Remove. */
function TeamRoleRows({ grants, teamName }: { readonly grants: readonly RoleGrant[]; readonly teamName: string }) {
  return (
    <ul className="role-rows" aria-label={`Roles through ${teamName}`}>
      {grants.map((g) => (
        <li key={`${g.role.id}|${g.team?.id ?? 'team'}`}>
          <span className="role-row-main">
            <strong>{g.role.name}</strong> <span className="access-result-meta">· {g.roleBusinessUnitName}</span>
            <span className="access-badge">Via team</span>
            <span className="access-origin">Origin: {originText(g)}</span>
          </span>
          <span className="access-result-meta">Cannot be removed here: change the team's roles or its membership.</span>
        </li>
      ))}
    </ul>
  );
}

function Holdings({ items }: { readonly items: readonly { readonly roleId: string; readonly roleName: string; readonly businessUnitName: string; readonly origins: readonly string[] }[] }) {
  return (
    <ul className="access-grants">
      {items.map((h) => (
        <li key={h.roleId}>
          <strong>{h.roleName}</strong> <span className="access-result-meta">({h.businessUnitName})</span>
          <div className="access-origin">Origin: {h.origins.join('; ')}</div>
        </li>
      ))}
    </ul>
  );
}

function ComparisonView({ comparison }: { readonly comparison: AccessComparison }) {
  const { left, right } = comparison;
  return (
    <div className="access-compare">
      {comparison.incomplete && (
        <p className="access-partial" role="note">Incomplete: at least one user's data could not be read completely, so a role missing on one side may be a data gap rather than a real difference.</p>
      )}
      <h4>Only {left.user.fullName}</h4>
      {comparison.onlyLeft.length === 0 ? <p className="access-hint">No roles only {left.user.fullName} holds.</p> : <Holdings items={comparison.onlyLeft} />}
      <h4>Only {right.user.fullName}</h4>
      {comparison.onlyRight.length === 0 ? <p className="access-hint">No roles only {right.user.fullName} holds.</p> : <Holdings items={comparison.onlyRight} />}
      <h4>Both hold</h4>
      {comparison.both.length === 0 ? (
        <p className="access-hint">No roles in common.</p>
      ) : (
        <ul className="access-grants">
          {comparison.both.map((b) => (
            <li key={b.roleId}>
              <strong>{b.roleName}</strong> <span className="access-result-meta">({b.businessUnitName})</span>
              <div className="access-origin">{left.user.fullName}: {b.leftOrigins.join('; ')}</div>
              <div className="access-origin">{right.user.fullName}: {b.rightOrigins.join('; ')}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Compare({ reader, access, candidates }: { readonly reader: AccessReader; readonly access: UserAccess; readonly candidates: readonly UserHit[] }) {
  const selectId = useId();
  const [otherId, setOtherId] = useState('');
  const others = candidates.filter((c) => c.user.id !== access.user.id);
  const cmp = useReadResult<AccessComparison>(otherId ? () => loadComparison(reader, access.user.id, otherId) : null, `${access.user.id}|${otherId}`);
  if (others.length === 0) return <p className="access-hint">To compare, search for more than one user; the other users in the result list can then be picked here.</p>;
  const state = cmp.state;
  return (
    <section className="access-section" aria-label="Compare">
      <h3>Compare with another user</h3>
      <label htmlFor={selectId}>Compare {access.user.fullName} with</label>
      <select id={selectId} value={otherId} onChange={(e) => setOtherId(e.target.value)}>
        <option value="">(none)</option>
        {others.map((o) => <option key={o.user.id} value={o.user.id}>{o.user.fullName}</option>)}
      </select>
      <div aria-live="polite">
        {state.phase === 'loading' && <p>Loading comparison...</p>}
        {state.phase === 'done' && state.result.status === 'error' && (
          <div className="access-error" role="alert">
            <p>The comparison failed: {state.result.message}</p>
            <button type="button" onClick={cmp.retry}>Retry</button>
          </div>
        )}
        {state.phase === 'done' && state.result.status === 'partial' && <p className="access-partial" role="note">Incomplete: {state.result.notes.join(' ')}</p>}
        {state.phase === 'done' && state.result.status !== 'error' && <ComparisonView comparison={state.result.data} />}
      </div>
    </section>
  );
}

interface Props {
  readonly state: AsyncState<UserAccess>;
  readonly reader: AccessReader;
  readonly candidates: readonly UserHit[];
  readonly onRetry: () => void;
  /** Reads the user's access (and the table privileges) again, keeping the view on screen meanwhile. Absent: no refresh button. */
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
  /** Changes with every refresh so that the table privileges are read again as well. */
  readonly refreshEpoch?: number;
  /** Direct role assignment (issue #270). Absent when the explorer was given no assignment state (read-only use). */
  readonly assignment?: RoleAssignments;
}

/** Detail view of one user: status, business unit, direct roles, team-derived roles grouped by team, the scope notice and a comparison. */
export function UserDetail({ state, reader, candidates, onRetry, onRefresh, refreshing = false, refreshEpoch = 0, assignment }: Props) {
  const [tab, setTab] = useState<'roles' | 'tables'>('roles');
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') return <p role="status">Loading access...</p>;
  const result = state.result;
  if (result.status === 'error') {
    return (
      <div className="access-error" role="alert">
        <p>The user's access could not be loaded: {result.message}</p>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  const access = result.data;
  const groups = groupTeamRoles(access);
  const complete = access.isComplete && result.status === 'ok';
  return (
    <article className="access-detail" aria-label={`Access of ${access.user.fullName}`}>
      <div className="access-title-row">
        <h2>{access.user.fullName}</h2>
        {onRefresh && <RefreshButton label={`Refresh the access of ${access.user.fullName}`} onClick={onRefresh} busy={refreshing} />}
      </div>
      <p>
        <span className="access-badge">{statusLabel(access.user)}</span> {access.user.email || 'no email'} &middot; Business unit: {access.businessUnitName}
      </p>
      <DetailTabs tab={tab} onChange={setTab} />
      <ScopeNotice />
      {!complete && (
        <div className="access-partial" role="alert">
          <p><strong>Incomplete data.</strong> What is listed is what could be read; roles may be missing. Never read an empty list here as "no access".</p>
          <ul>{access.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      {tab === 'tables' && (
        <TablePrivilegesPanel
          subject="user"
          subjectName={access.user.fullName}
          loadKey={`${access.user.id}|${[...access.directRoles, ...access.teamRoles].map((g) => `${g.role.id}@${g.team?.id ?? 'direct'}`).sort().join(',')}|${access.isComplete}|${refreshEpoch}`}
          load={() => loadUserTablePrivileges(reader, access)}
        />
      )}
      {tab === 'roles' && (
        <>
        {assignment && <AssignRoles access={access} reader={reader} assign={assignment} />}
        <section className="access-section" aria-label="Direct roles">
          <h3>Direct roles ({access.directRoles.length})</h3>
          <DirectRoleRows grants={access.directRoles} assign={assignment} userId={access.user.id} complete={complete} />
        </section>
        <section className="access-section" aria-label="Team-derived roles">
          <h3>Roles through teams ({access.teamRoles.length})</h3>
          {groups.length === 0 && <GrantList grants={[]} empty="No roles come through teams." complete={complete} />}
          {groups.map((g) => (
            <div key={g.teamId} className="access-team-group">
              <h4>{g.heading}</h4>
              <TeamRoleRows grants={g.grants} teamName={g.heading} />
            </div>
          ))}
        </section>
        <Compare reader={reader} access={access} candidates={candidates} />
        </>
      )}
    </article>
  );
}
