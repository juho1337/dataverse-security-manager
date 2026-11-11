import { useCallback, useEffect, useRef, useState } from 'react';
import { executeRestore, planRestore, type RestoreReaders, type RestoreResult } from '../../application/operations/restore';
import type { RestorePlan } from '../../domain/history/restore';
import type { OperationRecord } from '../../domain/history/types';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { NO_NAMES, planIds, type NameMap } from './names';
import { useOperationRecorder } from './RecorderContext';

/** What a restore needs from the app: the reads, the approved writer and the environment the person confirms for. Absent = restore is not offered. */
export interface RestoreWiring {
  readonly readers: RestoreReaders;
  readonly writer: SecurityDataWriter;
  readonly environmentId: string;
  /** Other verified identifiers of the same environment (environment id and organization id). */
  readonly environmentAliases?: readonly string[];
  readonly environmentLabel: string;
  readonly actor: string;
  /** The real host connection, read again while a preview is open and at confirmation; a different value discards the preview. */
  readonly readFingerprint?: () => Promise<string | null>;
}

export type RestorePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'planning' }
  | { readonly kind: 'preview'; readonly plan: RestorePlan; readonly operationIds: readonly string[]; readonly fingerprint: string | null }
  | { readonly kind: 'confirm'; readonly plan: RestorePlan; readonly operationIds: readonly string[]; readonly fingerprint: string | null }
  | { readonly kind: 'running'; readonly plan: RestorePlan; readonly progress: string }
  | { readonly kind: 'done'; readonly plan: RestorePlan; readonly result: RestoreResult }
  | { readonly kind: 'unknown'; readonly plan: RestorePlan; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export interface RestoreController {
  readonly phase: RestorePhase;
  /** A short sentence for a discarded preview or a refused start; null when nothing to say. */
  readonly notice: string | null;
  /** Names of the users and roles the preview mentions (read when the preview was built; empty until they arrive, or when they cannot be read). */
  readonly names: NameMap;
  preview(selected: readonly OperationRecord[], history: readonly OperationRecord[]): Promise<void>;
  openConfirm(): void;
  cancelConfirm(): void;
  confirm(): Promise<void>;
  close(): void;
}

const CHANGED = 'The active connection changed, so the restore preview was discarded. Select the operations and preview again.';

/** The restore flow: preview (reads only) -> confirmation of the exact writes -> execution -> result. One restore at a time. */
export function useRestore(wiring: RestoreWiring | null): RestoreController {
  const recorder = useOperationRecorder();
  const [phase, setPhaseState] = useState<RestorePhase>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const [names, setNames] = useState<NameMap>(NO_NAMES);
  const namesToken = useRef(0);
  const phaseRef = useRef<RestorePhase>(phase);
  const busy = useRef(false);
  const request = useRef(0);
  const setPhase = useCallback((p: RestorePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  useEffect(
    () => () => {
      request.current++; // nothing in flight may update an unmounted screen
    },
    [],
  );

  // While a preview is open the real connection is watched; a different fingerprint discards it (nothing may be confirmed for another connection).
  const readFingerprint = wiring?.readFingerprint;
  const watched = phase.kind === 'preview' || phase.kind === 'confirm' ? phase.fingerprint : null;
  useEffect(() => {
    if (watched === null || !readFingerprint) return undefined;
    let stopped = false;
    const check = () => {
      void readFingerprint().then((now) => {
        const p = phaseRef.current;
        if (stopped || (p.kind !== 'preview' && p.kind !== 'confirm') || now === p.fingerprint) return;
        request.current++;
        setNotice(CHANGED);
        setPhase({ kind: 'idle' });
      });
    };
    const timer = setInterval(check, 1500);
    window.addEventListener('focus', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [watched, readFingerprint, setPhase]);

  const preview = useCallback(
    async (selected: readonly OperationRecord[], history: readonly OperationRecord[]) => {
      if (!wiring || busy.current || selected.length === 0) return;
      busy.current = true;
      const mine = ++request.current;
      setNotice(null);
      setPhase({ kind: 'planning' });
      try {
        const fingerprint = wiring.readFingerprint ? await wiring.readFingerprint() : null;
        const plan = await planRestore(selected, { environmentId: wiring.environmentId, environmentAliases: wiring.environmentAliases ?? [], history, readers: wiring.readers });
        if (mine !== request.current) return;
        setPhase({ kind: 'preview', plan, operationIds: selected.map((r) => r.operationId), fingerprint });
        // Names are display only and best effort: the preview is complete without them (ids are shown until they arrive).
        const token = ++namesToken.current;
        setNames(NO_NAMES);
        const readNames = wiring.readers.names;
        const ids = readNames ? planIds(plan).slice(0, 50) : [];
        if (readNames && ids.length > 0) {
          void readNames({ users: ids, roles: ids }).then((r) => {
            if (!r || token !== namesToken.current) return;
            setNames(new Map([...r.users, ...r.roles]));
          });
        }
      } catch {
        if (mine === request.current) setPhase({ kind: 'error', message: 'The current state could not be read, so no restore preview could be built. Nothing was changed. Try again.' });
      } finally {
        busy.current = false;
      }
    },
    [wiring, setPhase],
  );

  const confirm = useCallback(async () => {
    const p = phaseRef.current;
    if (!wiring || p.kind !== 'confirm' || busy.current) return;
    busy.current = true;
    const mine = ++request.current;
    try {
      if (wiring.readFingerprint) {
        const now = await wiring.readFingerprint();
        if (mine !== request.current || phaseRef.current !== p) return;
        if (now === null || now !== p.fingerprint) {
          setNotice(CHANGED);
          setPhase({ kind: 'idle' });
          return;
        }
      }
      setPhase({ kind: 'running', plan: p.plan, progress: 'Starting' });
      const result = await executeRestore({
        plan: p.plan,
        writer: wiring.writer,
        readers: wiring.readers,
        actor: wiring.actor,
        environmentId: wiring.environmentId,
        environmentAliases: wiring.environmentAliases ?? [],
        ...(recorder ? { recorder } : {}),
        onProgress: (text) => {
          const cur = phaseRef.current;
          if (cur.kind === 'running') setPhase({ ...cur, progress: text });
        },
      });
      if (result) setPhase({ kind: 'done', plan: p.plan, result });
      else setPhase({ kind: 'error', message: 'There was nothing to write, so nothing was sent.' });
    } catch {
      setPhase({
        kind: 'unknown',
        plan: p.plan,
        message: 'The restore ended with an unexpected error. What was applied is not known: read the history and the affected objects again before trying anything else.',
      });
    } finally {
      busy.current = false;
    }
  }, [wiring, recorder, setPhase]);

  return {
    phase,
    notice,
    names,
    preview,
    openConfirm: () => {
      const p = phaseRef.current;
      if (p.kind === 'preview' && p.plan.plan) setPhase({ ...p, kind: 'confirm' });
    },
    cancelConfirm: () => {
      const p = phaseRef.current;
      if (p.kind === 'confirm') setPhase({ ...p, kind: 'preview' });
    },
    confirm,
    close: () => {
      if (busy.current) return;
      request.current++;
      setNotice(null);
      setPhase({ kind: 'idle' });
    },
  };
}
