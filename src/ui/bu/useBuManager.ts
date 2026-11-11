import { useCallback, useEffect, useRef, useState } from 'react';
import type { BuManagerReader } from '../../application/buManager/ports';
import { userStateReader } from '../../application/buManager/ports';
import type { BuMoveResult } from '../../application/buManager/execute';
import { reconcileResult, type Reconciliation } from '../../application/buManager/reconcile';
import { confirmAndRun, planMove, planRetryOf, type PlannedMove } from '../../application/buManager/service';
import { choiceFromDialog, type BuMoveRequest, type RestoreStrategy, type RoleChoice, type RoleSelection, type UserSummary } from '../../domain/buMove/types';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { useOperationRecorder } from '../operations/RecorderContext';

// State of the BU Manager (issues #271, #273). The domain and application layers hold the rules; this hook only sequences the screens:
// compose -> planning -> preview -> running -> done. Nothing is written by selecting users, importing, planning or opening the confirmation:
// the only write path is `confirm`, called after the person pressed Confirm in the dialog with the risks acknowledged.

export type BuPhase =
  | { readonly kind: 'compose' }
  | { readonly kind: 'planning' }
  | { readonly kind: 'preview'; readonly planned: PlannedMove; readonly connectionKey: string | null; readonly fingerprint: string | null; readonly confirming: boolean }
  | { readonly kind: 'running'; readonly planned: PlannedMove; readonly progress: string }
  | { readonly kind: 'done'; readonly planned: PlannedMove; readonly result: BuMoveResult; readonly reconciliation: Reconciliation | null; readonly reconciling: boolean }
  /** The run itself threw: what was applied is not known until each user is read again. */
  | { readonly kind: 'unknown'; readonly planned: PlannedMove; readonly message: string };

export type UserRoleMode = 'batch' | 'none' | 'allDirectRoles';

export interface BuManagerConfig {
  readonly reader: BuManagerReader;
  /** Null when nothing may be written (demo mode, or a host without the Dataverse API): the preview is then available, execution is not. */
  readonly writer: SecurityDataWriter | null;
  readonly actor: string;
  /** The environment the preview is confirmed for; the write boundary compares it with the approved environment. Null: no execution. */
  readonly environmentId: string | null;
  /** Identifies the active host connection. A preview made for another connection is discarded. Null in demo mode. */
  readonly connectionKey: string | null;
  /**
   * Reads the CURRENT host connection fingerprint (connection id, normalized URL, slot count); null when unreadable. When given, a preview is
   * bound to it: it is discarded if the fingerprint changes, and confirming re-reads it and refuses a stale preview. App.tsx's connection
   * state only updates when the host object changes, so it cannot be the only guard.
   */
  readonly readFingerprint?: () => Promise<string | null>;
}

export interface BuManager {
  readonly canExecute: boolean;
  readonly selected: readonly UserSummary[];
  readonly targetId: string;
  readonly strategy: RestoreStrategy;
  readonly batchMode: 'none' | 'allDirectRoles';
  readonly userMode: Readonly<Record<string, UserRoleMode>>;
  readonly choices: Readonly<Record<string, readonly RoleChoice[]>>;
  readonly phase: BuPhase;
  readonly notice: string | null;
  addUsers(users: readonly UserSummary[]): { readonly added: number; readonly alreadySelected: number };
  removeUser(userId: string): void;
  clearUsers(): void;
  setTarget(id: string): void;
  setStrategy(s: RestoreStrategy): void;
  setBatchMode(m: 'none' | 'allDirectRoles'): void;
  setUserMode(userId: string, m: UserRoleMode): void;
  /** Records the choice for one source role of one user. `comparisonShown` is true when the comparison with the source role was on screen. */
  choose(userId: string, sourceRoleId: string, chosenRoleId: string, ticked: boolean, comparisonShown: boolean): void;
  /** Removes the choice for one source role (back to "no role chosen") and re-plans. */
  clearChoice(userId: string, sourceRoleId: string): void;
  /** Plans from a fresh read. Resolves true when a preview is open afterwards (false: nothing to show, see `notice`). */
  preview(): Promise<boolean>;
  backToCompose(): void;
  /** Clears the notice (the wizard does this before it re-plans after a changed input). */
  clearNotice(): void;
  /** Leaves a retry preview and shows the result it came from again (nothing was sent). */
  cancelRetry(): void;
  openConfirm(): void;
  cancelConfirm(): void;
  confirm(acknowledged: boolean): Promise<void>;
  reconcile(): Promise<void>;
  /** Re-plans only the users a read proved incomplete; the person must confirm the new preview. */
  planRetry(): Promise<void>;
  finish(): void;
}

