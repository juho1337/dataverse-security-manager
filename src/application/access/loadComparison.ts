import type { AccessReader, ReadResult } from '../../ports/accessReader';
import { compareAccess, type AccessComparison } from './userAccessView';

/** Loads both users and compares them. Either read failing fails the comparison; either being partial makes it partial (never a silent "no difference"). */
export async function loadComparison(reader: AccessReader, leftId: string, rightId: string): Promise<ReadResult<AccessComparison>> {
  const [l, r] = await Promise.all([reader.loadUserAccess(leftId), reader.loadUserAccess(rightId)]);
  if (l.status === 'error') return l;
  if (r.status === 'error') return r;
  const data = compareAccess(l.data, r.data);
  const notes = [...(l.status === 'partial' ? l.notes.map((n) => `${l.data.user.fullName}: ${n}`) : []), ...(r.status === 'partial' ? r.notes.map((n) => `${r.data.user.fullName}: ${n}`) : [])];
  return notes.length > 0 ? { status: 'partial', data, notes } : { status: 'ok', data };
}
