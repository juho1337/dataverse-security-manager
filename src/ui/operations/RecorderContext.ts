import { createContext, useContext } from 'react';
import type { OperationRecorder } from '../../application/operations/recorder';

/**
 * The operation history recorder of the running app. The hooks of the three write paths read it, so no screen has to pass it down. Without a
 * provider (tests, an embedded screen) it is null and the writes work as before, just without a history entry.
 */
export const OperationRecorderContext = createContext<OperationRecorder | null>(null);

export function useOperationRecorder(): OperationRecorder | undefined {
  return useContext(OperationRecorderContext) ?? undefined;
}
