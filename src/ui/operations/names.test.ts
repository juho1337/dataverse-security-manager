import { describe, expect, it } from 'vitest';
import { humanize, idsIn, nameOrShort, NO_NAMES } from './names';

const ROLE = 'bfeedd37-4a9f-4854-a459-67ce053ecc07';
const USER = '168c9cbb-50d8-f111-84e7-000d3ada5684';

describe('names for the ids of a restore preview', () => {
  it('finds every distinct GUID in a text, lower-cased', () => {
    expect(idsIn([`Remove role ${ROLE.toUpperCase()} from user ${USER} (${ROLE})`, 'no ids here'])).toEqual([ROLE, USER]);
  });

  it('replaces known ids by their “Name” and leaves unknown ids as they are', () => {
    const names = new Map([[ROLE, 'demo-play-auditor']]);
    expect(humanize(`Remove role ${ROLE} from user ${USER}`, names)).toBe(`Remove role “demo-play-auditor” from user ${USER}`);
    expect(humanize(`Remove role ${ROLE}`, NO_NAMES)).toBe(`Remove role ${ROLE}`);
  });

  it('shows a name when known and the shortened id when not (in tables)', () => {
    expect(nameOrShort(USER, new Map([[USER, 'Alex']]))).toBe('“Alex”');
    expect(nameOrShort(USER.toUpperCase(), new Map([[USER, 'Alex']]))).toBe('“Alex”');
    expect(nameOrShort(USER, NO_NAMES)).toBe('168c9cbb');
  });
});

describe('names that more than one id shares (Business Unit copies of a role, users with the same name)', () => {
  const COPY_A = '5952c6bc-8593-4175-b29b-fa9099f596a5';
  const COPY_B = '7a11d0aa-1111-4222-8333-444455556666';
  const names = new Map([[COPY_A, 'Salesperson'], [COPY_B, 'Salesperson'], [USER, 'Alex']]);

  it('keeps a short id next to a shared name so two different targets never read alike, and leaves unique names clean', () => {
    expect(nameOrShort(COPY_A, names)).toBe('“Salesperson” (5952c6bc)');
    expect(nameOrShort(COPY_B, names)).toBe('“Salesperson” (7a11d0aa)');
    expect(nameOrShort(USER, names)).toBe('“Alex”');
    const a = humanize(`Remove role ${COPY_A} from user ${USER}`, names);
    const b = humanize(`Remove role ${COPY_B} from user ${USER}`, names);
    expect(a).not.toBe(b);
    expect(a).toBe('Remove role “Salesperson” (5952c6bc) from user “Alex”');
  });
});
