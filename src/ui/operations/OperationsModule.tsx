import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { historyToJson, operationToJson, toCsv } from '../../domain/history/export';
import { analyzeOperation } from '../../domain/history/reconcile';
import { isOperationActive, onLedgerChange } from '../../application/operations/recorder';
import { deriveStatus, newestFirst, reconcileAbandoned } from '../../domain/history/record';
import { environmentShort, formatOperationsReport } from '../../domain/history/report';
import type { OperationRecord, OperationStatus } from '../../domain/history/types';
import type { OperationStore } from '../../ports/operationStore';
import { copyText, systemClipboard, type ClipboardLike } from './clipboard';
import { downloadWithAnchor, stamp, type Downloader } from './download';
import { ACTION_LABEL, STATUS_FILTERS, failureLabel, formatTime } from './labels';
import { RestorePanel } from './RestorePanel';
import { StatusBadge } from './StatusBadge';
import { useRestore, type RestoreWiring } from './useRestore';
import './operations.css';

interface Props {
  readonly store: OperationStore;
  readonly now?: () => number;
  readonly download?: Downloader;
  /** The clipboard the report is copied to; injectable for tests. Undefined = the browser clipboard when it exists, null = none. */
  readonly clipboard?: ClipboardLike | null;
  /** IANA zone for the local time in reports; the runtime zone when absent. */
  readonly timeZone?: string;
  /** What a restore needs (reads, the approved writer, the confirmed environment). Absent = restore is not offered, and the panel says why. */
  readonly restore?: RestoreWiring | null;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly records: readonly OperationRecord[]; readonly dropped: number };

type Scope = 'selected' | 'all';

interface Feedback {
  readonly message: string;
  /** Shown for manual copying when the clipboard could not be used. */
  readonly manualText?: string;
}

const NO_RECORDS: readonly OperationRecord[] = [];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface DetailProps {
  readonly op: OperationRecord;
  readonly download: Downloader;
  readonly now: () => number;
  readonly onCopy: (ops: readonly OperationRecord[]) => void;
  readonly onTxt: (ops: readonly OperationRecord[]) => void;
}

