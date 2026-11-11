import { Icon } from './Icon';

interface Props {
  /** What is read again, for the accessible name: "Refresh the access of Ann Admin". */
  readonly label: string;
  readonly onClick: () => void;
  /** True while the read runs: the arrow turns, the button is disabled and a screen reader hears "Refreshing…". */
  readonly busy?: boolean;
}

/** A round icon button that reads what is on screen again from Dataverse (next to the name of the person or team it refreshes). */
export function RefreshButton({ label, onClick, busy = false }: Props) {
  return (
    <>
      <button
        type="button"
        className={`refresh-round${busy ? ' is-busy' : ''}`}
        aria-label={label}
        title={busy ? 'Reading from Dataverse…' : 'Refresh: read again from Dataverse'}
        aria-busy={busy}
        disabled={busy}
        onClick={onClick}
      >
        <Icon name="refresh" />
      </button>
      <span className="sr-only" role="status" aria-live="polite">{busy ? 'Refreshing…' : ''}</span>
    </>
  );
}
