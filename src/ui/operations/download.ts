export interface DownloadFile {
  readonly filename: string;
  readonly mime: string;
  readonly content: string;
}

export type Downloader = (file: DownloadFile) => void;

/** Blob + anchor download. The document is injectable so it can be tested without a browser. */
export function downloadWithAnchor(file: DownloadFile, doc: Document = document): void {
  // A UTF-8 byte order mark makes spreadsheets read non-ASCII text in CSV correctly.
  const blob = new Blob([file.mime.includes('csv') ? '﻿' : '', file.content], { type: `${file.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.hidden = true;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** File-name-safe stamp such as 20261102-100000. */
export function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
}