const batchSelection = (mode: 'none' | 'allDirectRoles'): RoleSelection => ({ mode });

export function useBuManager(config: BuManagerConfig): BuManager {
  const { reader, writer, actor, environmentId, connectionKey, readFingerprint } = config;
  const recorder = useOperationRecorder();
  const [selected, setSelected] = useState<readonly UserSummary[]>([]);
  const [targetId, setTargetId] = useState('');
  const [strategy, setStrategyState] = useState<RestoreStrategy>('none');
  const [batchMode, setBatchModeState] = useState<'none' | 'allDirectRoles'>('none');
  const [userMode, setUserMode] = useState<Readonly<Record<string, UserRoleMode>>>({});
  const [choices, setChoices] = useState<Readonly<Record<string, readonly RoleChoice[]>>>({});
  const [phase, setPhaseState] = useState<BuPhase>({ kind: 'compose' });
  const [notice, setNotice] = useState<string | null>(null);
  const phaseRef = useRef<BuPhase>(phase);
  const busy = useRef(false);
  /** The result a retry preview came from, so cancelling the retry can show it again. */
  const retryOrigin = useRef<Extract<BuPhase, { kind: 'done' }> | null>(null);
  const requestId = useRef(0);
  const setPhase = useCallback((p: BuPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const connectionRef = useRef(connectionKey);
  connectionRef.current = connectionKey;

  // A preview belongs to one connection. If the active connection changes while it is open, it is discarded: nothing from it may be confirmed.
  useEffect(() => {
    const p = phaseRef.current;
    if (p.kind === 'preview' && p.connectionKey !== connectionKey) {
      requestId.current++;
      setNotice('The active connection changed, so the preview was discarded. Review the users and the target, then preview again.');
      setPhase({ kind: 'compose' });
    }
  }, [connectionKey, setPhase]);

  // While a preview is open, watch the real connection; a different fingerprint discards the preview.
  const previewFingerprint = phase.kind === 'preview' ? phase.fingerprint : null;
  const previewOpen = phase.kind === 'preview' && readFingerprint !== undefined;
  useEffect(() => {
    if (!previewOpen || !readFingerprint) return undefined;
    let stopped = false;
    const check = () => {
      void readFingerprint().then((now) => {
        const p = phaseRef.current;
        if (stopped || p.kind !== 'preview' || now === p.fingerprint) return;
        requestId.current++;
        setNotice('The active connection changed, so the preview was discarded. Review the users and the target, then preview again.');
        setPhase({ kind: 'compose' });
      });
    };
    const timer = setInterval(check, 1500);
    window.addEventListener('focus', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [previewOpen, previewFingerprint, readFingerprint, setPhase]);

  const invalidate = useCallback(() => {
    // Any change of the inputs makes an open preview stale; a result stays.
    const p = phaseRef.current;
    if (p.kind === 'preview' || p.kind === 'planning') {
      requestId.current++;
      setPhase({ kind: 'compose' });
    }
  }, [setPhase]);

  const buildRequest = useCallback(
    (users: readonly UserSummary[], choiceMap: Readonly<Record<string, readonly RoleChoice[]>>): BuMoveRequest => ({
      targetBusinessUnitId: targetId,
      strategy,
      selection: batchSelection(batchMode),
      choices: [],
      users: users.map((u) => {
        const mode = userMode[u.id] ?? 'batch';
        return { userId: u.id, choices: choiceMap[u.id] ?? [], ...(mode !== 'batch' ? { selection: batchSelection(mode) } : {}) };
      }),
    }),
    [targetId, strategy, batchMode, userMode],
  );

  const runPreview = useCallback(
    async (users: readonly UserSummary[], choiceMap: Readonly<Record<string, readonly RoleChoice[]>>): Promise<boolean> => {
      if (users.length === 0) {
        setNotice('Select at least one user.');
        return false;
      }
      if (targetId === '') {
        setNotice('Choose the target business unit.');
        return false;
      }
      const id = ++requestId.current;
      setNotice(null);
      setPhase({ kind: 'planning' });
      const fingerprint = readFingerprint ? await readFingerprint() : null;
      if (readFingerprint && fingerprint === null) {
        setNotice('The active connection could not be read, so no preview was made.');
        setPhase({ kind: 'compose' });
        return false;
      }
      // Always a fresh read: a plan is never built from data of an earlier preview.
      const out = await planMove(reader, buildRequest(users, choiceMap)).catch(() => ({ ok: false as const, message: 'The preview could not be built.' }));
      if (id !== requestId.current) return false; // superseded (inputs changed, connection changed)
      if (!out.ok) {
        setNotice(out.message);
        setPhase({ kind: 'compose' });
        return false;
      }
      // The data was read for one connection: if it changed while reading, the preview is not shown.
      if (readFingerprint && (await readFingerprint()) !== fingerprint) {
        setNotice('The active connection changed while the preview was being built, so it was discarded. Preview again.');
        setPhase({ kind: 'compose' });
        return false;
      }
      if (id !== requestId.current) return false;
      setPhase({ kind: 'preview', planned: out.planned, connectionKey: connectionRef.current, fingerprint, confirming: false });
      return true;
    },
    [reader, targetId, buildRequest, setPhase, readFingerprint],
  );

  return {
    canExecute: writer !== null && environmentId !== null,
    selected,
    targetId,
    strategy,
    batchMode,
    userMode,
    choices,
    phase,
    notice,

    addUsers(users) {
      let added = 0;
      let already = 0;
      const next = [...selected];
      for (const u of users) {
        if (next.some((s) => s.id === u.id)) already++;
        else {
          next.push(u);
          added++;
        }
      }
      if (added > 0) {
        setSelected(next);
        invalidate();
      }
      return { added, alreadySelected: already };
    },
    removeUser(userId) {
      setSelected((s) => s.filter((u) => u.id !== userId));
      invalidate();
    },
    clearUsers() {
      setSelected([]);
      invalidate();
    },
    setTarget(id) {
      setTargetId(id);
      setChoices({}); // choices were made for the previous target's candidates
      invalidate();
    },
    setStrategy(s) {
      setStrategyState(s);
      setChoices({});
      invalidate();
    },
    setBatchMode(m) {
      setBatchModeState(m);
      invalidate();
    },
    setUserMode(userId, m) {
      setUserMode((x) => ({ ...x, [userId]: m }));
      invalidate();
    },

    choose(userId, sourceRoleId, chosenRoleId, ticked, comparisonShown) {
      const choice = choiceFromDialog(sourceRoleId, chosenRoleId, ticked, comparisonShown);
      const mine = [...(choices[userId] ?? []).filter((c) => c.sourceRoleId !== sourceRoleId), choice];
      const nextChoices = { ...choices, [userId]: mine };
      setChoices(nextChoices);
      // Re-plan with the choice: the preview shows whether it still needs confirmation.
      if (phaseRef.current.kind === 'preview') void runPreview(selected, nextChoices);
    },

    clearChoice(userId, sourceRoleId) {
      const nextChoices = { ...choices, [userId]: (choices[userId] ?? []).filter((c) => c.sourceRoleId !== sourceRoleId) };
      setChoices(nextChoices);
      if (phaseRef.current.kind === 'preview') void runPreview(selected, nextChoices);
    },

    preview: () => runPreview(selected, choices),

    clearNotice() {
      setNotice(null);
    },

    cancelRetry() {
      const origin = retryOrigin.current;
      const p = phaseRef.current;
      if (p.kind !== 'preview' || p.planned.only === undefined || !origin) return;
      requestId.current++;
      retryOrigin.current = null;
      setNotice(null);
      setPhase(origin);
    },

    backToCompose() {
      const p = phaseRef.current;
      if (p.kind === 'preview' || p.kind === 'planning') {
        requestId.current++;
        setPhase({ kind: 'compose' });
      }
    },
    openConfirm() {
      const p = phaseRef.current;
      if (p.kind === 'preview' && p.planned.writes.plan !== null && writer !== null && environmentId !== null) setPhase({ ...p, confirming: true });
    },
    cancelConfirm() {
      const p = phaseRef.current;
      if (p.kind === 'preview') setPhase({ ...p, confirming: false });
    },

    async confirm(acknowledged) {
      const p = phaseRef.current;
      if (p.kind !== 'preview' || !p.confirming || !writer || environmentId === null || busy.current) return;
      if (!acknowledged) {
        setNotice('Tick the box to confirm that you have read the warnings.');
        return;
      }
      // The connection must still be the one the preview was made for (the write boundary checks the environment again for every write).
      if (p.connectionKey !== connectionRef.current) {
        setNotice('The active connection changed, so nothing was sent. Preview again.');
        setPhase({ kind: 'compose' });
        return;
      }
      busy.current = true;
      if (readFingerprint) {
        // The real host connection, read now: a preview for another connection (even of the same environment) is never executed.
        const now = await readFingerprint();
        if (now === null || now !== p.fingerprint || phaseRef.current !== p) {
          busy.current = false;
          requestId.current++;
          setNotice('The active connection changed, so nothing was sent. Preview again.');
          setPhase({ kind: 'compose' });
          return;
        }
      }
      const planned = p.planned;
      setPhase({ kind: 'running', planned, progress: 'Starting' });
      try {
        const result = await confirmAndRun({
          planned,
          writer,
          reader,
          actor,
          environmentId,
          ...(recorder ? { recorder } : {}),
          onProgress: (text) => {
            const cur = phaseRef.current;
            if (cur.kind === 'running') setPhase({ ...cur, progress: text });
          },
        });
        setPhase(result ? { kind: 'done', planned, result, reconciliation: null, reconciling: false } : { kind: 'compose' });
      } catch {
        setPhase({
          kind: 'unknown',
          planned,
          message: 'The move ended with an unexpected error. What was applied is not known: read each user again (Access Explorer) before trying anything else.',
        });
      } finally {
        busy.current = false;
      }
    },

    async reconcile() {
      const p = phaseRef.current;
      if (p.kind !== 'done' || p.reconciling) return;
      setPhase({ ...p, reconciling: true });
      const rec = await reconcileResult(p.result, userStateReader(reader)).catch(() => null);
      const cur = phaseRef.current;
      if (cur.kind !== 'done') return;
      setPhase({ ...cur, reconciling: false, reconciliation: rec ?? cur.reconciliation });
      if (!rec) setNotice('The users could not be read again.');
    },

    async planRetry() {
      const p = phaseRef.current;
      if (p.kind !== 'done' || !p.reconciliation) return;
      const next = planRetryOf(p.planned, p.reconciliation.retry);
      if (!next) {
        setNotice('Nothing is left to retry.');
        return;
      }
      const fingerprint = readFingerprint ? await readFingerprint() : null;
      if (readFingerprint && fingerprint === null) {
        setNotice('The active connection could not be read, so no retry preview was made.');
        return;
      }
      setNotice(null);
      requestId.current++;
      retryOrigin.current = p;
      // The retry needs its own confirmation; the executor reads every user first, so nothing already applied is sent again.
      setPhase({ kind: 'preview', planned: { ...next, sourceOperationId: p.result.operationId }, connectionKey: connectionRef.current, fingerprint, confirming: false });
    },

    finish() {
      const p = phaseRef.current;
      if (p.kind !== 'done' && p.kind !== 'unknown') return;
      setNotice(null);
      // The selected users were read BEFORE this move: their business unit is stale now, so a new move starts with an empty selection.
      setSelected([]);
      setChoices({});
      setUserMode({});
      setPhase({ kind: 'compose' });
    },
  };
}
