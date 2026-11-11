import type { BuMoveResult } from './execute';

// Results export (issue #273): CSV and JSON of one BU move. Ids, step descriptions, outcomes and plain-language messages only: no tokens, no
// email addresses, no record contents. Cells that a spreadsheet would read as a formula are neutralised.

/** Email addresses can sit inside names and messages (a Dataverse full name is free text); every exported string is redacted. */
export function redactEmails(value: string): string {
  return value.replace(/[^\s@<>"',;()]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email removed]');
}

/** RFC 4180 quoting plus neutralisation of a leading = + - @ TAB or CR (CSV injection). */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const HEADER = ['operationId', 'user', 'userId', 'step', 'kind', 'outcome', 'requestSent', 'failureClass', 'message'];

export function resultToCsv(result: BuMoveResult): string {
  const lines = [HEADER.join(',')];
  for (const u of result.users) {
    for (const s of u.steps) {
      lines.push([result.operationId, u.userName, u.userId, s.description, s.kind, s.outcome, s.sent ? 'yes' : 'no', s.failure, s.message].map((c) => csvCell(redactEmails(c))).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function resultToJson(result: BuMoveResult): string {
  const r = redactEmails;
  return JSON.stringify(
    {
      operationId: result.operationId,
      planHash: result.planHash,
      environmentId: result.environmentId,
      targetBusinessUnit: { id: result.targetBusinessUnitId, name: r(result.targetBusinessUnitName) },
      startedAt: new Date(result.startedAtMs).toISOString(),
      endedAt: new Date(result.endedAtMs).toISOString(),
      overall: result.overall,
      stoppedReason: result.stoppedReason === null ? null : r(result.stoppedReason),
      users: result.users.map((u) => ({
        userId: u.userId,
        name: r(u.userName),
        overall: u.overall,
        businessUnitBefore: u.before?.businessUnitId ?? null,
        businessUnitAfter: u.after?.businessUnitId ?? null,
        rolesLost: u.rolesLost,
        steps: u.steps.map((s) => ({ key: s.key, description: r(s.description), kind: s.kind, outcome: s.outcome, requestSent: s.sent, failureClass: s.failure, message: r(s.message) })),
      })),
    },
    null,
    2,
  );
}

const OUTCOME_WORD: Readonly<Record<string, string>> = {
  succeeded: 'VERIFIED',
  failed: 'FAILED',
  skipped: 'NOT ATTEMPTED',
  partiallyApplied: 'PARTLY APPLIED',
  notVerified: 'ACCEPTED, NOT VERIFIED',
  uncertain: 'UNCERTAIN',
};

/** A plain-text summary of one run that pastes cleanly into a ticket or an email: no JSON, no tables, emails redacted, nothing invented. */
export function resultToText(result: BuMoveResult): string {
  const r = redactEmails;
  const word = (o: string): string => OUTCOME_WORD[o] ?? o.toUpperCase();
  const lines: string[] = [
    'BUSINESS UNIT MOVE - RESULT',
    `Finished: ${new Date(result.endedAtMs).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    `Environment: ${result.environmentId}`,
    `Target business unit: ${r(result.targetBusinessUnitName)}`,
    `Operation id: ${result.operationId}`,
    `Overall: ${word(result.overall)}${result.stoppedReason ? ` - ${r(result.stoppedReason)}` : ''}`,
    `Users: ${result.users.length}`,
    '',
  ];
  for (const u of result.users) {
    lines.push(`${r(u.userName)}: ${word(u.overall)}`);
    for (const s of u.steps) {
      lines.push(`  - [${word(s.outcome)}] ${r(s.description)} (request sent: ${s.sent ? 'yes' : 'no'})${s.message ? ` - ${r(s.message)}` : ''}`);
    }
    if (u.rolesLost.length > 0) lines.push(`  ! ${u.rolesLost.length} direct role(s) held before the move are no longer listed and were not removed by this plan.`);
    lines.push('');
  }
  lines.push('An accepted request is only reported as verified when a later read showed the wanted state.');
  return lines.join('\r\n');
}
