import { useEffect, useRef, useState } from 'react';
import type { BuManagerReader } from '../../application/buManager/ports';
import type { RestoreStrategy } from '../../domain/buMove/types';
import { ConfirmDialog } from './ConfirmDialog';
import { ImportPanel } from './ImportPanel';
import { PreviewPanel } from './PreviewPanel';
import { ResultPanel, RunningPanel } from './ResultPanel';
import { ReviewStep } from './ReviewStep';
import { TargetStep, targetReason, type UnitsView } from './TargetStep';
import { UserPicker } from './UserPicker';
import { WizardStepper, type StepId, type StepInfo } from './WizardStepper';
import type { Downloader } from './download';
import { STRATEGY_TEXT } from './labels';
import type { BuManager } from './useBuManager';

const LABELS: Readonly<Record<StepId, string>> = { 1: 'Select users', 2: 'Target BU', 3: 'Role mapping', 4: 'Review', 5: 'Execute' };
const MATCH_STRATEGIES: readonly RestoreStrategy[] = ['new', 'keep', 'root', 'custom'];

interface Props {
  readonly reader: BuManagerReader;
  readonly manager: BuManager;
  readonly units: UnitsView;
  readonly environmentLabel: string;
  readonly demo: boolean;
  readonly download: Downloader | undefined;
  readonly onOpenOperations: (() => void) | undefined;
}

/** Step 3: how the direct roles are handled. A recommended choice is preselected; the mapping per role follows from the dry run. */
function RoleHandling({ manager }: { readonly manager: BuManager }) {
  const restoring = manager.batchMode === 'allDirectRoles';
  return (
    <section className="bu-panel" aria-label="Role handling">
      <h3>What happens to the direct roles?</h3>
      <fieldset className="wz-choices">
        <legend>Direct roles after the move</legend>
        <label className="wz-choice">
          <input type="radio" name="bu-restore-mode" checked={restoring} onChange={() => manager.setBatchMode('allDirectRoles')} />{' '}
          <span><strong>Assign the current direct roles again</strong> <span className="bu-badge">Recommended</span><br /><span className="hint">The roles each user holds directly now are assigned again after the move, as the matching role of the target business unit.</span></span>
        </label>
        <label className="wz-choice">
          <input type="radio" name="bu-restore-mode" checked={!restoring} onChange={() => manager.setBatchMode('none')} />{' '}
          <span><strong>Do not assign any role</strong><br /><span className="hint">Move the users only. Roles that do not survive the move are not granted again.</span></span>
        </label>
      </fieldset>
      {restoring && (
        <fieldset className="wz-choices">
          <legend>How the roles are matched</legend>
          {MATCH_STRATEGIES.map((s) => (
            <label key={s} className="wz-choice">
              <input type="radio" name="bu-restore-strategy" checked={manager.strategy === s} onChange={() => manager.setStrategy(s)} />{' '}
              <span><strong>{STRATEGY_TEXT[s].label}</strong>{s === 'new' && <> <span className="bu-badge">Recommended</span></>}<br /><span className="hint">{STRATEGY_TEXT[s].help}</span></span>
            </label>
          ))}
        </fieldset>
      )}
    </section>
  );
}

/**
 * The guided flow around the existing BU Manager logic: Select users -> Target BU -> Role mapping -> Review -> Execute. The hook holds the
 * rules and the state; the wizard only decides which screen is shown. Moving between steps never writes: the only write path is the
 * confirmation dialog of step 4. Changing an earlier input makes the hook discard the plan and any confirmation, and step 3 plans again.
 */
