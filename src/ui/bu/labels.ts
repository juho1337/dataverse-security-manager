import type { Outcome } from '../../domain/operations';
import type { BlockReason, DecisionOutcome, MatchLevel, RestoreStrategy } from '../../domain/buMove/types';

// Display text for the BU Manager. Every state has text AND a symbol: colour is never the only signal.

export const OUTCOME_TEXT: Readonly<Record<Outcome, string>> = {
  succeeded: 'Verified',
  failed: 'Failed',
  skipped: 'Not attempted',
  partiallyApplied: 'Partly applied',
  notVerified: 'Accepted, not verified',
  uncertain: 'Uncertain',
};

export const OUTCOME_SYMBOL: Readonly<Record<Outcome, string>> = {
  succeeded: '✔',
  failed: '✖',
  skipped: '–',
  partiallyApplied: '◐',
  notVerified: '?',
  uncertain: '?',
};

export const OVERALL_TEXT: Readonly<Record<Outcome, string>> = {
  succeeded: 'Every step was applied and confirmed by reading the users again.',
  failed: 'No change was applied.',
  skipped: 'Nothing was attempted.',
  partiallyApplied: 'Some steps were applied and some were not. The table shows which.',
  notVerified: 'Dataverse accepted the changes, but they could not be confirmed by a read. Treat them as not verified.',
  uncertain: 'The outcome is uncertain. Reconcile (read the users again) before trying anything else.',
};

export const STRATEGY_TEXT: Readonly<Record<RestoreStrategy, { readonly label: string; readonly help: string }>> = {
  none: { label: 'Do not restore roles', help: 'Move the user only. Roles that do not survive the move are not granted again.' },
  keep: { label: 'Keep the same roles', help: 'Keep a role that survives the move; assign nothing else.' },
  new: { label: 'Match roles in the target business unit', help: 'Assign the matching role of the target business unit (by lineage, then name and privileges).' },
  root: { label: 'Use the roles of the root business unit', help: 'Assign the root business unit copy of each role.' },
  custom: { label: 'Choose each role', help: 'Pick the target role for every role to restore.' },
};

export const DECISION_TEXT: Readonly<Record<DecisionOutcome, string>> = {
  restore: 'Will be assigned',
  skipRetained: 'Expected to be kept',
  blocked: 'Blocked: needs your decision',
  notRestoring: 'Not restored',
};

export const BLOCK_TEXT: Readonly<Record<BlockReason, string>> = {
  none: '',
  missing: 'No matching role exists in the target business unit.',
  ambiguous: 'More than one role matches; choose one.',
  differentPrivilegesUnconfirmed: 'The matching role has different privileges; review the differences and confirm.',
  escalationOrReductionUnconfirmed: 'The matching role gives more or less access; review the differences and confirm.',
  suggestionOnly: 'Only a suggestion exists; choose the role and confirm.',
  keepUnavailable: 'The role cannot be kept in the target business unit.',
  needsChoice: 'Choose the target role.',
  rootUnavailable: 'No root business unit copy was found.',
  invalidChoice: 'The chosen role is not a valid target.',
  privilegeDataIncomplete: 'The privileges could not be read completely; confirm the match.',
};

export const LEVEL_TEXT: Readonly<Record<MatchLevel, string>> = {
  lineage: 'Same role (lineage)',
  sameNameSamePrivileges: 'Same name and privileges',
  differentPrivileges: 'Same name, different privileges',
  suggestionOnly: 'Suggestion only',
};
