import { PRIVILEGE_IDS } from '../domain/privileges';
import type { PrivilegeCells, PrivilegeId } from '../domain/privileges';
import { describeLetter } from './depthMatrix';
import type { LetterState, StagedDepths } from './depthMatrix';
import { DEPTH_COLUMNS, DEPTH_LABEL, PRIVILEGE_LABEL, PRIVILEGE_LETTER } from './labels';
import type { DepthColumn } from './labels';

const MARK: Readonly<Record<LetterState, string>> = {
  granted: '',
  covered: '',
  inactive: '',
  notApplicable: '',
  unknown: '',
  staged: '',
};

interface Props {
  readonly cells: PrivilegeCells;
  readonly differing?: readonly PrivilegeId[];
  readonly staged?: StagedDepths;
  /** Read-only: pressing a letter only announces its state. */
  readonly onAnnounce: (text: string) => void;
  /**
   * Edit mode: pressing a letter chooses that depth for the privilege (pressing the depth that is already chosen removes the privilege).
   * The letters then take part in the tab order and expose their chosen state. Unknown and not-applicable letters stay inert.
   */
  readonly onEdit?: (privilege: PrivilegeId, column: DepthColumn) => void;
  /** Edit mode: the depth each privilege would have after the staged changes (null = not held). */
  readonly effective?: Readonly<Partial<Record<PrivilegeId, DepthColumn | null>>>;
  /** Editable letters take part in the tab order (default). Off for always-on editing of a whole list, where the grid's own keys move between rows. */
  readonly tabbable?: boolean;
}

/** The four depth cells of one role row; each holds the eight privilege letters (one view of the same canonical cells). */
export function DepthCells({ cells, differing, staged, onAnnounce, onEdit, effective, tabbable = true }: Props) {
  return (
    <>
      {DEPTH_COLUMNS.map((column) => (
        <td key={column} role="gridcell" className="cell depth-cell">
          <span role="group" aria-label={`${DEPTH_LABEL[column]} privileges`} className="letters">
            {PRIVILEGE_IDS.map((p) => {
              const l = describeLetter(p, cells[p], column, staged?.[p]);
              const differs = differing?.includes(p) ?? false;
              const name = differs ? `${l.name}; differs from another Business Unit copy` : l.name;
              const editable = onEdit !== undefined && l.state !== 'unknown' && l.state !== 'notApplicable';
              const chosen = effective ? effective[p] === column : undefined;
              return (
                <button
                  key={p}
                  type="button"
                  tabIndex={editable && tabbable ? 0 : -1}
                  className={`letter letter-${l.state}${differs ? ' letter-differs' : ''}${editable ? ' letter-edit' : ''}${l.pending ? ' letter-pending' : ''}`}
                  data-state={l.state}
                  data-priv={p}
                  aria-label={name}
                  title={name}
                  {...(editable && chosen !== undefined ? { 'aria-pressed': chosen } : {})}
                  onClick={() => (editable ? onEdit(p, column) : onAnnounce(name))}
                >
                  <span aria-hidden="true">{l.shown}</span>
                  {MARK[l.state] && <span aria-hidden="true" className="letter-mark">{MARK[l.state]}</span>}
                  {differs && <span aria-hidden="true" className="letter-mark">≠</span>}
                </button>
              );
            })}
          </span>
        </td>
      ))}
    </>
  );
}

export function DepthLegend() {
  return (
    <details className="legend">
      <summary>Legend (Depth Matrix)</summary>
      <ul>
        <li><span className="letter letter-granted" data-priv="Read" aria-hidden="true">R</span> Granted: the role grants this privilege at exactly this depth (one grant per privilege)</li>
        <li><span className="letter letter-covered" data-priv="Read" aria-hidden="true">R</span> Covered (implied): a higher depth is granted, so this depth is included; it is not a separate grant</li>
        <li><span className="letter letter-inactive" data-priv="Read" aria-hidden="true">R</span> Not granted at this depth</li>
        <li><span className="letter letter-notApplicable" aria-hidden="true">C</span> Not applicable: the table has no such privilege</li>
        <li><span className="letter letter-unknown" aria-hidden="true">?</span> Unknown: could not be read; never treated as not granted</li>
        <li><span className="letter letter-staged letter-pending" data-priv="Read" aria-hidden="true">R</span> Staged change (not saved): the depth the privilege will have, with a dashed outline</li>
        <li>
          Letters:{' '}
          {PRIVILEGE_IDS.map((p) => (
            <span key={p} className="legend-letter"><span className="letter letter-granted" data-priv={p} aria-hidden="true">{PRIVILEGE_LETTER[p]}</span> {PRIVILEGE_LABEL[p]}</span>
          ))}
        </li>
      </ul>
    </details>
  );
}
