import { describe, expect, it, vi } from 'vitest';
import { approvePlan, type ApprovedPlan, type OperationResult } from '../../domain/operations';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type PrivilegeId } from '../../domain/privileges';
import { stage, startEdit, toWritePlan, undo, type EditSession, type HeldDepth } from '../../domain/roleEditing';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { applyRoleEdit } from './apply';

const ROLE = '11111111-1111-1111-1111-111111111111';
const ENV = '00000000-0000-4000-8000-000000000002';
const catalog = Object.fromEntries(PRIVILEGE_IDS.map((p, i) => [p, `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`]));
const role = { roleId: ROLE, name: 'Test role', isManaged: false, isRootRole: true, privilegeDataIncomplete: false };

type Held = Partial<Record<PrivilegeId, HeldDepth>>;
function cellsOf(held: Held, unknown: PrivilegeId[] = []): PrivilegeCells {
  return Object.fromEntries(
    PRIVILEGE_IDS.map((p) => {
      const v = held[p];
      const cell: CellValue = unknown.includes(p) ? { kind: 'unknown' } : v ? { kind: 'depth', depth: v } : { kind: 'noGrant' };
      return [p, cell];
    }),
  ) as PrivilegeCells;
}

function must(session: EditSession, p: PrivilegeId, d: HeldDepth): EditSession {
  const r = stage(session, p, d);
  if (!r.ok) throw new Error(r.reason);
  return r.session;
}

/** A fake store that behaves like Dataverse: accepted writes change the held depths. */
function fake(initial: Held, behaviour: Partial<Record<PrivilegeId, 'fail' | 'uncertain' | 'ignore'>> = {}) {
  const held: Held = { ...initial };
  const log: string[] = [];
  const toPriv = (id: string) => PRIVILEGE_IDS.find((p) => catalog[p] === id) as PrivilegeId;
  const result = (p: PrivilegeId): OperationResult | null => {
    const b = behaviour[p];
    if (b === 'fail') return { outcome: 'failed', message: 'Dataverse refused.', failure: 'permission' };
    if (b === 'uncertain') return { outcome: 'uncertain', message: 'Unknown result.', failure: 'connection' };
    return null;
  };
  const writer: SecurityDataWriter = {
    addPrivilege: vi.fn(async (_a, _r, id, depth) => {
      const p = toPriv(id);
      log.push(`add ${p} ${depth}`);
      const r = result(p);
      if (r) return r;
      if (behaviour[p] !== 'ignore') held[p] = depth;
      return { outcome: 'notVerified', message: 'accepted', failure: 'none' } as OperationResult;
    }),
    removePrivilege: vi.fn(async (_a, _r, id) => {
      const p = toPriv(id);
      log.push(`remove ${p}`);
      const r = result(p);
      if (r) return r;
      if (behaviour[p] !== 'ignore') delete held[p];
      return { outcome: 'notVerified', message: 'accepted', failure: 'none' } as OperationResult;
    }),
    assignRole: vi.fn(),
    unassignRole: vi.fn(),
    moveUser: vi.fn(),
  };
  return { writer, held, log, reread: vi.fn(async () => cellsOf(held)) };
}

function confirm(session: EditSession): ApprovedPlan {
  const plan = toWritePlan(session);
  if (!plan) throw new Error('no plan');
  return approvePlan(plan, ENV, 'Owner', 0, { lifetimeMs: 60_000 });
}

const base = (held: Held) => startEdit(role, 'account', cellsOf(held), catalog);