export function BuWizard({ reader, manager, units, environmentLabel, demo, download, onOpenOperations }: Props) {
  const phase = manager.phase;
  const [step, setStep] = useState<StepId>(1);
  const recommendationApplied = useRef(false);
  const planTried = useRef('');

  const inRun = phase.kind === 'running' || phase.kind === 'done' || phase.kind === 'unknown';
  const retryPreview = phase.kind === 'preview' && phase.planned.only !== undefined;
  const current: StepId = inRun ? 5 : retryPreview ? 4 : step;

  const planned = phase.kind === 'preview' ? phase.planned : null;
  const writeCount = planned?.writes.plan?.writes.length ?? 0;
  const unresolved = planned ? planned.plan.users.reduce((n, u) => n + u.decisions.filter((d) => d.outcome === 'blocked').length, 0) : 0;
  const targetUnit = units.list.find((b) => b.id === manager.targetId);
  const targetValid = targetUnit !== undefined && targetReason(targetUnit, manager.selected) === null;
  const targetName = targetUnit?.name ?? '';
  const hasUsers = manager.selected.length > 0;

  // Step 3 plans from a fresh read as soon as it is open and again after every changed input (the hook discards the old plan). One attempt per
  // input combination: a failed plan is retried by the person, never in a loop.
  const planKey = [manager.selected.map((u) => u.id).join(','), manager.targetId, manager.strategy, manager.batchMode, JSON.stringify(manager.userMode)].join('|');
  useEffect(() => {
    if (current !== 3 || phase.kind !== 'compose' || !hasUsers || !targetValid) return;
    if (planTried.current === planKey) return;
    planTried.current = planKey;
    void manager.preview();
  }, [current, phase.kind, hasUsers, targetValid, planKey, manager]);

  // After a result is closed the wizard starts again at step 1; a plan that was discarded while step 4 was open falls back to step 3, which plans again.
  const prevKind = useRef(phase.kind);
  useEffect(() => {
    if ((prevKind.current === 'done' || prevKind.current === 'unknown') && phase.kind === 'compose') {
      planTried.current = '';
      setStep(1);
    } else if (phase.kind === 'compose' && step === 4) {
      setStep(3);
    }
    prevKind.current = phase.kind;
  }, [phase.kind, step]);

  const canReview = current === 3 && planned !== null && writeCount > 0 && unresolved === 0;
  const reach: Record<StepId, { ok: boolean; reason?: string }> = {
    1: { ok: !inRun && !retryPreview },
    2: hasUsers ? { ok: !inRun && !retryPreview } : { ok: false, reason: 'select at least one user first' },
    3: hasUsers && targetValid ? { ok: !inRun && !retryPreview } : { ok: false, reason: hasUsers ? 'choose a target business unit first' : 'select users first' },
    4: planned !== null && writeCount > 0 && unresolved === 0 && !inRun && !retryPreview ? { ok: true } : { ok: false, reason: 'finish the role mapping first' },
    5: { ok: false, reason: 'available after you confirm the changes' },
  };
  const steps: StepInfo[] = ([1, 2, 3, 4, 5] as const).map((id) => {
    const state: StepInfo['state'] = id === current ? 'current' : id === 3 && planned !== null && unresolved > 0 && current > 3 ? 'blocked' : id < current ? 'done' : 'todo';
    return { id, label: LABELS[id], state, reachable: id === current || reach[id].ok, ...(reach[id].reason ? { reason: reach[id].reason } : {}) };
  });

  const go = (id: StepId) => {
    if (inRun || retryPreview || id === current) return;
    // Going back to an input step makes the plan stale: discard it (nothing was sent), step 3 plans again.
    if (id <= 2 && phase.kind === 'preview') {
      manager.backToCompose();
      planTried.current = ''; // the plan is gone: coming back to step 3 plans again, even with the same inputs
    }
    if (id === 3 && !recommendationApplied.current) {
      recommendationApplied.current = true;
      if (manager.batchMode === 'none' && manager.strategy === 'none') {
        manager.setBatchMode('allDirectRoles');
        manager.setStrategy('new');
      }
    }
    setStep(id);
  };

  const startOver = () => {
    manager.finish();
    planTried.current = '';
    setStep(1);
  };

  return (
    <div className="wz">
      <WizardStepper steps={steps} onGo={go} />

      {current === 1 && (
        <>
          <UserPicker reader={reader} manager={manager} />
          <details className="bu-import">
            <summary>Import from a list or file</summary>
            <ImportPanel reader={reader} manager={manager} />
          </details>
        </>
      )}
      {current === 2 && <TargetStep manager={manager} units={units} />}
      {current === 3 && (
        <>
          <RoleHandling manager={manager} />
          {phase.kind === 'planning' && <p role="status" className="hint">Reading the current users, roles and privileges…</p>}
          {phase.kind === 'compose' && planTried.current === planKey && (
            <p className="hint">The role mapping could not be planned. <button type="button" onClick={() => void manager.preview()}>Try again</button></p>
          )}
          {planned !== null && <PreviewPanel planned={planned} manager={manager} targetName={targetName} canExecute={manager.canExecute} demo={demo} mapping />}
          {planned !== null && writeCount === 0 && unresolved === 0 && (
            <div role="alert" className="msg msg-warn">
              <strong>Nothing can be moved with these choices.</strong>
              {planned.writes.excluded.length > 0 ? (
                <ul>{planned.writes.excluded.map((x) => <li key={x.userId}>{x.name}: {x.reason}</li>)}</ul>
              ) : (
                <p>No change is planned.</p>
              )}
              <p>Go back and choose another target business unit or other users. The users' current business units are read again each time a plan is made.</p>
              <button type="button" onClick={() => go(2)}>Choose another target</button>
            </div>
          )}
          {planned !== null && unresolved > 0 && (
            <p role="alert" className="msg msg-warn">⚠ {unresolved} role decision{unresolved === 1 ? ' needs' : 's need'} an explicit choice before you can continue. Choose a role for each, or set that user to assign no roles.</p>
          )}
        </>
      )}
      {current === 4 && planned !== null && (retryPreview
        ? <PreviewPanel planned={planned} manager={manager} targetName={targetName || planned.plan.targetBusinessUnitName} canExecute={manager.canExecute} demo={demo} />
        : <ReviewStep planned={planned} targetName={targetName} />)}
      {current === 5 && phase.kind === 'running' && <RunningPanel phase={phase} />}
      {current === 5 && phase.kind === 'done' && <ResultPanel phase={phase} manager={manager} {...(download ? { download } : {})} {...(onOpenOperations ? { onOpenOperations } : {})} />}
      {current === 5 && phase.kind === 'unknown' && (
        <section className="bu-panel" aria-label="Move result">
          <p role="alert" className="msg msg-error">{phase.message}</p>
          <button type="button" onClick={startOver}>Close</button>
        </section>
      )}

      {phase.kind === 'preview' && phase.confirming && planned !== null && (
        <ConfirmDialog planned={planned} environmentLabel={environmentLabel} notice={manager.notice} onCancel={() => manager.cancelConfirm()} onConfirm={(ack) => void manager.confirm(ack)} />
      )}

      {!inRun && !retryPreview && (
        <footer className="wz-footer" aria-label="Wizard navigation">
          <button type="button" onClick={() => go((current - 1) as StepId)} disabled={current === 1}>Back</button>
          <span className="wz-summary-line" role="status">
            {manager.selected.length} user{manager.selected.length === 1 ? '' : 's'}{targetName ? ` → ${targetName}` : ''}
          </span>
          {current < 3 && (
            <button type="button" className="primary" onClick={() => go((current + 1) as StepId)} disabled={current === 1 ? !hasUsers : !targetValid}>
              Continue
            </button>
          )}
          {current === 3 && (
            <button type="button" className="primary" onClick={() => go(4)} disabled={!canReview}>
              {phase.kind === 'planning' ? 'Reading…' : 'Review changes'}
            </button>
          )}
          {current === 4 && (
            <button type="button" className="primary" onClick={() => manager.openConfirm()} disabled={!manager.canExecute || writeCount === 0}>
              Confirm and execute ({writeCount} change{writeCount === 1 ? '' : 's'})
            </button>
          )}
        </footer>
      )}
      {current === 4 && !retryPreview && demo && <p className="hint">Demo data: executing is not available. Nothing is read from or written to an environment.</p>}
      {current === 4 && !retryPreview && !demo && !manager.canExecute && <p className="hint">Executing is not available: this host does not provide the approved write path.</p>}
      {phase.kind === 'done' && (
        <p className="hint">Finished with these users? <button type="button" onClick={startOver}>Start a new move</button></p>
      )}
    </div>
  );
}
