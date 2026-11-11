import { useState } from 'react';
import { loadTeamTablePrivileges } from '../../application/access/tablePrivileges';
import type { AccessReader, TeamAccess } from '../../ports/accessReader';
import { statusLabel } from '../../application/access/userAccessView';
import type { AsyncState } from '../useAsync';
import type { Selection } from './SearchPanel';
import { TablePrivilegesPanel } from './TablePrivileges';
import { DetailTabs, ScopeNotice } from './UserDetail';
import { RefreshButton } from '../RefreshButton';

interface Props {
  readonly reader: AccessReader;
  readonly state: AsyncState<TeamAccess>;
  readonly onRetry: () => void;
  /** Reads the team (and its table privileges) again, keeping the view on screen meanwhile. Absent: no refresh button. */
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
  readonly refreshEpoch?: number;
  readonly onSelect: (s: Selection) => void;
}

/** Detail view of one team: type, business unit, its roles and its (capped) members; a member opens that user. */
export function TeamDetail({ reader, state, onRetry, onRefresh, refreshing = false, refreshEpoch = 0, onSelect }: Props) {
  const [tab, setTab] = useState<'roles' | 'tables'>('roles');
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') return <p role="status">Loading team...</p>;
  const result = state.result;
  if (result.status === 'error') {
    return (
      <div className="access-error" role="alert">
        <p>The team could not be loaded: {result.message}</p>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  const { team, roles, members } = result.data;
  const incomplete = result.status === 'partial';
  return (
    <article className="access-detail" aria-label={`Team ${team.name}`}>
      <div className="access-title-row">
        <h2>{team.name}</h2>
        {onRefresh && <RefreshButton label={`Refresh the access of team ${team.name}`} onClick={onRefresh} busy={refreshing} />}
      </div>
      <p>
        <span className="access-badge">{team.type === 'Default' ? 'default team' : `${team.type.toLowerCase()} team`}</span> Business unit: {team.businessUnitName ?? 'not read'}
      </p>
      <DetailTabs tab={tab} onChange={setTab} />
      <ScopeNotice />
      {incomplete && (
        <div className="access-partial" role="alert">
          <p><strong>Incomplete data.</strong> An empty list here is not proof that there are no roles or members.</p>
          <ul>{result.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
      {tab === 'tables' && <TablePrivilegesPanel subject="team" subjectName={result.data.team.name} loadKey={`${team.id}|${roles.map((r) => r.role.id).sort().join(',')}|${refreshEpoch}`} load={() => loadTeamTablePrivileges(reader, result.data)} />}
      {tab === 'roles' && (
        <>
        <section className="access-section" aria-label="Team roles">
          <h3>Roles of this team ({roles.length})</h3>
          {team.type === 'Access' && <p className="access-hint">Access teams carry no security roles.</p>}
          {roles.length === 0 && team.type !== 'Access' && <p className="access-hint">{incomplete ? 'None could be shown.' : 'This team has no roles.'}</p>}
          <ul className="access-grants">
            {roles.map((r) => (
              <li key={r.role.id}>
                <strong>{r.role.name}</strong> <span className="access-result-meta">(role business unit: {r.businessUnitName ?? 'not read'})</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="access-section" aria-label="Team members">
          <h3>Members ({members.length}{result.data.membersTruncated ? ' shown' : ''})</h3>
          {members.length === 0 && <p className="access-hint">{incomplete ? 'None could be shown.' : 'This team has no members.'}</p>}
          <ul>
            {members.map((m) => (
              <li key={m.user.id}>
                <button type="button" className="access-result" onClick={() => onSelect({ kind: 'user', id: m.user.id })}>
                  <span className="access-result-name">{m.user.fullName}</span>
                  {statusLabel(m.user) !== 'enabled' && <span className="access-badge">{statusLabel(m.user)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
        </>
      )}
    </article>
  );
}
