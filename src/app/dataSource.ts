import { FixtureReader } from '../adapters/fixture/fixtureReader';
import type { HostWindow } from '../adapters/pptb/connection';
import { createPptbSecurityDataReader, type PptbReaderOptions } from '../adapters/pptb/reader';
import type { SecurityDataReader } from '../ports/securityDataReader';

/**
 * Where the data on screen comes from. `live`: read through the Power Platform ToolBox host (read-only, after the environment identity
 * check). `synthetic`: the built-in fictional demo data, only when no host is present. The two are never mixed: inside a host the tool
 * never falls back to synthetic data (a failed live read is an error, not demo data), and synthetic data is never labelled as live.
 */
export type DataSource = 'live' | 'synthetic';

export interface SelectedReader {
  readonly reader: SecurityDataReader;
  readonly dataSource: DataSource;
}

/** True when the page runs inside a PPTB host (the host injects at least one of its APIs). */
export function isHostPresent(host: HostWindow | undefined): boolean {
  return Boolean(host?.toolboxAPI || host?.dataverseAPI);
}

export function selectReader(host: HostWindow | undefined, options: { readonly synthetic?: () => SecurityDataReader; readonly live?: PptbReaderOptions } = {}): SelectedReader {
  if (isHostPresent(host)) return { reader: createPptbSecurityDataReader(host, options.live), dataSource: 'live' };
  return { reader: options.synthetic ? options.synthetic() : new FixtureReader({ latencyMs: 250 }), dataSource: 'synthetic' };
}
