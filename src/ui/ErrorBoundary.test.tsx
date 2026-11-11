import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('render failed');
}

describe('ErrorBoundary', () => {
  it('shows what went wrong instead of an empty window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert').textContent).toContain('render failed');
    expect(screen.getByRole('alert').textContent).toContain('Build:');
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeTruthy();
  });

  it('never claims that nothing was written: a render failure does not establish the outcome of a write that was running', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).not.toMatch(/nothing was written/i);
    expect(text).toMatch(/outcome is not known/);
    expect(text).toMatch(/Operations/);
  });

  it('renders its children when nothing fails', () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
    expect(screen.getByText('fine')).toBeTruthy();
  });
});
