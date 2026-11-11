import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import type { HostWindow } from '../adapters/pptb/connection';
import type { VerifiedEnvironment } from '../adapters/pptb/identity';
import { createEnvironmentResolver, requiresProductionAcknowledgement } from '../app/environment';
import type { SecurityDataWriter } from '../ports/securityDataWriter';
import { App } from './App';
import type { AppModule } from './modules';

// Decision D1 (2026-11-10): no fixed environment. The environment is identified at run time; a Production-typed (or untyped) one needs an
// acknowledgement before any change can be confirmed.

const ENV: VerifiedEnvironment = { url: 'https://contoso-prod.crm4.dynamics.com', organizationId: 'aaaaaaaa-0000-0000-0000-000000000001', environmentId: 'bbbbbbbb-0000-0000-0000-000000000002', key: 'bbbbbbbb-0000-0000-0000-000000000002' };
const WRITER = {} as SecurityDataWriter;

function hostOf(environment: string | undefined): HostWindow {
  const active = { id: 'c1', name: 'Contoso', url: ENV.url, ...(environment ? { environment } : {}) };
  return { toolboxAPI: { connections: { getActiveConnection: async () => active, getConnections: async () => [active] } } };
}

/** A module that only shows what the shell hands to a write path. */
const probe: AppModule = {
  id: 'probe',
  label: 'Probe',
  render: ({ writer, environmentId }) => <p data-testid="probe">{writer ? `can write for ${environmentId}` : 'read only'}</p>,
};

const mount = (environment: string | undefined, resolve: () => Promise<VerifiedEnvironment | null> = async () => ENV) =>
  render(<App reader={new FixtureReader()} host={hostOf(environment)} dataSource="live" writer={WRITER} resolveEnvironment={resolve} modules={[probe]} />);

describe('requiresProductionAcknowledgement', () => {
  it('asks for Production and for an unknown type, never for Dev, Test or UAT', () => {
    expect(requiresProductionAcknowledgement('Production')).toBe(true);
    expect(requiresProductionAcknowledgement(null)).toBe(true);
    for (const t of ['Dev', 'Test', 'UAT'] as const) expect(requiresProductionAcknowledgement(t)).toBe(false);
  });
});

describe('environment resolver', () => {
  it('returns the identified environment of a verified reader, and null for refusals, failures and readers that cannot identify', async () => {
    expect(await createEnvironmentResolver({ verifyIdentity: async () => ({ status: 'verified', environment: ENV }) })?.()).toEqual(ENV);
    expect(await createEnvironmentResolver({ verifyIdentity: async () => ({ status: 'refused' }) })?.()).toBeNull();
    expect(await createEnvironmentResolver({ verifyIdentity: async () => { throw new Error('x'); } })?.()).toBeNull();
    expect(createEnvironmentResolver(new FixtureReader())).toBeUndefined();
  });
});

describe('App write gate (no fixed environment)', () => {
  it('a Dev, Test or UAT environment is writable once identified, with the confirmation bound to the identified environment', async () => {
    mount('Test');
    expect(await screen.findByText(`can write for ${ENV.key}`)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/editing enabled/)).toBeTruthy();
  });

  it('nothing can be written until the environment is identified, and never when it cannot be', async () => {
    mount('Test', async () => null);
    await screen.findByText(/Connected: Contoso/);
    expect(screen.getByTestId('probe').textContent).toBe('read only');
    expect(screen.getByText(/read mode/)).toBeTruthy();
  });

  it('a Production environment stays read-only until it is acknowledged, then becomes writable for that environment', async () => {
    const user = userEvent.setup();
    mount('Production');
    const box = await screen.findByRole('checkbox', { name: /Production environment/ });
    expect(screen.getByTestId('probe').textContent).toBe('read only');
    await user.click(box);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe(`can write for ${ENV.key}`));
    await user.click(box);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('read only'));
  });

  it('an environment whose type is not reported is treated like Production', async () => {
    mount(undefined);
    expect(await screen.findByRole('checkbox', { name: /Production environment/ })).toBeTruthy();
    expect(screen.getByTestId('probe').textContent).toBe('read only');
  });

  it('has no write path in demo mode (no writer), whatever the resolver says', async () => {
    const resolve = vi.fn(async () => ENV);
    render(<App reader={new FixtureReader()} writer={null} resolveEnvironment={resolve} modules={[probe]} />);
    expect((await screen.findByTestId('probe')).textContent).toBe('read only');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('App write gate: an unread or mismatching connection never enables writes; identification recovers', () => {
  const hostWith = (getActive: () => Promise<{ id?: string; name?: string; url?: string; environment?: string } | null>): HostWindow => ({
    toolboxAPI: { connections: { getActiveConnection: getActive, getConnections: async () => [{ url: ENV.url }] } },
  });

  it('keeps writes off while the connection state is not known (the identification alone is not enough), then enables them for a Test environment', async () => {
    let release: (v: { id: string; name: string; url: string; environment: string }) => void = () => undefined;
    const pending = new Promise<{ id: string; name: string; url: string; environment: string }>((r) => { release = r; });
    render(<App reader={new FixtureReader()} host={hostWith(() => pending)} dataSource="live" writer={WRITER} resolveEnvironment={async () => ENV} modules={[probe]} />);
    await screen.findByTestId('probe');
    await new Promise((r) => setTimeout(r, 30)); // the identification has finished, the header's connection read has not
    expect(screen.getByTestId('probe').textContent).toBe('read only');
    release({ id: 'c1', name: 'Contoso', url: ENV.url, environment: 'Test' });
    expect(await screen.findByText(`can write for ${ENV.key}`)).toBeTruthy();
  });

  it('keeps writes off when the header cannot read the connection, and when it is a different connection than the identified environment', async () => {
    const { unmount } = render(<App reader={new FixtureReader()} host={hostWith(async () => { throw new Error('host failed'); })} dataSource="live" writer={WRITER} resolveEnvironment={async () => ENV} modules={[probe]} />);
    await screen.findByText(/Connection unavailable/);
    expect(screen.getByTestId('probe').textContent).toBe('read only');
    unmount();
    render(<App reader={new FixtureReader()} host={hostWith(async () => ({ id: 'c2', name: 'Other', url: 'https://other.crm4.dynamics.com', environment: 'Dev' }))} dataSource="live" writer={WRITER} resolveEnvironment={async () => ENV} modules={[probe]} />);
    await screen.findByText(/Connected: Other/);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('probe').textContent).toBe('read only');
  });

  it('a failed identification can be checked again by hand and then enables editing', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn<() => Promise<VerifiedEnvironment | null>>().mockResolvedValueOnce(null).mockResolvedValue(ENV);
    render(<App reader={new FixtureReader()} host={hostOf('Dev')} dataSource="live" writer={WRITER} resolveEnvironment={resolve} modules={[probe]} />);
    await screen.findByText(/could not be identified, so editing is off/);
    expect(screen.getByTestId('probe').textContent).toBe('read only');
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(`can write for ${ENV.key}`)).toBeTruthy();
    expect(screen.queryByText(/could not be identified/)).toBeNull();
  });
});
