import './boot/early';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostWindow } from './adapters/pptb/connection';
import { createHostSecurityWriter } from './adapters/pptb/writer/hostWriter';
import { selectReader } from './app/dataSource';
import { createEnvironmentResolver } from './app/environment';
import { bootState } from './boot/diagnostics';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/styles.css';

// Inside a Power Platform ToolBox host the tool reads live Dataverse data (read-only, after the environment identity check); without a host
// it shows clearly labelled synthetic demo data. The data source is chosen once, here, and the header always says which one it is.
const host = window as unknown as HostWindow;
const { reader, dataSource } = selectReader(host);
// Only inside a host that provides the Dataverse API; the writer identifies the connected environment before every write and refuses a
// confirmation given for another one (decision D1: no fixed environment). Never in demo mode.
const writer = dataSource === 'live' ? createHostSecurityWriter(host) : null;
const resolveEnvironment = createEnvironmentResolver(reader);
const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App reader={reader} host={host} dataSource={dataSource} writer={writer} {...(resolveEnvironment ? { resolveEnvironment } : {})} />
    </ErrorBoundary>
  </StrictMode>,
);
// From here on a failure belongs to the app (its error boundary), not to the start-up banner.
requestAnimationFrame(() => {
  bootState.mounted = true;
});
