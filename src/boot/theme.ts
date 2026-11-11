// Follows the PPTB theme. Without it the stylesheet only knows the operating system setting, which differs from the host's own theme when
// the user picked another one in PPTB. The host has no theme event, so the theme is read at start and again when the window gets focus.
// Any failure leaves the system setting in charge (no data-theme attribute).
import type { HostWindow } from '../adapters/pptb/connection';

export async function applyHostTheme(host: HostWindow, root: HTMLElement = document.documentElement): Promise<void> {
  const get = host.toolboxAPI?.utils?.getCurrentTheme;
  if (typeof get !== 'function') return;
  try {
    const theme = await get.call(host.toolboxAPI?.utils);
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  } catch {
    /* keep the system setting */
  }
}

export function followHostTheme(host: HostWindow, target: Window = window): void {
  void applyHostTheme(host);
  target.addEventListener('focus', () => void applyHostTheme(host));
}
