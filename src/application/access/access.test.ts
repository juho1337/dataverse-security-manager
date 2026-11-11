import { describe, expect, it } from 'vitest';
import { FixtureAccessReader, SYNTHETIC_ACCESS_SNAPSHOT } from '../../adapters/fixture/accessFixture';
import { explainUserAccess, SCOPE_NOTICE } from '../../domain/buMove/userAccess';
import type { AccessReader, ReadResult, UserHit } from '../../ports/accessReader';
import { loadComparison } from './loadComparison';
import { AccessSearchController, type Timers } from './searchController';
import { compareAccess, groupTeamRoles, originText, statusLabel } from './userAccessView';

const access = (id: string) => explainUserAccess(SYNTHETIC_ACCESS_SNAPSHOT, id);

describe('origin text and status', () => {
  it('explains direct, default-team and owner-team origins like the C# implementation', () => {
    const ann = access('u-ann');
    expect(ann.directRoles.map(originText)).toEqual(['direct', 'direct']);
    expect(ann.teamRoles.map(originText)).toEqual([
      'via the default team of Contoso',
      'via owner team Project Delivery in Contoso',
    ]);
  });

  it('labels disabled and application users', () => {
    expect(statusLabel({ isDisabled: false, isApplicationUser: false })).toBe('enabled');
    expect(statusLabel({ isDisabled: true, isApplicationUser: false })).toBe('disabled');
    expect(statusLabel({ isDisabled: true, isApplicationUser: true })).toBe('application user, disabled');
  });

  it('reuses the scope notice of the C# implementation', () => {
    expect(SCOPE_NOTICE).toContain('record sharing');
    expect(SCOPE_NOTICE).toContain('field security are not evaluated');
  });

  it('groups team-derived roles by team', () => {
    const groups = groupTeamRoles(access('u-ben'));
    expect(groups.map((g) => g.heading)).toEqual(['Default team of North', 'Regional Leads (owner team, North)']);
    expect(groups[1]?.grants.map((g) => g.role.name)).toEqual(['Project Contributor', 'Sales Manager']);
  });
});

describe('compareAccess', () => {
  it('compares by role id: same-named roles of different business units differ, same role via other origin is shared', () => {
    const c = compareAccess(access('u-ann'), access('u-ben'));
    // Ann: Admin, Contributor(HQ) direct + via Delivery, Basic(default). Ben: Contributor(North) direct + via Leads, Sales, Basic(default).
    expect(c.onlyLeft.map((h) => `${h.roleName}@${h.businessUnitName}`)).toEqual(['Project Contributor@Contoso', 'System Administrator@Contoso']);
    expect(c.onlyRight.map((h) => `${h.roleName}@${h.businessUnitName}`)).toEqual(['Project Contributor@North', 'Sales Manager@North']);
    expect(c.both.map((b) => b.roleName)).toEqual(['Basic User']);
    expect(c.both[0]?.leftOrigins).toEqual(['via the default team of Contoso']);
    expect(c.both[0]?.rightOrigins).toEqual(['via the default team of North']);
    expect(c.incomplete).toBe(false);
  });

  it('keeps every origin of a role held twice', () => {
    const c = compareAccess(access('u-ann'), access('u-cara'));
    expect(c.onlyLeft.map((h) => h.roleName)).toEqual(['System Administrator']);
    const contrib = c.both.find((b) => b.roleName === 'Project Contributor');
    expect(contrib?.leftOrigins).toEqual(['direct', 'via owner team Project Delivery in Contoso']);
  });

  it('marks the comparison incomplete when a side has data gaps', () => {
    expect(compareAccess(access('u-ann'), access('u-pat')).incomplete).toBe(true);
  });
});

describe('loadComparison', () => {
  const reader = new FixtureAccessReader();

  it('is partial, with the user named, when one side is partial', async () => {
    const r = await loadComparison(reader, 'u-ann', 'u-pat');
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toContain('Pat Partial:');
  });

  it('is ok when both are complete and an error when either read fails', async () => {
    expect((await loadComparison(reader, 'u-ann', 'u-ben')).status).toBe('ok');
    expect(await loadComparison(reader, 'u-ann', 'nobody')).toMatchObject({ status: 'error', errorClass: 'notFound' });
    expect(await loadComparison(reader, 'nobody', 'u-ann')).toMatchObject({ status: 'error' });
  });
});

