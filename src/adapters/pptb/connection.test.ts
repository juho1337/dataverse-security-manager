import { describe, expect, it } from 'vitest';
import { getConnectionState } from './connection';
import type { HostWindow } from './connection';

const hostWith = (getActiveConnection: () => Promise<{ name?: string; url?: string; environment?: string } | null>): HostWindow => ({
  toolboxAPI: { connections: { getActiveConnection } },
});

describe('getConnectionState', () => {
  it('reports demo mode when the host API is missing', async () => {
    expect(await getConnectionState(undefined)).toEqual({ kind: 'demo' });
    expect(await getConnectionState({})).toEqual({ kind: 'demo' });
  });

  it('reports none when the host has no active connection', async () => {
    expect(await getConnectionState(hostWith(async () => null))).toEqual({ kind: 'none' });
  });

  it('reports the host connection with name, url and environment type', async () => {
    const state = await getConnectionState(hostWith(async () => ({ name: 'Dev org', url: 'https://example.crm4.dynamics.com', environment: 'Dev' })));
    expect(state).toEqual({ kind: 'host', name: 'Dev org', url: 'https://example.crm4.dynamics.com', environmentType: 'Dev' });
  });

  it('ignores an unknown environment type instead of trusting it', async () => {
    const state = await getConnectionState(hostWith(async () => ({ url: 'https://x', environment: 'Sandbox?' })));
    expect(state).toMatchObject({ kind: 'host', environmentType: null });
  });

  it('turns a host failure into an error state without leaking details', async () => {
    const state = await getConnectionState(hostWith(async () => { throw new Error('token abc123 expired'); }));
    expect(state.kind).toBe('error');
    expect(JSON.stringify(state)).not.toContain('abc123');
  });
});
