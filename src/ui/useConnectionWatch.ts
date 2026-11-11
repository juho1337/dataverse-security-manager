import { useCallback, useEffect, useRef, useState } from 'react';
import { getConnectionState, type ConnectionState, type HostWindow } from '../adapters/pptb/connection';
import { connectionFingerprint } from '../adapters/pptb/identity';
import { hasActiveOperations } from '../application/operations/recorder';

export const CONNECTION_POLL_MS = 1500;

export interface ConnectionWatch {
  /** The active connection as last read; null until the first read finishes. */
  readonly connection: ConnectionState | null;
  /** Increases every time the active connection changed and the screens were reloaded; use it as (part of) a React key. */
  readonly epoch: number;
  /** A short explanation of the last change (or of a change waiting for a running write); null when there is none. */
  readonly notice: string | null;
  readonly dismissNotice: () => void;
}

export interface ConnectionWatchOptions {
  readonly intervalMs?: number;
  /** True while a write is running; the reload then waits so the running write's result is not lost. Defaults to the ledger's own view. */
  readonly isBusy?: () => boolean;
}

/** Marks a baseline that could not be read consistently: it never equals a real fingerprint, so the next check reads again and corrects the header. */
const UNSTABLE = '\u0000unstable';

/**
 * Reads the connection state and its fingerprint as ONE consistent snapshot: fingerprint, state, fingerprint again; when the two fingerprints
 * differ the connection changed in between and the read is repeated. If it keeps changing, the baseline is marked unstable so that the next
 * check reads again instead of trusting a header that may belong to another connection.
 */
async function readConsistent(host: HostWindow | undefined): Promise<{ readonly state: ConnectionState; readonly fingerprint: string | null }> {
  const connections = host?.toolboxAPI?.connections;
  let state: ConnectionState = { kind: 'demo' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await connectionFingerprint(connections);
    state = await getConnectionState(host);
    const after = await connectionFingerprint(connections);
    if (before === after) return { state, fingerprint: after };
  }
  return { state, fingerprint: UNSTABLE };
}

function changeNotice(state: ConnectionState): string {
  const discarded = 'Unconfirmed edits, previews and loaded data were discarded.';
  switch (state.kind) {
    case 'host':
      return `The active connection changed to ${state.name}; data was reloaded. ${discarded}`;
    case 'none':
      return `No connection is selected any more; data was cleared. ${discarded}`;
    case 'error':
      return `The active connection could not be read; data was cleared. ${discarded}`;
    case 'demo':
      return `The Power Platform ToolBox host is no longer available; data was cleared. ${discarded}`;
  }
}

/**
 * Watches the host's active connection for the whole app. When it changes (another connection selected, or the set of connections changed),
 * the header is updated, every screen is remounted through `epoch` (loaded data, staged edits and previews are dropped, with a notice) and
 * the next reads go through the unchanged identity guards, so a connection that is not the approved environment shows the existing refusal.
 * A write that is still running keeps its screen: the reload waits until it has finished. Polls every 1.5 s while the page is visible and
 * checks at once when the window gets focus or becomes visible again. Without a host connections API there is nothing to watch.
 */
export function useConnectionWatch(host: HostWindow | undefined, options: ConnectionWatchOptions = {}): ConnectionWatch {
  const { intervalMs = CONNECTION_POLL_MS, isBusy = hasActiveOperations } = options;
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const lastFingerprint = useRef<string | null | undefined>(undefined);
  const busy = useRef(isBusy);
  busy.current = isBusy;

  const dismissNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    const connections = host?.toolboxAPI?.connections;
    let live = true;
    let checking = false;
    lastFingerprint.current = undefined;

    // First read: no notice and no reload, this is not a change. Header and baseline come from one consistent snapshot.
    void (async () => {
      const { state, fingerprint } = await readConsistent(host);
      if (!live) return;
      lastFingerprint.current = fingerprint;
      setConnection(state);
    })();

    if (typeof connections?.getActiveConnection !== 'function') {
      return () => {
        live = false;
      };
    }

    const check = async (force: boolean) => {
      if (checking || lastFingerprint.current === undefined) return;
      if (!force && typeof document !== 'undefined' && document.hidden) return;
      checking = true;
      try {
        const deferWhileWriting = () => {
          // A write is running: keep its screen and result; the reload happens on the first check after it has finished.
          setNotice('The active connection changed while a change was running. Its result stays visible; data reloads when it has finished.');
        };
        const now = await connectionFingerprint(connections);
        if (!live || now === lastFingerprint.current) return;
        if (busy.current()) return deferWhileWriting();
        const { state, fingerprint } = await readConsistent(host);
        if (!live) return;
        // A write may have been confirmed while the state was being read: it must not lose its screen. Checked again right before the reload.
        if (busy.current()) return deferWhileWriting();
        if (fingerprint === lastFingerprint.current) return; // it changed back meanwhile: nothing to reload
        lastFingerprint.current = fingerprint;
        setConnection(state);
        setEpoch((e) => e + 1);
        setNotice(changeNotice(state));
      } finally {
        checking = false;
      }
    };

    const timer = setInterval(() => void check(false), intervalMs);
    const onFocus = () => void check(true);
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) void check(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [host, intervalMs]);

  return { connection, epoch, notice, dismissNotice };
}
