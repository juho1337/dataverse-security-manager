import type { InstanceView } from '../application/roleDetails';
import type { Person, RoleInstance, TeamNode } from '../domain/access';
import { formatCount, originOf } from '../domain/access';
import { describeOrigin } from './labels';

interface Props {
  readonly view: InstanceView;
  /** False when the data behind the counts is incomplete: counts are shown as lower bounds. */
  readonly complete: boolean;
  /** Team disclosure state is owned by the matrix so it survives filtering and re-rendering. */
  readonly isTeamOpen: (teamId: string) => boolean;
  readonly onToggleTeam: (teamId: string) => void;
}

function PersonItem({ person, instance }: { person: Person; instance: RoleInstance }) {
  const origin = originOf(person, instance);
  return (
    <li className={`person${origin.kind === 'notCounted' ? ' person-excluded' : ''}`}>
      <span className="person-name">{person.name}</span>{' '}
      <span className={`badge badge-${origin.kind}`}>{describeOrigin(origin)}</span>
    </li>
  );
}

function CountStrip({ view, complete }: { view: InstanceView; complete: boolean }) {
  const c = view.counts;
  const item = (label: string, n: number) => {
    const f = formatCount(n, complete);
    return (
      <span className="count" key={label}>
        {label} <strong>{f.text}</strong>
      </span>
    );
  };
  return (
    <p className="count-strip">
      {item('Unique users', c.uniqueUsers)} {item('Direct users', c.directUsers)}{' '}
      <span className="count">
        Teams <strong>{formatCount(c.teams, complete).text}</strong> ({formatCount(c.usersViaTeams, complete).text} user{c.usersViaTeams === 1 && complete ? '' : 's'} from teams)
      </span>{' '}
      {item('Application users', c.excludedApplication)}
      {c.excludedDisabled > 0 ? <> {item('Disabled users', c.excludedDisabled)}</> : null}
    </p>
  );
}

/** Everything about one concrete role instance, in place: counts, direct users, teams and their members. */
export function InstanceDetail({ view, complete, isTeamOpen, onToggleTeam }: Props) {
  const { instance } = view;
  const direct = instance.directUsers;
  const teams = instance.teams.map((t): { team: TeamNode; members: readonly Person[] } => ({ team: t, members: t.members }));

  return (
    <div className="instance-detail">
      <CountStrip view={view} complete={complete} />
      <div className="groups">
        <section aria-label={`Direct users (${instance.directUsers.length})`}>
          <h4>Direct users ({instance.directUsers.length})</h4>
          {instance.directUsers.length === 0 ? (
            <p className="hint">No user holds this role directly.</p>
          ) : (
            <ul className="plist">
              {direct.map((p) => (
                <PersonItem key={p.userId} person={p} instance={instance} />
              ))}
            </ul>
          )}
        </section>
        <section aria-label={`Teams (${instance.teams.length})`}>
          <h4>Teams ({instance.teams.length})</h4>
          {instance.teams.length === 0 ? (
            <p className="hint">No team holds this role.</p>
          ) : (
            teams.map(({ team, members }) => {
              const open = isTeamOpen(team.teamId);
              return (
                <div className="team" key={team.teamId}>
                  <button type="button" aria-expanded={open} onClick={() => onToggleTeam(team.teamId)}>
                    <span aria-hidden="true">{open ? '▾' : '▸'}</span> {team.name}{' '}
                    <span className="meta">({team.teamType} team, {team.members.length} member{team.members.length === 1 ? '' : 's'})</span>
                  </button>
                  {open && (
                    <ul className="plist" aria-label={`Members of ${team.name}`}>
                      {members.map((m) => (
                        <PersonItem key={m.userId} person={m} instance={instance} />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}