// ---- search controller
function manualTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  const timers: Timers = {
    set: (fn, ms) => { const id = next++; pending.push({ fn, ms, id }); return id; },
    clear: (h) => { const i = pending.findIndex((p) => p.id === h); if (i >= 0) pending.splice(i, 1); },
  };
  return { timers, pending, fire: () => pending.splice(0).forEach((p) => p.fn()) };
}

function deferredReader() {
  const calls: { query: string; resolve: (r: ReadResult<readonly UserHit[]>) => void }[] = [];
  const reader: AccessReader = {
    searchUsers: (query) => new Promise((resolve) => { calls.push({ query, resolve }); }),
    searchTeams: async () => ({ status: 'ok', data: [] }),
    loadUserAccess: async () => ({ status: 'error', errorClass: 'unknown', message: 'unused' }),
    loadTeamAccess: async () => ({ status: 'error', errorClass: 'unknown', message: 'unused' }),
  };
  return { reader, calls };
}
const hit = (name: string): UserHit => ({ user: { id: name, fullName: name, email: '', businessUnitId: 'b', isDisabled: false, isApplicationUser: false }, businessUnitName: 'B' });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('AccessSearchController', () => {
  it('debounces: only the last query within the window is searched', async () => {
    const { reader, calls } = deferredReader();
    const t = manualTimers();
    const c = new AccessSearchController(reader, 300, t.timers);
    c.setQuery('an');
    c.setQuery('ann');
    expect(t.pending).toHaveLength(1);
    expect(c.getState().phase).toBe('loading');
    t.fire();
    expect(calls.map((x) => x.query)).toEqual(['ann']);
  });

  it('too-short text searches nothing and says so', () => {
    const { reader, calls } = deferredReader();
    const t = manualTimers();
    const c = new AccessSearchController(reader, 300, t.timers);
    c.setQuery('a');
    expect(c.getState()).toMatchObject({ phase: 'idle', tooShort: true });
    c.setQuery('');
    expect(c.getState()).toMatchObject({ phase: 'idle', tooShort: false });
    expect(t.pending).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('ignores a stale response that arrives after a newer query', async () => {
    const { reader, calls } = deferredReader();
    const t = manualTimers();
    const c = new AccessSearchController(reader, 0, t.timers);
    c.setQuery('ann');
    t.fire();
    c.setQuery('ben');
    t.fire();
    expect(calls.map((x) => x.query)).toEqual(['ann', 'ben']);
    calls[1]?.resolve({ status: 'ok', data: [hit('Ben')] });
    await tick();
    calls[0]?.resolve({ status: 'ok', data: [hit('Ann')] });
    await tick();
    const users = c.getState().users;
    expect(users?.status === 'ok' && users.data.map((h) => h.user.fullName)).toEqual(['Ben']);
    expect(c.getState().phase).toBe('done');
  });

  it('turns a rejected read into an error value and can retry', async () => {
    let fail = true;
    const reader: AccessReader = {
      searchUsers: async () => { if (fail) throw new Error('boom'); return { status: 'ok', data: [] }; },
      searchTeams: async () => ({ status: 'ok', data: [] }),
      loadUserAccess: async () => ({ status: 'error', errorClass: 'unknown', message: 'x' }),
      loadTeamAccess: async () => ({ status: 'error', errorClass: 'unknown', message: 'x' }),
    };
    const t = manualTimers();
    const c = new AccessSearchController(reader, 0, t.timers);
    c.setQuery('ann');
    t.fire();
    await tick();
    expect(c.getState().users?.status).toBe('error');
    fail = false;
    c.retry();
    await tick();
    expect(c.getState().users?.status).toBe('ok');
  });

  it('does nothing after dispose', async () => {
    const { reader, calls } = deferredReader();
    const t = manualTimers();
    const c = new AccessSearchController(reader, 300, t.timers);
    c.setQuery('ann');
    c.dispose();
    t.fire();
    c.setQuery('ben');
    expect(calls).toHaveLength(0);
  });
});
