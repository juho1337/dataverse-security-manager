import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FixtureAccessReader } from '../../adapters/fixture/accessFixture';
import { FixtureReader } from '../../adapters/fixture/fixtureReader';
import { App } from '../App';
import { AccessExplorerModule } from '../access/AccessExplorerModule';
import type { DownloadFile } from '../operations/download';
import { ReportContext, type ReportServices } from './ReportContext';

const NOW = Date.UTC(2026, 11, 1, 8, 30, 0);

function services(over: Partial<ReportServices> = {}) {
  const files: DownloadFile[] = [];
  const copied: string[] = [];
  const value: ReportServices = {
    environment: 'Contoso Dev (https://contoso-dev.crm4.dynamics.com)',
    now: () => NOW,
    download: (f) => void files.push(f),
    clipboard: { writeText: async (t) => void copied.push(t) },
    ...over,
  };
  return { value, files, copied };
}

type U = ReturnType<typeof userEvent.setup>;

async function pickTable(user: U, search: string, optionName: RegExp) {
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, search);
  await user.click(await screen.findByRole('option', { name: optionName }));
  await screen.findByRole('treegrid');
}

function renderAnalyzer(s: ReturnType<typeof services>) {
  return render(<App reader={new FixtureReader()} report={s.value} />);
}

async function openTablePrivileges(user: U) {
  await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'ann');
  await screen.findByText(/found\./);
  await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
  await user.click(await screen.findByRole('button', { name: 'Table privileges' }));
  await screen.findByRole('table', { name: 'Table privileges by privilege' });
}

function renderExplorer(s: ReturnType<typeof services>) {
  return render(
    <ReportContext.Provider value={s.value}>
      <AccessExplorerModule reader={new FixtureAccessReader()} debounceMs={0} />
    </ReportContext.Provider>,
  );
}

describe('Role Analyzer: export of the selected table role matrix', () => {
  it('exports the roles on screen as text and CSV, and names the table, environment and filters', async () => {
    const s = services();
    const user = userEvent.setup();
    renderAnalyzer(s);
    await pickTable(user, 'contoso_project', /Contoso Project/);

    await user.click(screen.getByRole('button', { name: 'Export .txt' }));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(s.files.map((f) => f.filename)).toEqual(['table-contoso_project-roles-20261201-083000.txt', 'table-contoso_project-roles-20261201-083000.csv']);
    const [txt, csv] = s.files as [DownloadFile, DownloadFile];
    expect(txt.mime).toBe('text/plain');
    expect(txt.content).toContain('SECURITY ROLES ON TABLE - Contoso Project (contoso_project)');
    expect(txt.content).toContain('Environment: Contoso Dev (https://contoso-dev.crm4.dynamics.com)');
    expect(txt.content).toContain('Project Contributor');
    expect(csv.mime).toBe('text/csv');
    expect(csv.content.split('\r\n')[0]).toContain('Security role,Role id,Managed,Create,Read');
    // the roles exported are the roles on screen
    const onScreen = within(screen.getByRole('treegrid')).getAllByRole('row').length - 1;
    expect(csv.content.trimEnd().split('\r\n').length - 1).toBe(onScreen);
  });

  it('keeps the role-name search in the export and in the file header, and the search survives the export', async () => {
    const s = services();
    const user = userEvent.setup();
    renderAnalyzer(s);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await user.type(screen.getByRole('searchbox', { name: 'Search roles' }), 'contributor');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    const lines = s.files[0]!.content.trimEnd().split('\r\n').slice(1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => /contributor/i.test(l.split(',')[2] ?? ''))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    expect(s.copied[0]).toContain('View: role name contains "contributor"');
    expect((screen.getByRole('searchbox', { name: 'Search roles' }) as HTMLInputElement).value).toBe('contributor');
  });

  it('copies the report', async () => {
    const s = services();
    const user = userEvent.setup();
    renderAnalyzer(s);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    expect(s.copied).toHaveLength(1);
    expect(await screen.findByText('Report copied to the clipboard.')).toBeTruthy();
  });

  it('shows the text for manual copying instead of claiming success when the clipboard fails', async () => {
    const s = services({
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    const user = userEvent.setup();
    renderAnalyzer(s);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    expect(await screen.findByText(/clipboard is not available here/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Report text to copy' }) as HTMLTextAreaElement).value).toContain('SECURITY ROLES ON TABLE');
    expect(screen.queryByText('Report copied to the clipboard.')).toBeNull();
  });
});

describe('Access Explorer: export of the table privileges of a user', () => {
  it('exports the aggregated depths with every contributing role and its source', async () => {
    const s = services();
    const user = userEvent.setup();
    renderExplorer(s);
    await openTablePrivileges(user);

    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    const text = s.copied[0]!;
    expect(text).toContain('TABLE PRIVILEGES OF USER - Ann Admin');
    expect(text).toContain('Account (account)');
    expect(text).toMatch(/Read: Organization from .* direct/);
    expect(text).toContain('not effective access to a record');
    const csv = s.files[0]!;
    expect(csv.filename).toBe('user-table-privileges-20261201-083000.csv');
    expect(csv.content.split('\r\n')[0]).toContain('Subject type,Subject,Table');
    expect(csv.content).toContain('user,Ann Admin,Account,account,Read,Organization');
  });

  it('a partial read is never exported as exhaustive: the text is headed, and every CSV row says it is not complete and why', async () => {
    const s = services();
    const user = userEvent.setup();
    renderExplorer(s);
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'pat');
    await screen.findByText(/found\./);
    await user.click(screen.getByRole('button', { name: /Pat Partial/ }));
    await user.click(await screen.findByRole('button', { name: 'Table privileges' }));
    await screen.findByRole('table', { name: 'Table privileges by privilege' });
    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(s.copied[0]).toContain('PARTIAL RESULT');
    const rows = s.files[0]!.content.trimEnd().split('\r\n').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l) => /,no,.+$/.test(l))).toBe(true); // Complete = no, with the read notes
    expect(rows.some((l) => l.includes(',UNKNOWN,'))).toBe(true);
    expect(rows.some((l) => l.includes(',No grant,'))).toBe(false);
  });

  it('exports every table that matches the search and names the search', async () => {
    const s = services();
    const user = userEvent.setup();
    renderExplorer(s);
    await openTablePrivileges(user);
    await user.type(screen.getByRole('searchbox', { name: 'Find a table' }), 'contoso');
    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    expect(s.copied[0]).toContain('View: table name contains "contoso"');
    expect(s.copied[0]).toContain('Contoso Project (contoso_project)');
    expect(s.copied[0]).not.toContain('Account (account)');
  });
});