function OperationDetail({ op, download, now, onCopy, onTxt }: DetailProps) {
  const analysis = useMemo(() => analyzeOperation(op), [op]);
  const status = analysis.status;
  const exportOne = (kind: 'json' | 'csv') => {
    const t = now();
    download(
      kind === 'json'
        ? { filename: `dsm-operation-${op.operationId}-${stamp(t)}.json`, mime: 'application/json', content: operationToJson(op, t) }
        : { filename: `dsm-operation-${op.operationId}-${stamp(t)}.csv`, mime: 'text/csv', content: toCsv([op]) },
    );
  };
  return (
    <section className="ops-detail" aria-labelledby="ops-detail-h">
      <h3 id="ops-detail-h">Operation {op.operationId}</h3>
      <p>
        <StatusBadge status={status} whole />{' '}
        {status === 'succeeded' ? 'Every step was verified by a re-read.' : 'Not verified as a whole: do not treat this as done without a re-read.'}
      </p>
      <dl className="ops-facts">
        <dt>Correlation id</dt>
        <dd><code>{op.correlationId}</code></dd>
        <dt>Service request id</dt>
        <dd>{op.serverCorrelationId ? <code>{op.serverCorrelationId}</code> : 'Not recorded'}</dd>
        <dt>Environment</dt>
        <dd><code>{op.environmentId}</code></dd>
        <dt>Confirmed by</dt>
        <dd>{op.actor}</dd>
        <dt>Started</dt>
        <dd>{formatTime(op.startedAtMs)}</dd>
        <dt>Ended</dt>
        <dd>{op.endedAtMs === undefined ? 'Not ended' : formatTime(op.endedAtMs)}</dd>
      </dl>
      <p className="ops-actions">
        <button type="button" onClick={() => onCopy([op])}>Copy this operation as text</button>{' '}
        <button type="button" onClick={() => onTxt([op])}>Export this operation as .txt</button>{' '}
        <button type="button" onClick={() => exportOne('json')}>Export this operation as JSON</button>{' '}
        <button type="button" onClick={() => exportOne('csv')}>Export this operation as CSV</button>
      </p>

      <h4>Steps</h4>
      <table className="ops-table">
        <caption className="ops-sr">Steps of operation {op.operationId}, in the order they were sent</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Intended change</th>
            <th scope="col">Outcome</th>
            <th scope="col">Verified</th>
            <th scope="col">Failure class</th>
            <th scope="col">Detail</th>
            <th scope="col">Started</th>
            <th scope="col">Ended</th>
          </tr>
        </thead>
        <tbody>
          {op.steps.map((s) => (
            <tr key={s.key}>
              <th scope="row">{s.index + 1}</th>
              <td>{s.description}</td>
              <td><StatusBadge status={s.outcome} /></td>
              <td>{s.verified ? 'Verified' : 'Not verified'}</td>
              <td>{failureLabel(s.failure)}</td>
              <td>
                {s.message}
                {s.technical ? <> <code>{s.technical}</code></> : null}
                {s.serverCorrelationId ? <> (request <code>{s.serverCorrelationId}</code>)</> : null}
              </td>
              <td>{formatTime(s.startedAtMs)}</td>
              <td>{formatTime(s.endedAtMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Safe retry candidates</h4>
      {analysis.retryCandidates.length === 0 ? (
        <p>No step of this operation is a retry candidate.</p>
      ) : (
        <ul className="ops-list">
          {analysis.retryCandidates.map((c) => (
            <li key={c.stepKey}>
              <strong>Step {c.index + 1}: {c.description}</strong>
              <br />
              {c.requiresRereadFirst ? 'Read the object again first, then repeat only what is missing. ' : 'Repeating it is safe. '}
              {c.reason}
            </li>
          ))}
        </ul>
      )}
      <p className="ops-note">Retrying is not available yet: this list is for review. A retry will be a new operation that you confirm.</p>

      {analysis.notRetryable.length > 0 && (
        <>
          <h4>Not offered for retry</h4>
          <ul className="ops-list">
            {analysis.notRetryable.map((n) => (
              <li key={n.stepKey}>Step {n.index + 1}: {n.reason}</li>
            ))}
          </ul>
        </>
      )}

      <h4>Reconciliation</h4>
      <ul className="ops-list">
        {analysis.advice.map((a) => (
          <li key={a.stepKey}>Step {a.index + 1}: {ACTION_LABEL[a.action]}. {a.reason}</li>
        ))}
      </ul>
      <h4>Recovery</h4>
      <p>{analysis.rollbackStatement}</p>
      <p>{analysis.recovery.reason}</p>
    </section>
  );
}

export function OperationsModule({
  store,
  now = () => Date.now(),
  download = (f) => downloadWithAnchor(f),
  clipboard,
  timeZone,
  restore = null,
}: Props) {
  const restoreController = useRestore(restore);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // Inspection (the detail panel) and selection (for reports and exports) are independent.
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState<OperationStatus | 'all'>('all');
  const [scope, setScope] = useState<Scope>('selected');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const scopeName = useId();
  const headerBox = useRef<HTMLInputElement | null>(null);

  // Every read of the ledger (the first one, Refresh and a change notification) takes a number; only the LATEST answer is used, so a slow
  // older snapshot can never overwrite a newer one (which would leave the list and the exports stale).
  const latest = useRef(0);
  const read = useCallback(
    (quiet: boolean) => {
      const mine = ++latest.current;
      if (!quiet) setLoad({ kind: 'loading' });
      store.list().then(
        (r) => {
          if (mine === latest.current) setLoad({ kind: 'ready', records: newestFirst(reconcileAbandoned(r.records, isOperationActive)), dropped: r.dropped });
        },
        () => {
          if (mine === latest.current && !quiet) setLoad({ kind: 'error' });
        },
      );
    },
    [store],
  );
  const refresh = useCallback(() => read(false), [read]);

  useEffect(() => {
    read(false);
    return () => {
      latest.current++; // nothing that is still in flight may update an unmounted screen or a different store
    };
  }, [read]);

  // A write in this session changes the ledger: show it without a manual refresh (quietly, keeping the selection).
  useEffect(() => onLedgerChange(() => read(true)), [read]);

  const records = load.kind === 'ready' ? load.records : NO_RECORDS;
  const inspected = records.find((r) => r.operationId === inspectedId) ?? null;

  // The selection survives a refresh for the operations that still exist; ones that disappeared are dropped.
  useEffect(() => {
    if (load.kind !== 'ready') return;
    const existing = new Set(load.records.map((r) => r.operationId));
    setSelection((prev) => {
      const kept = [...prev].filter((id) => existing.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [load]);

  const visible = useMemo(() => (filter === 'all' ? records : records.filter((r) => deriveStatus(r) === filter)), [records, filter]);
  const selectedRecords = useMemo(() => records.filter((r) => selection.has(r.operationId)), [records, selection]);
  const visibleSelected = visible.filter((r) => selection.has(r.operationId)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;

  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = visibleSelected > 0 && !allVisibleSelected;
  }, [visibleSelected, allVisibleSelected]);

  const toggleOne = (id: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Select all visible, or (when they are all selected already) clear just the visible ones.
  const toggleVisible = () =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const r of visible) next.delete(r.operationId);
      else for (const r of visible) next.add(r.operationId);
      return next;
    });
  const selectAllVisible = () => setSelection((prev) => new Set([...prev, ...visible.map((r) => r.operationId)]));
  const clearSelection = () => setSelection(new Set());

  const scopeRecords = scope === 'selected' ? selectedRecords : records;
  const nothingToReport = scopeRecords.length === 0;
  const reportHint =
    records.length === 0
      ? 'Nothing to report yet: no operations are recorded.'
      : nothingToReport
        ? 'Select one or more operations, or choose Whole history.'
        : null;

  const reportText = (ops: readonly OperationRecord[]) => formatOperationsReport(ops, { now: now(), ...(timeZone ? { timeZone } : {}) });

  const copyAsText = async (ops: readonly OperationRecord[]) => {
    if (ops.length === 0) return;
    const text = reportText(ops);
    const ok = await copyText(text, clipboard === undefined ? systemClipboard() : (clipboard ?? undefined));
    setFeedback(
      ok
        ? { message: `Copied ${plural(ops.length, 'operation', 'operations')} to the clipboard as text.` }
        : { message: 'Could not copy: select the text below and copy it manually.', manualText: text },
    );
  };
  const exportTxt = (ops: readonly OperationRecord[]) => {
    if (ops.length === 0) return;
    const t = now();
    download({
      filename: `dsm-operations-${environmentShort(ops)}-${stamp(t)}.txt`,
      mime: 'text/plain',
      content: reportText(ops).replace(/\n/g, '\r\n'),
    });
    setFeedback({ message: `Saved ${plural(ops.length, 'operation', 'operations')} as a text file.` });
  };
  const exportStructured = (kind: 'json' | 'csv') => {
    if (nothingToReport) return;
    const t = now();
    const base = scope === 'all' ? 'dsm-operation-history' : 'dsm-operations-selected';
    download(
      kind === 'json'
        ? { filename: `${base}-${stamp(t)}.json`, mime: 'application/json', content: historyToJson(scopeRecords, t) }
        : { filename: `${base}-${stamp(t)}.csv`, mime: 'text/csv', content: toCsv(scopeRecords) },
    );
  };

  return (
    <section className="ops" aria-label="Operations">
      <h2>Operations</h2>
      <p className="ops-storage" role="note">
        <strong>{store.info.kind === 'session' ? 'Session only.' : 'Host storage.'}</strong> {store.info.notice}
      </p>
      <p className="ops-note">
        Operations are recorded when the tool writes to Dataverse. Success is shown only when a re-read confirmed the change. There is no automatic rollback.
      </p>

      <fieldset className="ops-report">
        <legend>Report</legend>
        <div className="ops-scope" role="radiogroup" aria-label="Report scope">
          <label>
            <input type="radio" name={scopeName} checked={scope === 'selected'} onChange={() => setScope('selected')} /> Selected operations ({selectedRecords.length})
          </label>{' '}
          <label>
            <input type="radio" name={scopeName} checked={scope === 'all'} onChange={() => setScope('all')} /> Whole history ({records.length})
          </label>
        </div>
        <p className="ops-actions">
          <button type="button" className="ops-primary" onClick={() => void copyAsText(scopeRecords)} disabled={nothingToReport}>Copy as text</button>{' '}
          <button type="button" className="ops-primary" onClick={() => exportTxt(scopeRecords)} disabled={nothingToReport}>Export as .txt</button>{' '}
          <button type="button" onClick={refresh}>Refresh</button>
        </p>
        <p className="ops-actions">
          <span id="ops-structured-h">Structured export:</span>{' '}
          <button type="button" aria-describedby="ops-structured-h" onClick={() => exportStructured('json')} disabled={nothingToReport}>Export as JSON</button>{' '}
          <button type="button" aria-describedby="ops-structured-h" onClick={() => exportStructured('csv')} disabled={nothingToReport}>Export as CSV</button>
        </p>
        {reportHint && <p className="ops-note">{reportHint}</p>}
        <p role="status" aria-live="polite" aria-label="Report result" className="ops-feedback">{feedback?.message ?? ''}</p>
        {feedback?.manualText !== undefined && (
          <label className="ops-manual">
            Report text (select all and copy)
            <textarea readOnly rows={12} value={feedback.manualText} onFocus={(e) => e.currentTarget.select()} />
          </label>
        )}
      </fieldset>

      <RestorePanel wiring={restore} controller={restoreController} selected={selectedRecords} history={records} />

      {load.kind === 'loading' && <p role="status">Loading the operation history...</p>}
      {load.kind === 'error' && <p role="alert">The operation history could not be read. Use Refresh to try again.</p>}
      {load.kind === 'ready' && load.dropped > 0 && (
        <p role="alert">{load.dropped} stored entries could not be read and are not shown.</p>
      )}
      {load.kind === 'ready' && records.length === 0 && <p>No operations recorded yet.</p>}

      {records.length > 0 && (
        <>
          <h3>History, newest first</h3>
          <div className="ops-toolbar">
            <label>
              Show{' '}
              <select value={filter} onChange={(e) => setFilter(e.target.value as OperationStatus | 'all')} aria-label="Filter by status">
                {STATUS_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </label>{' '}
            <button type="button" onClick={selectAllVisible} disabled={visible.length === 0 || allVisibleSelected}>Select all visible</button>{' '}
            <button type="button" onClick={clearSelection} disabled={selection.size === 0}>Clear selection</button>
          </div>
          <p role="status" aria-live="polite" aria-label="Selection" className="ops-selection">
            {selectedRecords.length} of {plural(records.length, 'operation', 'operations')} selected
            {filter !== 'all' ? ` (${visible.length} shown by the filter)` : ''}
          </p>
          {visible.length === 0 && <p>No operations match this filter.</p>}
          {visible.length > 0 && (
            <table className="ops-table">
              <caption className="ops-sr">Recorded operations, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <input
                      ref={headerBox}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleVisible}
                      aria-label="Select all visible operations"
                    />
                  </th>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col">Steps</th>
                  <th scope="col">Confirmed by</th>
                  <th scope="col">Environment</th>
                  <th scope="col">Operation</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.operationId} aria-selected={r.operationId === inspectedId} data-selected={selection.has(r.operationId)}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selection.has(r.operationId)}
                        onChange={() => toggleOne(r.operationId)}
                        aria-label={`Select operation ${r.operationId}`}
                      />
                    </td>
                    <td>{formatTime(r.startedAtMs)}</td>
                    <td><StatusBadge status={deriveStatus(r)} whole /></td>
                    <td>{r.steps.length}</td>
                    <td>{r.actor}</td>
                    <td><code>{r.environmentId}</code></td>
                    <td>
                      <button type="button" aria-pressed={r.operationId === inspectedId} onClick={() => setInspectedId(r.operationId)}>
                        Show {r.operationId}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {inspected && <OperationDetail op={inspected} download={download} now={now} onCopy={(ops) => void copyAsText(ops)} onTxt={exportTxt} />}
    </section>
  );
}
