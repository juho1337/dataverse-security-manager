import { DEPTH_IDS } from '../domain/privileges';
import type { CellValue, DepthId, PrivilegeId } from '../domain/privileges';
import { DEPTH_LABEL, PRIVILEGE_LABEL, PRIVILEGE_LETTER } from './labels';
import type { DepthColumn } from './labels';

/**
 * Depth Matrix letter states. A privilege has ONE granted depth per role; the Depth Matrix is only another way to draw that
 * single value, so lower depth columns of a granted privilege are `covered` (implied), never a second grant.
 */
export type LetterState = 'granted' | 'covered' | 'inactive' | 'notApplicable' | 'unknown' | 'staged';

/** Staged (not yet saved) target depth per privilege. Styling hook for the later editing milestone; nothing writes. */
export type StagedDepths = Readonly<Partial<Record<PrivilegeId, DepthId>>>;

export interface LetterDisplay {
  readonly state: LetterState;
  readonly letter: string;
  /** Text shown in the control: the letter, or "?" for unknown. */
  readonly shown: string;
  /** Full accessible name; also the tooltip. */
  readonly name: string;
  /** The letter changes with the staged edit (not saved yet): drawn with a dashed outline. */
  readonly pending: boolean;
}

const rank = (d: DepthId): number => DEPTH_IDS.indexOf(d);

/** The depth a cell actually grants, or null when it grants nothing (None, no entry, n/a, unknown). */
export function grantedDepth(cell: CellValue): DepthColumn | null {
  return cell.kind === 'depth' && cell.depth !== 'None' ? cell.depth : null;
}

export function describeLetter(privilege: PrivilegeId, cell: CellValue, column: DepthColumn, staged?: DepthId): LetterDisplay {
  const letter = PRIVILEGE_LETTER[privilege];
  const p = PRIVILEGE_LABEL[privilege];
  const col = DEPTH_LABEL[column];
  const make = (state: LetterState, name: string, shown = letter, pending = false): LetterDisplay => ({ state, letter, shown, name: `${p}: ${name}`, pending });

  if (cell.kind === 'unknown') return make('unknown', 'unknown, could not be read', '?');
  if (cell.kind === 'notApplicable') return make('notApplicable', 'not applicable to this table');

  const granted = grantedDepth(cell);
  if (staged !== undefined) {
    // The whole row is drawn as it WILL be after the staged change: the target depth is the grant, the depths below it are covered by it, and every
    // letter that differs from what is saved now gets a dashed outline.
    const current = granted ? `currently granted at ${DEPTH_LABEL[granted]}` : 'currently not granted';
    const target: DepthColumn | null = staged === 'None' ? null : staged;
    const classify = (g: DepthColumn | null): 'granted' | 'covered' | 'inactive' => (g === column ? 'granted' : g && rank(column) < rank(g) ? 'covered' : 'inactive');
    const before = classify(granted);
    const after = classify(target);
    if (target === column && before !== 'granted') return make('staged', `staged change, will be granted at ${col} (${current})`, letter, true);
    if (target === null && granted === column) return make('inactive', `staged change, will be removed (${current})`, letter, true);
    if (after !== before) {
      return after === 'covered' && target
        ? make('covered', `will be covered by the ${DEPTH_LABEL[target]} grant (staged change, implied, not a separate grant)`, letter, true)
        : make(after, after === 'inactive' ? 'will no longer be granted (staged change)' : 'staged change', letter, true);
    }
  }
  if (granted === column) return make('granted', `granted at ${col}`);
  if (granted && rank(column) < rank(granted)) {
    return make('covered', `covered by the ${DEPTH_LABEL[granted]} grant (implied, not a separate grant)`);
  }
  return make('inactive', 'not granted');
}