describe('applyRoleEdit', () => {
  it('applies the confirmed changes and reports succeeded only after the re-read confirms them', async () => {
    const held: Held = { Read: 'Basic', Delete: 'Deep' };
    let s = base(held);
    s = must(s, 'Read', 'Local');
    s = must(s, 'Write', 'Basic');
    s = must(s, 'Delete', null);
    const f = fake(held);
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: f.reread });
    expect(r.overall).toBe('succeeded');
    expect(r.items.every((i) => i.outcome === 'succeeded')).toBe(true);
    expect(f.log).toEqual(['add Write Basic', 'add Read Local', 'remove Delete']);
  });

  it('sends nothing when the staged changes no longer match the confirmed plan', async () => {
    const held: Held = { Read: 'Basic' };
    let s = must(must(base(held), 'Read', 'Local'), 'Write', 'Basic');
    const approval = confirm(s);
    s = undo(s);
    const f = fake(held);
    const r = await applyRoleEdit({ session: s, approval, writer: f.writer, reread: f.reread });
    expect(r.overall).toBe('failed');
    expect(r.items[0]?.message).toMatch(/no longer match/);
    expect(f.log).toEqual([]);
  });

  it('stops at the first failed change and reports the rest as not attempted', async () => {
    const held: Held = { Read: 'Basic' };
    const s = must(must(base(held), 'Read', 'Local'), 'Write', 'Basic');
    const f = fake(held, { Write: 'fail' });
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: f.reread });
    expect(f.log).toEqual(['add Write Basic']);
    expect(r.items.map((i) => [i.change.privilege, i.outcome])).toEqual([['Write', 'failed'], ['Read', 'skipped']]);
    expect(r.overall).toBe('failed');
    expect(f.held.Read).toBe('Basic');
  });

  it('stops after an uncertain result and resolves it from the re-read', async () => {
    const held: Held = {};
    const s = must(must(base(held), 'Read', 'Basic'), 'Write', 'Basic');
    const f = fake(held, { Read: 'uncertain' });
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: f.reread });
    expect(f.log).toEqual(['add Read Basic']);
    expect(r.items[1]).toMatchObject({ outcome: 'skipped' });
    // The re-read shows Read was not applied, so the uncertain write is reported failed, not success.
    expect(r.items[0]).toMatchObject({ outcome: 'failed' });
  });

  it('does not start reductions until earlier additions are confirmed by a re-read', async () => {
    const held: Held = { Delete: 'Deep' };
    const s = must(must(base(held), 'Write', 'Basic'), 'Delete', null);
    const f = fake(held, { Write: 'ignore' });
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: f.reread });
    expect(f.log).toEqual(['add Write Basic']);
    expect(f.held.Delete).toBe('Deep');
    expect(r.items.map((i) => i.outcome)).toEqual(['failed', 'skipped']);
    expect(r.items[1]?.message).toMatch(/not confirmed by a re-read/);
  });

  it('reports a request that was accepted but not confirmed by the re-read as failed', async () => {
    const held: Held = { Read: 'Basic' };
    const s = must(base(held), 'Read', 'Local');
    const f = fake(held, { Read: 'ignore' });
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: f.reread });
    expect(r.items[0]).toMatchObject({ outcome: 'failed', foundDepth: 'Basic' });
  });

  it('reports notVerified, never success, when the re-read fails', async () => {
    const held: Held = {};
    const s = must(base(held), 'Read', 'Basic');
    const f = fake(held);
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: async () => null });
    expect(r.overall).toBe('notVerified');
    expect(r.verified).toBe(false);
    expect(r.items[0]?.outcome).toBe('notVerified');
  });

  it('reports notVerified when the re-read cannot interpret an edited cell', async () => {
    const held: Held = {};
    const s = must(base(held), 'Read', 'Basic');
    const f = fake(held);
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: async () => cellsOf(f.held, ['Read']) });
    expect(r.items[0]?.outcome).toBe('notVerified');
    expect(r.overall).toBe('notVerified');
  });

  it('applying again only does what is still missing', async () => {
    const held: Held = {};
    const s = must(must(base(held), 'Read', 'Basic'), 'Write', 'Basic');
    const f = fake(held, { Write: 'fail' });
    await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: f.reread });
    expect(f.held).toEqual({ Read: 'Basic' });
    // A new session from the re-read state only has the missing change to stage.
    const again = must(base(f.held), 'Write', 'Basic');
    const f2 = fake(f.held);
    const r = await applyRoleEdit({ session: again, approval: confirm(again), writer: f2.writer, reread: f2.reread });
    expect(f2.log).toEqual(['add Write Basic']);
    expect(r.overall).toBe('succeeded');
  });

  it('honours cancellation before the next change and reports what was applied', async () => {
    const held: Held = {};
    const s = must(must(base(held), 'Read', 'Basic'), 'Write', 'Basic');
    const f = fake(held);
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: f.reread, isCancelled: () => f.log.length >= 1 });
    expect(f.log).toHaveLength(1);
    expect(r.items.map((i) => i.outcome)).toEqual(['succeeded', 'skipped']);
    expect(r.overall).toBe('partiallyApplied');
  });

  it('rechecks cancellation after the checkpoint re-read and does not start reductions', async () => {
    const held: Held = { Delete: 'Deep' };
    const s = must(must(base(held), 'Write', 'Basic'), 'Delete', null);
    const f = fake(held);
    let cancelled = false;
    let rereads = 0;
    const reread = async () => {
      rereads++;
      if (rereads === 1) cancelled = true; // cancellation arrives while the checkpoint re-read is pending
      return cellsOf(f.held);
    };
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread, isCancelled: () => cancelled });
    expect(f.log).toEqual(['add Write Basic']);
    expect(f.held.Delete).toBe('Deep');
    expect(rereads).toBe(2); // the final re-read still reports what was applied
    expect(r.items.map((i) => i.outcome)).toEqual(['succeeded', 'skipped']);
    expect(r.overall).toBe('partiallyApplied');
  });

  it('keeps the final verification when the writer rejects, and stops further writes', async () => {
    const held: Held = {};
    const s = must(must(base(held), 'Read', 'Basic'), 'Write', 'Basic');
    const f = fake(held);
    const original = f.writer.addPrivilege;
    let n = 0;
    f.writer.addPrivilege = vi.fn(async (...args: Parameters<typeof original>) => {
      if (n++ === 1) throw new Error('boom');
      return original(...args);
    });
    const r = await applyRoleEdit({ session: s, approval: confirm(s), writer: f.writer, reread: f.reread });
    expect(f.reread).toHaveBeenCalled();
    expect(r.items.map((i) => [i.change.privilege, i.outcome])).toEqual([['Read', 'succeeded'], ['Write', 'failed']]);
    expect(f.writer.addPrivilege).toHaveBeenCalledTimes(2);
    expect(r.overall).toBe('partiallyApplied');
  });

  it('refuses a managed role without calling the writer', async () => {
    const held: Held = {};
    const managed = startEdit({ ...role, isManaged: true }, 'account', cellsOf(held), catalog);
    const f = fake(held);
    const r = await applyRoleEdit({ session: managed, approval: approvePlan(toWritePlan(must(base(held), 'Read', 'Basic'))!, ENV, 'Owner', 0), writer: f.writer, reread: f.reread });
    expect(f.log).toEqual([]);
    expect(r.overall).toBe('skipped');
  });
});
