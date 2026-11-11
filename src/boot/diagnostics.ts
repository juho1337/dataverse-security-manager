// Startup diagnostics. A blank white tool window tells nobody anything: if the tool fails while it starts, the reason is written onto the page
// (message, a short stack and the build stamp, with a Copy button), because the tool's own console is not reachable from the host window.
// Only failures BEFORE the first render count as fatal; after that the app (or its error boundary) owns the screen.

declare const __DSM_BUILD__: string;

export const BUILD = typeof __DSM_BUILD__ === 'string' ? __DSM_BUILD__ : 'unknown build';

export const bootState = { mounted: false };

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}${error.stack ? `\n${error.stack.split('\n').slice(0, 8).join('\n')}` : ''}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Shows a fixed banner with the failure; text only (never HTML), safe to call more than once. */
export function showFatal(doc: Document, title: string, detail: string): void {
  const text = `${title}\n\nBuild: ${BUILD}\n\n${detail}`;
  let box = doc.getElementById('dsm-fatal');
  if (!box) {
    box = doc.createElement('div');
    box.id = 'dsm-fatal';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#fff;color:#7a1220;padding:24px;font:14px/1.45 Segoe UI,system-ui,sans-serif;z-index:99999';
    const h = doc.createElement('h2');
    h.textContent = 'Dataverse Security Manager could not start';
    h.style.margin = '0 0 12px';
    const pre = doc.createElement('pre');
    pre.id = 'dsm-fatal-text';
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;background:#fde7e9;padding:12px;border-radius:6px;max-width:960px';
    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy details';
    copy.style.cssText = 'margin-top:12px;padding:6px 14px;cursor:pointer';
    copy.addEventListener('click', () => {
      const t = doc.getElementById('dsm-fatal-text')?.textContent ?? '';
      void navigator.clipboard?.writeText(t).catch(() => undefined);
    });
    const hint = doc.createElement('p');
    hint.textContent = 'Nothing was read from or written to Dataverse. Send these details to the developer.';
    box.append(h, pre, hint, copy);
    doc.body.appendChild(box);
  }
  const pre = doc.getElementById('dsm-fatal-text');
  if (pre) pre.textContent = text;
}

/** Installs the handlers for the start-up window. Returns a function that removes them again (tests). */
export function installDiagnostics(win: Window = window): () => void {
  const onError = (e: ErrorEvent) => {
    if (bootState.mounted) return;
    showFatal(win.document, 'The tool failed while starting.', describeError(e.error ?? e.message));
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (bootState.mounted) return;
    showFatal(win.document, 'The tool failed while starting (unhandled rejection).', describeError(e.reason));
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}
