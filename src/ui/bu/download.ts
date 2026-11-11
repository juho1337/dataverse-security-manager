// Saves text as a file through a Blob and an anchor (the webview File API; no host file API is assumed). Injectable so tests do not need a DOM download.

export type Downloader = (fileName: string, mime: string, content: string) => void;

export const browserDownload: Downloader = (fileName, mime, content) => {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
