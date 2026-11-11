import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeEnvironment, type FakeEnvironmentOptions } from '../../adapters/fixture/buManagerFixture';
import type { ConnectionState } from '../../adapters/pptb/connection';
import { resultToText } from '../../application/buManager/export';
import { EnvironmentIndicator } from '../EnvironmentIndicator';
import { BuManagerModule } from './BuManagerModule';
import { flattenUnits, targetReason } from './TargetStep';

type User = ReturnType<typeof userEvent.setup>;

const DEV: ConnectionState = { kind: 'host', name: 'Dev', url: 'https://dev.example.test', environmentType: 'Dev' };

function setup(options: FakeEnvironmentOptions = {}, extra: { readonly openModule?: (id: string) => void; readonly download?: (n: string, m: string, c: string) => void } = {}) {
  const env = createFakeEnvironment(options);
  const reads = { planning: 0 };
  const counted = Object.create(env.reader, {
    loadPlanningData: {
      value: (...args: Parameters<typeof env.reader.loadPlanningData>) => {
        reads.planning++;
        return env.reader.loadPlanningData(...args);
      },
    },
  }) as typeof env.reader;
  const user = userEvent.setup();
  render(<BuManagerModule reader={counted} connection={DEV} dataSource="live" environmentId="env-1" writer={env.writer} {...(extra.openModule ? { openModule: extra.openModule } : {})} {...(extra.download ? { download: extra.download } : {})} />);
  return { env, user, reads };
}

async function addUser(user: User, query: string, name: string) {
  await user.type(screen.getByRole('searchbox', { name: 'Search users by name or email' }), query);
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.click(await screen.findByRole('checkbox', { name: `Select ${name}` }));
}
const next = (user: User) => user.click(screen.getByRole('button', { name: 'Continue' }));
const back = (user: User) => user.click(screen.getByRole('button', { name: 'Back' }));
const stepButton = (name: RegExp) => screen.getByRole('button', { name });
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

async function toMapping(user: User, target = 'Contoso') {
  await addUser(user, 'ben', 'Ben Brooks');
  await next(user);
  await user.click(await screen.findByRole('radio', { name: new RegExp(`^${target}`) }));
  await next(user);
  await screen.findByRole('region', { name: 'Role mapping' });
}

