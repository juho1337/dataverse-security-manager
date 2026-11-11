import { describe, expect, it } from 'vitest';
import { groupRolesByLineage } from './lineage';
import type { CellValue, PrivilegeCells, PrivilegeId, RoleRow } from './privileges';
import { PRIVILEGE_IDS } from './privileges';

const cells = (over: Partial<Record<PrivilegeId, CellValue>> = {}): PrivilegeCells =>
  Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, over[p] ?? ({ kind: 'noGrant' } as CellValue)])) as PrivilegeCells;
const depth = (d: 'Basic' | 'Local' | 'Deep' | 'Global'): CellValue => ({ kind: 'depth', depth: d });
const row = (roleId: string, name: string, parent: string | null | undefined, c: PrivilegeCells = cells()): RoleRow =>
  ({ roleId, name, cells: c, ...(parent === undefined ? {} : { parentRootRoleId: parent }) });

describe('groupRolesByLineage', () => {
  it('shows one row per root with the copies counted, and the root cells', () => {
    const read = cells({ Read: depth('Global') });
    const out = groupRolesByLineage([row('r1', 'Role A', null, read), row('c1', 'Role A', 'r1', read), row('c2', 'Role A', 'r1', read)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ roleId: 'r1', lineage: { instanceCount: 3, instancesDiffer: false, copiesWithoutStoredGrants: 0, anyInstanceGrants: true } });
    expect(out[0]?.cells.Read).toEqual(depth('Global'));
  });

  it('flags a copy that stores privileges and disagrees with the root', () => {
    const out = groupRolesByLineage([row('r1', 'A', null, cells({ Read: depth('Global') })), row('c1', 'A', 'r1', cells({ Read: depth('Local') }))]);
    expect(out[0]?.lineage?.instancesDiffer).toBe(true);
  });

  it('does not call a copy with no stored privileges "different" (the real environment: system-role copies store none)', () => {
    const out = groupRolesByLineage([row('r1', 'A', null, cells({ Read: depth('Global') })), row('c1', 'A', 'r1'), row('c2', 'A', 'r1')]);
    expect(out[0]?.lineage).toMatchObject({ instancesDiffer: false, copiesWithoutStoredGrants: 2, instanceCount: 3 });
  });

  it('does not compare unknown cells', () => {
    const out = groupRolesByLineage([row('r1', 'A', null, cells({ Read: depth('Global') })), row('c1', 'A', 'r1', cells({ Read: { kind: 'unknown' }, Write: depth('Basic') }))]);
    // Write differs (root noGrant vs copy Basic) -> flagged; Read unknown is skipped
    expect(out[0]?.lineage?.instancesDiffer).toBe(true);
    const onlyUnknown = groupRolesByLineage([row('r1', 'A', null, cells({ Read: depth('Global') })), row('c1', 'A', 'r1', cells({ Read: { kind: 'unknown' } }))]);
    expect(onlyUnknown[0]?.lineage?.instancesDiffer).toBe(false);
  });

  it('a family is relevant when only a copy grants on the table', () => {
    const out = groupRolesByLineage([row('r1', 'A', null), row('c1', 'A', 'r1', cells({ Read: depth('Basic') }))]);
    expect(out[0]?.lineage?.anyInstanceGrants).toBe(true);
  });

  it('keeps a copy whose root is missing as its own row, marked, with the copy as parent so it is never a root', () => {
    const out = groupRolesByLineage([row('c1', 'Orphan', 'gone', cells({ Read: depth('Basic') }))]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ roleId: 'c1', parentRootRoleId: 'gone', lineage: { rootMissing: true, instanceCount: 1 } });
  });

  it('keeps same-named roles separate (identity is the id and the lineage, never the name)', () => {
    const out = groupRolesByLineage([row('r1', 'Same Name', null), row('r2', 'Same Name', null)]);
    expect(out.map((r) => r.roleId).sort()).toEqual(['r1', 'r2']);
  });

  it('groups nothing when the lineage of any record is unreadable (never guess)', () => {
    const input = [row('r1', 'A', null), row('c1', 'A', undefined)];
    expect(groupRolesByLineage(input)).toEqual(input);
  });

  it('matches ids case-insensitively', () => {
    const out = groupRolesByLineage([row('R1', 'A', null), row('c1', 'A', 'r1')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.lineage?.instanceCount).toBe(2);
  });
});
