import { createContext, useContext } from 'react';
import { copyText, systemClipboard, type ClipboardLike } from '../operations/clipboard';
import { downloadWithAnchor, type Downloader } from '../operations/download';

/** What the report buttons need from the shell: how the environment is named, the clock, and where files and text go (injectable for tests). */
export interface ReportServices {
  readonly environment: string;
  readonly now: () => number;
  readonly download: Downloader;
  /** Undefined = the browser clipboard when it exists; null = none (the text is then shown for manual copying). */
  readonly clipboard?: ClipboardLike | null;
}

export const DEFAULT_REPORT_SERVICES: ReportServices = {
  environment: 'the connected environment',
  now: () => Date.now(),
  download: (f) => downloadWithAnchor(f),
};

export const ReportContext = createContext<ReportServices>(DEFAULT_REPORT_SERVICES);

export const useReportServices = (): ReportServices => useContext(ReportContext);

export async function copyWith(services: ReportServices, text: string): Promise<boolean> {
  const api = services.clipboard === undefined ? systemClipboard() : (services.clipboard ?? undefined);
  return copyText(text, api);
}
