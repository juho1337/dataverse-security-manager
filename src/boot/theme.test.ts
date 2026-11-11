import { describe, expect, it, vi } from 'vitest';
import type { HostWindow } from '../adapters/pptb/connection';
import { applyHostTheme, followHostTheme } from './theme';

const hostWith = (get: () => Promise<'light' | 'dark'>): HostWindow => ({ toolboxAPI: { utils: { getCurrentTheme: get } } });

describe('host theme', () => {
  it('sets data-theme from the host', async () => {
    const root = document.createElement('html');
    await applyHostTheme(hostWith(async () => 'dark'), root);
    expect(root.dataset.theme).toBe('dark');
    await applyHostTheme(hostWith(async () => 'light'), root);
    expect(root.dataset.theme).toBe('light');
  });
  it('leaves the system setting in charge without a host, on an unknown value or on failure', async () => {
    const root = document.createElement('html');
    await applyHostTheme({}, root);
    await applyHostTheme(hostWith(async () => 'blue' as 'dark'), root);
    await applyHostTheme(hostWith(async () => { throw new Error('no'); }), root);
    expect(root.dataset.theme).toBeUndefined();
  });
  it('reads the theme again when the window gets focus', async () => {
    const get = vi.fn(async () => 'dark' as const);
    const target = new EventTarget() as unknown as Window;
    followHostTheme(hostWith(get), target);
    target.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
