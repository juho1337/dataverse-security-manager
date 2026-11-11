import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootState, describeError, installDiagnostics, showFatal } from './diagnostics';

// jsdom reports a dispatched error event that nobody cancels as an uncaught exception of the test run; this listener marks it as handled.
const swallow = (e: Event) => e.preventDefault();
beforeEach(() => window.addEventListener('error', swallow));
afterEach(() => {
  window.removeEventListener('error', swallow);
  document.getElementById('dsm-fatal')?.remove();
  bootState.mounted = false;
});

describe('startup diagnostics', () => {
  it('writes a failure before the first render onto the page, with the message, a stack and the build', () => {
    const off = installDiagnostics(window);
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('x is not a function'), message: 'x is not a function' }));
    const box = document.getElementById('dsm-fatal');
    expect(box?.getAttribute('role')).toBe('alert');
    expect(box?.textContent).toContain('could not start');
    expect(box?.textContent).toContain('TypeError: x is not a function');
    expect(box?.textContent).toContain('Build:');
    expect(box?.textContent).toContain('Copy details');
    off();
  });

  it('does not take over the screen for an error after the app has mounted, and stops listening when removed', () => {
    const off = installDiagnostics(window);
    bootState.mounted = true;
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('late'), message: 'late' }));
    expect(document.getElementById('dsm-fatal')).toBeNull();
    bootState.mounted = false;
    off();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('after off'), message: 'after off' }));
    expect(document.getElementById('dsm-fatal')).toBeNull();
  });

  it('shows text only (never HTML) and describes non-Error values', () => {
    showFatal(document, 'T', '<img src=x onerror=alert(1)>');
    expect(document.getElementById('dsm-fatal-text')?.textContent).toContain('<img src=x');
    expect(document.querySelector('#dsm-fatal img')).toBeNull();
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ a: 1 })).toBe('{"a":1}');
  });
});
