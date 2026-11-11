import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BUILD, describeError } from '../boot/diagnostics';

interface State {
  readonly error: unknown;
}

/** Catches a failure while rendering and shows what happened instead of an empty window. Nothing is written or read again from here. */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error('Unknown error') };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Dataverse Security Manager failed to render', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const detail = `Build: ${BUILD}\n\n${describeError(this.state.error)}`;
    return (
      <div role="alert" className="app" style={{ padding: 24 }}>
        <h2>Dataverse Security Manager hit an error</h2>
        <p>
          A screen stopped because of an error. If a change to Dataverse was being applied at that moment, its outcome is not known: open Operations to see what was recorded, and read the
          objects again before repeating anything. Send the details below to the developer.
        </p>
        <pre className="msg msg-error" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{detail}</pre>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(detail).catch(() => undefined)}>Copy details</button>
      </div>
    );
  }
}
