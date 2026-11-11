import { useState } from 'react';
import { stamp } from '../operations/download';
import { copyWith, useReportServices } from './ReportContext';

interface Props {
  /** Names the thing exported, for button labels and the file name ("table-account-roles"). */
  readonly label: string;
  readonly fileBase: string;
  readonly text: () => string;
  readonly csv: () => string;
  readonly disabled?: boolean;
}

/** Copy report / Export .txt / Export CSV. A failed copy shows the text for manual copying instead of claiming success. */
export function ExportBar({ label, fileBase, text, csv, disabled }: Props) {
  const services = useReportServices();
  const [notice, setNotice] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);

  const save = (kind: 'txt' | 'csv') => {
    setManual(null);
    try {
      const content = kind === 'txt' ? text() : csv();
      services.download({ filename: `${fileBase}-${stamp(services.now())}.${kind}`, mime: kind === 'txt' ? 'text/plain' : 'text/csv', content });
      setNotice(`${kind === 'txt' ? 'Text report' : 'CSV'} export started.`);
    } catch {
      setNotice('The export could not be created.');
    }
  };
  const copy = async () => {
    const content = text();
    const ok = await copyWith(services, content);
    setManual(ok ? null : content);
    setNotice(ok ? 'Report copied to the clipboard.' : 'The clipboard is not available here. Select the text below and copy it.');
  };

  return (
    <span className="export-bar" role="group" aria-label={`Export ${label}`}>
      <button type="button" disabled={disabled} onClick={() => void copy()}>Copy report</button>
      <button type="button" disabled={disabled} onClick={() => save('txt')}>Export .txt</button>
      <button type="button" disabled={disabled} onClick={() => save('csv')}>Export CSV</button>
      <span role="status" aria-live="polite" className="export-notice">{notice}</span>
      {manual !== null && <textarea readOnly className="export-manual" aria-label="Report text to copy" rows={8} value={manual} onFocus={(e) => e.currentTarget.select()} />}
    </span>
  );
}
