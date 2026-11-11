import type { ReactNode } from 'react';

// Small inline line icons (no dependency, no network). Always decorative: the visible text carries the meaning.
const PATHS: Record<string, ReactNode> = {
  analyzer: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  access: <><circle cx="10" cy="10" r="6" /><path d="M15 15l6 6" /></>,
  bu: <><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-4h12v4" /></>,
  operations: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  privilege: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" /></>,
  depth: <><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></>,
  roles: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M16 5a3.2 3.2 0 010 6M18 14.5c2 .7 3.5 2.6 3.5 5.5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  close: <><path d="M6 6l12 12M18 6L6 18" /></>,
  restore: <><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.7L3 8" /><path d="M3 3v5h5" /></>,
  check: <><path d="M5 12.5l4.5 4.5L19 7.5" /></>,
  warn: <><path d="M12 3.5l9.5 16.5h-19L12 3.5z" /><path d="M12 10v4.5M12 17.5v.5" /></>,
  arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  chevron: <><path d="M9 6l6 6-6 6" /></>,
  refresh: <><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  spinner: <><path d="M12 3a9 9 0 019 9" /></>,
  tables: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M3 15h18M10 5v14" /></>,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { readonly name: string }) {
  const body = PATHS[name];
  if (!body) return null;
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {body}
    </svg>
  );
}

/** The icon of a screen by its module id (none for an unknown module). */
export const MODULE_ICON: Record<string, string> = { analyzer: 'analyzer', explorer: 'access', bu: 'bu', operations: 'operations' };
