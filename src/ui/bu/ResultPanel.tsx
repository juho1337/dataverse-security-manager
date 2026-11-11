import { useState } from 'react';
import { resultToCsv, resultToJson, resultToText } from '../../application/buManager/export';
import type { BuMoveResult } from '../../application/buManager/execute';
import type { Reconciliation } from '../../application/buManager/reconcile';
import { browserDownload, type Downloader } from './download';
import { OUTCOME_SYMBOL, OUTCOME_TEXT, OVERALL_TEXT } from './labels';
import type { BuManager, BuPhase } from './useBuManager';

type Running = Extract<BuPhase, { kind: 'running' }>;
type Done = Extract<BuPhase, { kind: 'done' }>;

function Steps({ result }: { readonly result: BuMoveResult }) {
  return (
    <>
      {result.users.map((u) => (
        <article key={u.userId} aria-label={`Result for ${u.userName}`} className="bu-user">
          <h4>{u.userName}: <span data-outcome={u.overall}>{OUTCOME_SYMBOL[u.overall]} {OUTCOME_TEXT[u.overall]}</span></h4>
          <table className="preview-table">
            <caption className="sr-only">Steps for {u.userName}</caption>
            <thead><tr><th scope="col">Step</th><th scope="col">Outcome</th><th scope="col">Request sent</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {u.steps.map((s) => (
                <tr key={s.key} data-outcome={s.outcome}>
                  <th scope="row">{s.description}</th>
                  <td><strong>{OUTCOME_SYMBOL[s.outcome]} {OUTCOME_TEXT[s.outcome]}</strong></td>
                  <td>{s.sent ? 'Yes' : 'No'}</td>
                  <td>{s.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {u.rolesLost.length > 0 && (
            <p role="note" className="msg msg-warn">⚠ {u.rolesLost.length} direct role{u.rolesLost.length === 1 ? '' : 's'} held before the move {u.rolesLost.length === 1 ? 'is' : 'are'} no longer listed and {u.rolesLost.length === 1 ? 'was' : 'were'} not removed by this plan. Review the user in the Access Explorer.</p>
          )}
        </article>
      ))}
    </>
  );
}

function RetryBox({ rec, manager }: { readonly rec: Reconciliation; readonly manager: BuManager }) {
  return (
    <div className="bu-retry">
      {rec.unread.length > 0 && <p role="alert" className="msg msg-warn">⚠ Could not read again: {rec.unread.join(', ')}. Nothing is concluded for them.</p>}
      {rec.retry.length === 0 ? (
        <p role="status" className="hint">Reconciled by reading the users again. No step is proven missing, so there is nothing to retry.</p>
      ) : (
        <>
          <p role="status">Reconciled by reading the users again. These steps are proven not applied:</p>
          <ul aria-label="Retry candidates">
            {rec.retry.map((c) => (
              <li key={c.userId}>
                <strong>{c.userName}</strong>: {c.steps.map((s) => s.description).join('; ')}. {c.note}
              </li>
            ))}
          </ul>
          <p className="hint">Retrying plans these users again from a fresh read and asks you to confirm again. Nothing is sent automatically.</p>
          <button type="button" onClick={() => void manager.planRetry()}>Plan a retry for {rec.retry.length} user{rec.retry.length === 1 ? '' : 's'}</button>
        </>
      )}
    </div>
  );
}

/** Progress while the confirmed plan runs. */
export function RunningPanel({ phase }: { readonly phase: Running }) {
  return (
    <section className="bu-panel" aria-label="Moving users">
      <p role="status" aria-live="polite">Working: {phase.progress}. Do not close this window.</p>
    </section>
  );
}

/** Per-user, per-step results, reconciliation, safe-retry candidates and the export. Nothing is called verified unless a read showed it. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function ResultPanel({ phase, manager, download = browserDownload, onOpenOperations }: { readonly phase: Done; readonly manager: BuManager; readonly download?: Downloader; readonly onOpenOperations?: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const shown = phase.reconciliation?.result ?? phase.result;
  const bad = shown.overall !== 'succeeded';
  const stamp = new Date(shown.endedAtMs).toISOString().replace(/[:.]/g, '-');
  return (
    <section className="bu-panel" aria-label="Move result">
      <h3>Result</h3>
      <p role={bad ? 'alert' : 'status'} className={`msg ${bad ? 'msg-warn' : 'msg-ok'}`}>
        <strong>{OUTCOME_SYMBOL[shown.overall]} {OUTCOME_TEXT[shown.overall]}.</strong> {OVERALL_TEXT[shown.overall]}
        {shown.stoppedReason && ` ${shown.stoppedReason}`}
      </p>
      <Steps result={shown} />
      {bad && !phase.reconciliation && (
        <p className="hint">Reading the users again settles unverified or uncertain steps and shows what is safe to retry. It changes nothing.</p>
      )}
      <div className="bu-actions">
        {shown.overall !== 'succeeded' && (
          <button type="button" onClick={() => void manager.reconcile()} disabled={phase.reconciling}>
            {phase.reconciling ? 'Reading users…' : 'Reconcile (read again)'}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void copyToClipboard(resultToText(shown)).then((ok) => setCopied(ok ? 'ok' : 'failed'));
          }}
        >
          Copy summary
        </button>
        <button type="button" onClick={() => download(`bu-move-${stamp}.txt`, 'text/plain', resultToText(shown))}>Export TXT</button>
        <button type="button" onClick={() => download(`bu-move-${stamp}.csv`, 'text/csv', resultToCsv(shown))}>Export CSV</button>
        <button type="button" onClick={() => download(`bu-move-${stamp}.json`, 'application/json', resultToJson(shown))}>Export JSON</button>
        {onOpenOperations && <button type="button" onClick={onOpenOperations}>Open Operations &amp; History</button>}
        <button type="button" className="primary" onClick={() => manager.finish()}>Done</button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{copied === 'ok' ? 'Summary copied.' : copied === 'failed' ? 'Could not copy.' : ''}</p>
      {copied === 'ok' && <p className="hint">Summary copied to the clipboard.</p>}
      {copied === 'failed' && (
        <label>
          Could not copy automatically. Select and copy this text:
          <textarea readOnly rows={8} value={resultToText(shown)} onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
      {phase.reconciliation && <RetryBox rec={phase.reconciliation} manager={manager} />}
    </section>
  );
}
