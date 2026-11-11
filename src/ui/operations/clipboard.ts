// Copy text to the clipboard from a PPTB webview. The async Clipboard API may be missing or refused there, so a textarea + execCommand
// fallback follows it. Returns false when neither worked, so the caller can show the text for manual copying instead of claiming success.

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

function legacyCopy(text: string, doc: Document): boolean {
  try {
    if (typeof doc.execCommand !== 'function') return false;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    return ok === true;
  } catch {
    return false;
  }
}

export async function copyText(text: string, api: ClipboardLike | undefined, doc: Document = document): Promise<boolean> {
  if (api && typeof api.writeText === 'function') {
    try {
      await api.writeText(text);
      return true;
    } catch {
      // denied or unavailable: try the fallback
    }
  }
  return legacyCopy(text, doc);
}

export function systemClipboard(): ClipboardLike | undefined {
  return typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function' ? navigator.clipboard : undefined;
}
