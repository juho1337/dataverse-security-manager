import type { DataSource } from '../app/dataSource';
import type { ConnectionState } from '../adapters/pptb/connection';

/**
 * Persistent environment identity and data source. Synthetic demo data is always labelled as such and is never shown as if it came from
 * the connected environment; live data says it is live. The two are never both claimed.
 */
interface Props {
  readonly connection: ConnectionState | null;
  readonly dataSource?: DataSource;
  /** True when changes can be made here: only after a preview and an explicit confirmation naming the environment. */
  readonly canWrite?: boolean;
  /** Present when the environment is typed Production (or untyped): changes stay off until the person acknowledges it. */
  readonly acknowledgement?: { readonly given: boolean; readonly onChange: (given: boolean) => void };
  /** Present when the environment could not be identified (editing stays off): the person can check again. */
  readonly identification?: { readonly onRetry: () => void };
}

export function EnvironmentIndicator({ connection, dataSource = 'synthetic', canWrite = false, acknowledgement, identification }: Props) {
  let label: string;
  let tone: 'host' | 'warn' | 'demo';
  switch (connection?.kind) {
    case undefined:
      label = 'Checking connection…';
      tone = 'warn';
      break;
    case 'host':
      label = `Connected: ${connection.name} (${connection.url})${connection.environmentType ? ` · ${connection.environmentType}` : ''}`;
      tone = 'host';
      break;
    case 'none':
      label = 'Not connected: select a connection in Power Platform ToolBox';
      tone = 'warn';
      break;
    case 'error':
      label = `Connection unavailable: ${connection.message}`;
      tone = 'warn';
      break;
    case 'demo':
      label = 'Demo mode: Power Platform ToolBox host not detected';
      tone = 'demo';
      break;
  }
  return (
    <div className="env" role="status" aria-label="Environment">
      <span className={`env-badge env-${tone}`}>{label}</span>
      {dataSource === 'live' ? (
        <span
          className="env-badge env-host"
          title={
            canWrite
              ? 'Live Dataverse data. Editing is enabled: nothing is changed until you preview and confirm; the confirmation is bound to this environment.'
              : acknowledgement
                ? 'Live Dataverse data, read mode: acknowledge that this is a Production environment to enable editing.'
                : 'Live Dataverse data, read mode (no write path, or the environment could not be identified).'
          }
        >
          {canWrite ? 'Live Dataverse data · editing enabled' : 'Live Dataverse data · read mode'}
          <span className="sr-only">
            {canWrite ? '. Nothing is changed until you preview and confirm.' : '. Changes are not available.'}
          </span>
        </span>
      ) : (
        <span className="env-badge env-demo">Synthetic data (not read from this environment)</span>
      )}
      {identification ? (
        <span className="env-badge env-warn" role="status">
          The environment could not be identified, so editing is off.
          <button type="button" className="env-retry" onClick={identification.onRetry}>Check again</button>
        </span>
      ) : null}
      {acknowledgement ? (
        <label className="env-ack">
          <input type="checkbox" checked={acknowledgement.given} onChange={(e) => acknowledgement.onChange(e.target.checked)} />
          This is a Production environment (or its type is unknown). I understand and want to allow changes here.
        </label>
      ) : null}
    </div>
  );
}