async function toReview(user: User) {
  await toMapping(user);
  await waitFor(() => expect(isDisabled(screen.getByRole('button', { name: 'Review changes' }))).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Review changes' }));
  await screen.findByRole('region', { name: 'Review' });
}

describe('BU wizard: stepper and navigation', () => {
  it('starts on step 1 with the later steps closed and says why', async () => {
    setup();
    const nav = screen.getByRole('navigation', { name: 'Business unit move steps' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(5);
    expect(stepButton(/^Select users/).getAttribute('aria-current')).toBe('step');
    for (const name of [/Target BU/, /Role mapping/, /Review/, /Execute/]) expect(isDisabled(stepButton(name))).toBe(true);
    expect(stepButton(/Target BU/).title).toMatch(/select at least one user first/);
    expect(isDisabled(screen.getByRole('button', { name: 'Continue' }))).toBe(true); // nothing selected yet
    expect(isDisabled(screen.getByRole('button', { name: 'Back' }))).toBe(true);
  });

  it('opens step 2 after a user is selected, and step 3 only after a target is chosen', async () => {
    const { user } = setup();
    await addUser(user, 'ben', 'Ben Brooks');
    expect(isDisabled(stepButton(/Target BU/))).toBe(false);
    expect(isDisabled(stepButton(/Role mapping/))).toBe(true);
    await next(user);
    expect(stepButton(/Target BU/).getAttribute('aria-current')).toBe('step');
    expect(isDisabled(screen.getByRole('button', { name: 'Continue' }))).toBe(true); // no destination yet
    await user.click(await screen.findByRole('radio', { name: /^Contoso/ }));
    expect(screen.getByText(/Destination:/).textContent).toContain('Contoso');
    expect(isDisabled(screen.getByRole('button', { name: 'Continue' }))).toBe(false);
  });

  it('keeps the selection when going back and forward, and writes nothing on any step change', async () => {
    const { env, user } = setup();
    await toMapping(user);
    await back(user);
    await back(user);
    expect(within(await screen.findByRole('table', { name: 'Users' })).getByText('Ben Brooks')).toBeTruthy();
    await next(user);
    expect((screen.getByRole('radio', { name: /^Contoso/ }) as HTMLInputElement).checked).toBe(true); // the target is remembered
    expect(env.writes).toEqual([]);
  });

  it('moves between reachable steps with the arrow keys', async () => {
    const { user } = setup();
    await addUser(user, 'ben', 'Ben Brooks');
    stepButton(/^Select users/).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(stepButton(/Target BU/));
    await user.keyboard('{ArrowRight}'); // step 3 is not reachable yet: the focus stays
    expect(document.activeElement).toBe(stepButton(/Target BU/));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(stepButton(/^Select users/));
  });
});

describe('BU wizard: target step', () => {
  it('shows the hierarchy, the current business units, and why a target is unavailable', async () => {
    const { user } = setup();
    await addUser(user, 'ben', 'Ben Brooks');
    await next(user);
    expect(await screen.findByText(/Now in: North \(1 user\)/)).toBeTruthy();
    // North is where Ben is now: it cannot be the target, and it says so
    const north = screen.getByRole('radio', { name: /^North/ }) as HTMLInputElement;
    expect(north.disabled).toBe(true);
    expect(screen.getByText(/not available: the user is already in this business unit/)).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Find a business unit' }), 'cont');
    expect(screen.getByRole('radio', { name: /^Contoso/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^North/ })).toBeNull();
  });

  it('flattens parents before children and keeps the path to a match visible', () => {
    const units = [
      { id: 'root', name: 'Root', parentId: null, isDisabled: false },
      { id: 'b', name: 'Beta', parentId: 'root', isDisabled: false },
      { id: 'a', name: 'Alpha', parentId: 'root', isDisabled: false },
      { id: 'a1', name: 'Alpha Child', parentId: 'a', isDisabled: true },
      { id: 'orphan', name: 'Orphan', parentId: 'missing', isDisabled: false },
    ];
    expect(flattenUnits(units, '').map((r) => `${r.depth}:${r.unit.name}`)).toEqual(['0:Orphan', '0:Root', '1:Alpha', '2:Alpha Child', '1:Beta']);
    expect(flattenUnits(units, 'child').map((r) => r.unit.name)).toEqual(['Root', 'Alpha', 'Alpha Child']);
    expect(targetReason(units[3]!, [])).toMatch(/disabled/);
    const user = { id: 'u', fullName: 'U', email: '', businessUnitId: 'A', isDisabled: false, isApplicationUser: false };
    expect(targetReason(units[2]!, [user])).toMatch(/already/);
    expect(targetReason(units[1]!, [user])).toBeNull();
  });
});

describe('BU wizard: role mapping and stale plans', () => {
  it('preselects the recommended choice and shows the mapping before any review', async () => {
    const { env, user } = setup();
    await toMapping(user);
    expect((screen.getByRole('radio', { name: /Assign the current direct roles again/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /Match roles in the target business unit/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByText('Recommended').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('article', { name: 'Plan for Ben Brooks' })).toBeTruthy();
    expect(env.writes).toEqual([]);
  });

  it('plans again from a fresh read after the choice changes (the old plan is discarded)', async () => {
    const { env, user, reads } = setup();
    await toMapping(user);
    const before = reads.planning;
    await user.click(screen.getByRole('radio', { name: /Do not assign any role/ }));
    await waitFor(() => expect(reads.planning).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByText(/Will be assigned/)).toBeNull());
    expect(env.writes).toEqual([]);
  });

  it('discards the plan when the person goes back and changes the target, and plans for the new one', async () => {
    const { user, reads } = setup();
    await toReview(user);
    const before = reads.planning;
    await back(user);
    await back(user);
    await next(user); // same target again: the old plan was discarded, so it is read and planned again
    await screen.findByRole('region', { name: 'Role mapping' });
    expect(reads.planning).toBeGreaterThan(before);
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull(); // the review of the old plan is gone, not shown stale
    await waitFor(() => expect(isDisabled(screen.getByRole('button', { name: 'Review changes' }))).toBe(false));
  });
});

describe('BU wizard: review, confirmation and results', () => {
  it('shows before and after, the counts and the risks in plain words, and sends nothing', async () => {
    const { env, user } = setup();
    await toReview(user);
    const summary = screen.getByLabelText('Summary of the planned operations');
    expect(within(summary).getByText('Users to move')).toBeTruthy();
    const review = screen.getByRole('article', { name: 'Review of Ben Brooks' });
    expect(review.textContent).toMatch(/North → Contoso/);
    expect(review.textContent).toMatch(/Roles held directly now/);
    expect(review.textContent).toMatch(/Roles that will be assigned after the move/);
    expect(env.writes).toEqual([]);
  });

  it('cannot be submitted twice: one confirmation runs the plan once', async () => {
    const { env, user } = setup();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: /Confirm and execute/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and move' });
    await user.dblClick(confirm);
    await screen.findByRole('region', { name: 'Move result' });
    expect(env.writes).toEqual(['moveUser:u-ben:bu-hq', 'assignRole:u-ben:r-contrib']);
  });

  it('shows the result on step 5, copies a plain-text summary and opens Operations & History', async () => {
    const openModule = vi.fn();
    const { user } = setup({}, { openModule });
    await toReview(user);
    await user.click(screen.getByRole('button', { name: /Confirm and execute/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and move' }));
    await screen.findByRole('region', { name: 'Move result' });
    expect(stepButton(/Execute/).getAttribute('aria-current')).toBe('step');
    await user.click(screen.getByRole('button', { name: 'Copy summary' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toContain('BUSINESS UNIT MOVE - RESULT'));
    const text = await navigator.clipboard.readText();
    expect(text).toContain('BUSINESS UNIT MOVE - RESULT');
    expect(text).toContain('[VERIFIED]');
    expect(text).not.toMatch(/@example\.test/);
    await user.click(screen.getByRole('button', { name: 'Open Operations & History' }));
    expect(openModule).toHaveBeenCalledWith('operations');
  });

  it('starts again at step 1 after the result is closed', async () => {
    const { user } = setup();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: /Confirm and execute/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and move' }));
    await screen.findByRole('region', { name: 'Move result' });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(stepButton(/^Select users/).getAttribute('aria-current')).toBe('step'));
  });
});

describe('BU wizard: stale users after a move', () => {
  it('starts the next move with an empty selection, so a target the user is now in is never offered from stale data', async () => {
    const { user } = setup();
    await toReview(user);
    await user.click(screen.getByRole('button', { name: /Confirm and execute/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and move' }));
    await screen.findByRole('region', { name: 'Move result' });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(stepButton(/^Select users/).getAttribute('aria-current')).toBe('step'));
    expect(screen.queryByRole('table', { name: 'Users' })).toBeNull();
    expect(screen.getByText(/No users selected yet/)).toBeTruthy();
  });

  it('says why nothing can be reviewed when the user is already in the target (data changed after the search) and offers a way back', async () => {
    const { env, user } = setup();
    await addUser(user, 'ben', 'Ben Brooks'); // read while Ben was in North
    env.setBusinessUnit('u-ben', 'bu-hq'); // ... and moved to Contoso behind the tool's back
    await next(user);
    await user.click(await screen.findByRole('radio', { name: /^Contoso/ })); // the stale list still allows it
    await next(user);
    const alert = await screen.findByText(/Nothing can be moved with these choices/);
    expect(alert.closest('[role="alert"]')?.textContent).toMatch(/Ben Brooks/);
    expect(isDisabled(screen.getByRole('button', { name: 'Review changes' }))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Choose another target' }));
    expect(stepButton(/Target BU/).getAttribute('aria-current')).toBe('step');
    expect(env.writes).toEqual([]);
  });
});

describe('BU wizard: one selection table', () => {
  const search = async (user: User, text: string) => {
    const box = screen.getByRole('searchbox', { name: 'Search users by name or email' });
    await user.clear(box);
    await user.type(box, text);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('table', { name: 'Users' });
  };

  it('selects and deselects with the checkbox and with a click on the row', async () => {
    const { user } = setup();
    await search(user, 'ben');
    const box = screen.getByRole('checkbox', { name: 'Select Ben Brooks' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await user.click(screen.getByText('ben.brooks@example.test')); // the row, not the checkbox
    expect(box.checked).toBe(true);
    expect(screen.getByText('Selected (1)')).toBeTruthy();
    await user.click(screen.getByText('ben.brooks@example.test'));
    expect(box.checked).toBe(false);
    await user.click(box);
    expect(box.checked).toBe(true);
  });

  it('Select all picks only the users who can be moved, and Clear selection empties the table below it', async () => {
    const { user } = setup();
    await search(user, 'ex');
    const all = screen.getByRole('checkbox', { name: 'Select all results' }) as HTMLInputElement;
    await user.click(all);
    const boxes = screen.getAllByRole('checkbox', { name: /^Select (?!all)/ }) as HTMLInputElement[];
    const movable = boxes.filter((b) => !b.disabled);
    expect(movable.length).toBeGreaterThan(0);
    expect(movable.every((b) => b.checked)).toBe(true);
    const blocked = boxes.filter((b) => b.disabled);
    expect(blocked.length).toBeGreaterThan(0); // the disabled user is shown but cannot be selected
    expect(blocked.every((b) => !b.checked)).toBe(true);
    expect(screen.getByText(`Selected (${movable.length})`)).toBeTruthy();
    await user.click(all); // a second click removes them again
    expect(movable.every((b) => !b.checked)).toBe(true);
    await user.click(all);
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByText('No users selected.')).toBeTruthy();
    expect((screen.getAllByRole('checkbox', { name: /^Select (?!all)/ }) as HTMLInputElement[]).every((b) => !b.checked)).toBe(true);
  });

  it('keeps users selected earlier in the same table when the search changes', async () => {
    const { user } = setup();
    await search(user, 'ben');
    await user.click(screen.getByRole('checkbox', { name: 'Select Ben Brooks' }));
    await search(user, 'pat');
    const table = screen.getByRole('table', { name: 'Users' });
    expect(within(table).getByText('Pat Partial')).toBeTruthy();
    const ben = within(table).getByText('Ben Brooks');
    expect(ben).toBeTruthy();
    expect(within(table).getByText(/selected earlier, not in this search/)).toBeTruthy();
    expect((within(table).getByRole('checkbox', { name: 'Select Ben Brooks' }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(table).getByRole('checkbox', { name: 'Select Ben Brooks' }));
    expect(screen.getByText('No users selected.')).toBeTruthy();
  });
});

describe('result text', () => {
  it('lists every user and step, says what was verified, and removes email addresses', () => {
    const text = resultToText({
      operationId: 'op-1',
      planHash: 'h',
      environmentId: 'env-1',
      targetBusinessUnitId: 'bu',
      targetBusinessUnitName: 'Contoso',
      users: [
        {
          userId: 'u',
          userName: 'Ben ben@example.test',
          overall: 'partiallyApplied',
          before: null,
          after: null,
          rolesLost: [],
          steps: [
            { key: 'a', kind: 'moveUser', description: 'Move Ben', outcome: 'succeeded', sent: true, failure: 'none', message: 'Confirmed by a re-read.' },
            { key: 'b', kind: 'assignRole', description: 'Assign role X', outcome: 'failed', sent: true, failure: 'throttling', message: 'Dataverse is throttling requests.' },
          ],
        },
      ],
      overall: 'partiallyApplied',
      stoppedReason: null,
      startedAtMs: 0,
      endedAtMs: 86_400_000,
    } as never);
    expect(text).toContain('Overall: PARTLY APPLIED');
    expect(text).toContain('[VERIFIED] Move Ben');
    expect(text).toContain('[FAILED] Assign role X');
    expect(text).toContain('[email removed]');
    expect(text).not.toContain('ben@example.test');
  });
});

describe('environment indicator: read mode, editing enabled, synthetic', () => {
  it('distinguishes the three states and never says read-only when a write path exists', () => {
    const { rerender } = render(<EnvironmentIndicator connection={DEV} dataSource="live" />);
    expect(screen.getByText(/Live Dataverse data · read mode/)).toBeTruthy();
    rerender(<EnvironmentIndicator connection={DEV} dataSource="live" canWrite />);
    expect(screen.getByText(/editing enabled/)).toBeTruthy();
    expect(screen.getByText(/editing enabled/).getAttribute('title')).toMatch(/nothing is changed until you preview and confirm/);
    expect(screen.queryByText(/read-only/)).toBeNull();
    rerender(<EnvironmentIndicator connection={DEV} dataSource="synthetic" canWrite />);
    expect(screen.getByText(/Synthetic data \(not read from this environment\)/)).toBeTruthy();
    expect(screen.queryByText(/Live Dataverse data/)).toBeNull();
  });
});
