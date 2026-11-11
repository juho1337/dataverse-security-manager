import type { PlannedMove } from '../../application/buManager/service';
import type { UserMovePlan } from '../../domain/buMove/types';
import { LEVEL_TEXT } from './labels';

const names = (list: readonly string[]): string => (list.length === 0 ? 'none' : list.join(', '));

/**
 * The roles the plan will assign after the move (restore decisions with a chosen target role), by name. Two source roles that map to the SAME target
 * role are one assignment (the write plan sends it once), so they are listed and counted once.
 */
export function rolesToRestore(u: UserMovePlan): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of u.decisions) {
    if (d.outcome !== 'restore' || d.chosen === null) continue;
    const id = d.chosen.role.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(`${d.chosen.role.name} (${LEVEL_TEXT[d.chosen.level]})`);
  }
  return out;
}

/** Roles that stay because the move is expected to keep them. An expectation, never a certainty. */
function rolesKept(u: UserMovePlan): readonly string[] {
  return u.survival.filter((s) => s.kind === 'expectedRetained').map((s) => s.role.name);
}

/**
 * Step 4: the dry run in plain words. Per user: before -> after for the business unit, the direct roles now, the roles that will be assigned,
 * the warnings, and the users that are left out with the reason. It writes nothing; the confirmation dialog is the only way forward.
 */
export function ReviewStep({ planned, targetName }: { readonly planned: PlannedMove; readonly targetName: string }) {
  const { plan, writes } = planned;
  const excluded = new Map(writes.excluded.map((x) => [x.userId, x.reason]));
  const writeCount = writes.plan?.writes.length ?? 0;
  const moving = plan.users.filter((u) => !excluded.has(u.user.id));
  const restoreTotal = moving.reduce((n, u) => n + rolesToRestore(u).length, 0);
  return (
    <section className="bu-panel" aria-label="Review">
      <h3>Review the changes</h3>
      <p className="hint">Nothing has been changed. Confirming sends exactly these changes to <strong>{targetName}</strong>, and every step is checked by reading the user again.</p>
      <dl className="wz-summary" aria-label="Summary of the planned operations">
        <div><dt>Users to move</dt><dd>{moving.length}</dd></div>
        <div><dt>Role assignments after the move</dt><dd>{restoreTotal}</dd></div>
        <div><dt>Changes to send</dt><dd>{writeCount}</dd></div>
        <div><dt>Left out</dt><dd>{excluded.size}</dd></div>
      </dl>
      {[...plan.warnings, ...planned.notes].map((w) => <p key={w} role="note" className="msg msg-warn">⚠ {w}</p>)}
      {plan.users.map((u) => {
        const reason = excluded.get(u.user.id);
        const restore = rolesToRestore(u);
        return (
          <article key={u.user.id} className="bu-user wz-review-user" aria-label={`Review of ${u.user.fullName}`} data-blocked={reason ? 'true' : undefined}>
            <h4>
              {u.user.fullName}{' '}
              <span className="hint">{u.currentBusinessUnit ?? 'unknown business unit'} → {plan.targetBusinessUnitName}</span>
              {reason && <span className="bu-badge"> ⚠ left out</span>}
            </h4>
            {reason ? (
              <p role="note" className="msg msg-warn">Not part of this move: {reason}</p>
            ) : (
              <ul className="wz-facts">
                <li><strong>Roles held directly now:</strong> {names(u.directRoles.map((g) => g.role.name))}</li>
                <li><strong>Roles expected to stay with the move:</strong> {names(rolesKept(u))}</li>
                <li><strong>Roles that will be assigned after the move:</strong> {names(restore)}</li>
              </ul>
            )}
            {!u.dataComplete && <p role="note" className="msg msg-warn">⚠ Some of this user's access could not be read completely, so this preview may be incomplete.</p>}
            {u.risks.length > 0 && (
              <ul aria-label={`Risks for ${u.user.fullName}`} className="bu-risks">
                {u.risks.map((r) => <li key={r}>⚠ {r}</li>)}
              </ul>
            )}
            {u.teamRoles.length > 0 && <p className="hint">Roles through teams ({u.teamRoles.length}) are not changed here.</p>}
            {!reason && (
              <details>
                <summary>What this preview cannot verify</summary>
                <ul>{u.cannotVerifyBeforeMove.map((c) => <li key={c}>{c}</li>)}</ul>
              </details>
            )}
          </article>
        );
      })}
      {writeCount === 0 && <p className="hint">There is nothing to send: every user is left out. Go back to change the users, the destination or the role mapping.</p>}
    </section>
  );
}
