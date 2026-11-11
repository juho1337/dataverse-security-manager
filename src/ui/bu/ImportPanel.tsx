import { useId, useState } from 'react';
import type { BuManagerReader } from '../../application/buManager/ports';
import { applyImportReview, buildImportReview, includedCount, reviewSummary, setAll, setInclude, type ImportReview, type ImportReviewRow } from '../../domain/import/review';
import { parseImportFile } from '../../domain/import/parser';
import type { UserSummary } from '../../domain/buMove/types';
import type { BuManager } from './useBuManager';

const CLASS_TEXT: Record<ImportReviewRow['class'], string> = {
  ready: 'Ready',
  alreadySelected: 'Already in the move',
  alreadyInTarget: 'Already in the target',
  notFound: 'Not found',
  ambiguous: 'Ambiguous',
  disabled: 'Disabled user',
  applicationUser: 'Application user',
  invalid: 'Invalid',
  duplicate: 'Duplicate',
};

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'review'; readonly review: ImportReview; readonly notes: readonly string[]; readonly warnings: readonly string[] }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Import of a list of email addresses (plain list or CSV/TSV with an email column) from pasted text or a file read through the webview File API.
 * Reading a file adds nothing: only rows left included, and that can still be moved, are added when the person presses Add.
 */
export function ImportPanel({ reader, manager }: { readonly reader: BuManagerReader; readonly manager: BuManager }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [result, setResult] = useState('');
  const textId = useId();
  const fileId = useId();

  const read = async (content: string) => {
    setResult('');
    const file = parseImportFile(content);
    if (file.validEmails.length === 0) {
      setState({ kind: 'error', message: file.warnings.length > 0 ? file.warnings.join(' ') : 'No valid email address was found.' });
      return;
    }
    setState({ kind: 'reading' });
    const found = await reader.findUsersByEmail(file.validEmails).catch(() => null);
    if (!found || found.status === 'error') {
      setState({ kind: 'error', message: found ? found.message : 'The users could not be looked up.' });
      return;
    }
    const users: UserSummary[] = found.data.map((h) => h.user);
    const selectedIds = new Set(manager.selected.map((u) => u.id));
    const review = buildImportReview(file, users, manager.targetId, { has: (id) => selectedIds.has(id), add: () => 'added' });
    setState({ kind: 'review', review, notes: found.status === 'partial' ? found.notes : [], warnings: file.warnings });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.text();
      setText(content);
      await read(content);
    } catch {
      setState({ kind: 'error', message: 'The file could not be read.' });
    }
  };

  const addIncluded = (review: ImportReview) => {
    const toAdd: UserSummary[] = [];
    const summary = applyImportReview(review, {
      has: () => false,
      add: (u) => {
        toAdd.push(u);
        return 'added';
      },
    });
    const r = manager.addUsers(toAdd);
    setResult(`${r.added} user${r.added === 1 ? '' : 's'} added to the move; ${r.alreadySelected} already in it; ${summary.notEligible} not eligible.`);
    setState({ kind: 'idle' });
    setText('');
  };

  return (
    <section className="bu-panel" aria-label="Import users">
      <h3>Import a list</h3>
      <p className="hint">One email address per line, or a CSV/TSV file with an email column. Nothing is moved by importing.</p>
      <label htmlFor={fileId}>Choose a file (.csv, .tsv, .txt)</label>
      <input id={fileId} type="file" accept=".csv,.tsv,.txt,text/plain,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
      <label htmlFor={textId}>Or paste the list</label>
      <textarea id={textId} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" onClick={() => void read(text)} disabled={state.kind === 'reading' || text.trim() === ''}>Read list</button>
      <p className="sr-only" role="status" aria-live="polite">{result}</p>
      {result && <p className="msg msg-ok">{result}</p>}

      {state.kind === 'reading' && <p role="status" className="hint">Looking up the users…</p>}
      {state.kind === 'error' && <p role="alert" className="msg msg-error">{state.message}</p>}
      {state.kind === 'review' && (
        <div className="bu-review">
          <p role="status">{reviewSummary(state.review)}</p>
          {state.warnings.map((w) => <p key={w} role="note" className="msg msg-warn">{w}</p>)}
          {state.notes.length > 0 && <p role="note" className="msg msg-warn">{state.notes.join(' ')}</p>}
          {manager.targetId === '' && <p className="hint">Choose the target business unit first to see which users are already in it.</p>}
          <div role="group" aria-label="Import selection">
            <button type="button" onClick={() => setState({ ...state, review: setAll(state.review, true) })}>Include all ready</button>
            <button type="button" onClick={() => setState({ ...state, review: setAll(state.review, false) })}>Include none</button>
          </div>
          <table className="preview-table">
            <caption className="sr-only">Lines of the imported list</caption>
            <thead>
              <tr><th scope="col">Add</th><th scope="col">Line</th><th scope="col">Address</th><th scope="col">Result</th><th scope="col">Detail</th></tr>
            </thead>
            <tbody>
              {state.review.rows.map((r) => (
                <tr key={r.lineNumber}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.include}
                      disabled={r.class !== 'ready'}
                      aria-label={`Add line ${r.lineNumber}`}
                      onChange={(e) => setState({ ...state, review: setInclude(state.review, r.lineNumber, e.target.checked).review })}
                    />
                  </td>
                  <td>{r.lineNumber}</td>
                  <td>{r.email ?? r.text}</td>
                  <td><strong>{CLASS_TEXT[r.class]}</strong></td>
                  <td>{r.reason}{r.user ? ` (${r.user.fullName})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="primary" onClick={() => addIncluded(state.review)} disabled={includedCount(state.review) === 0}>
            Add {includedCount(state.review)} user{includedCount(state.review) === 1 ? '' : 's'} to the move
          </button>
          <button type="button" onClick={() => setState({ kind: 'idle' })}>Cancel</button>
        </div>
      )}
    </section>
  );
}
