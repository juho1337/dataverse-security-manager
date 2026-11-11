import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { UserMovePlan } from '../../domain/buMove/types';
import { rolesToRestore } from './ReviewStep';

const chosen = (id: string, name: string) => ({ role: { id, name }, level: 'lineage' as const });
const plan = (decisions: unknown[]): UserMovePlan => ({ decisions }) as unknown as UserMovePlan;

describe('review step', () => {
  it('lists and counts one assignment per target role when two source roles map to the same target', () => {
    const u = plan([
      { outcome: 'restore', chosen: chosen('AAAA-1', 'Sales Rep') },
      { outcome: 'restore', chosen: chosen('aaaa-1', 'Sales Rep') }, // the same target role (ids compare case-insensitively)
      { outcome: 'restore', chosen: chosen('bbbb-2', 'Support') },
      { outcome: 'skip', chosen: null },
    ]);
    expect(rolesToRestore(u).map((t) => t.split(' (')[0])).toEqual(['Sales Rep', 'Support']);
    expect(rolesToRestore(u)).toHaveLength(2);
  });
});

describe('wizard stepper on a narrow viewport', () => {
  it('hides the step labels visually, never with display:none (they are the buttons\' accessible names)', () => {
    const css = readFileSync('src/ui/bu/bu.css', 'utf8');
    const narrow = /@media \(max-width: 560px\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/\.wz-label/);
    expect(narrow).not.toMatch(/\.wz-label \{ display: none/);
  });
});
