import { classifyHostError, type ClassifiedError } from './errors';

// How a list read walks all pages is the least certain part of the host contract.
// UNVERIFIED (to be settled by the read integration test on the Developer environment):
//  - whether the host returns every page or only the first 5000 rows of a FetchXML query,
//  - whether the `page` attribute is honored without the paging cookie,
//  - how (or whether) `queryData` exposes a next link; the types declare none, so this strategy uses FetchXML only.
// The assumption is isolated here so it can be replaced without touching the reader.

export interface PagedRows {
  readonly rows: readonly Record<string, unknown>[];
  /** False when a later page failed, the page limit was reached, or the host did not honor paging. */
  readonly complete: boolean;
  readonly pages: number;
  /** Why the result is incomplete (safe text). */
  readonly note?: string;
  readonly error?: ClassifiedError;
}

export type PageFetcher = (fetchXml: string) => Promise<{ value: Record<string, unknown>[] }>;

export interface PagingStrategy {
  /** `build(page, pageSize)` returns the FetchXML for one page. `keyOf` identifies a row (duplicate-page guard). */
  readAll(
    build: (page: number, pageSize: number) => string,
    fetchPage: PageFetcher,
    keyOf: (row: Record<string, unknown>) => string,
  ): Promise<PagedRows>;
}

export interface PageNumberOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
}

/**
 * FetchXML page-number paging: request page 1, 2, ... with a fixed page size until a page comes back short.
 * A failing first page throws (nothing usable); a failing later page returns what was read, flagged incomplete.
 */
export function createPageNumberStrategy(options: PageNumberOptions = {}): PagingStrategy {
  const pageSize = options.pageSize ?? 5000;
  const maxPages = options.maxPages ?? 200;
  return {
    async readAll(build, fetchPage, keyOf) {
      const rows: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= maxPages; page++) {
        let batch: Record<string, unknown>[];
        try {
          batch = (await fetchPage(build(page, pageSize))).value ?? [];
        } catch (e) {
          if (page === 1) throw e;
          const error = classifyHostError(e);
          // A changed connection abandons the whole read: never return rows as a partial result.
          if (error.kind === 'connectionChanged') throw e;
          return { rows, complete: false, pages: page - 1, error, note: `Page ${page} could not be read (${error.kind}).` };
        }
        const fresh = batch.filter((r) => !seen.has(keyOf(r)));
        // A full page made only of rows already seen means the host ignored the page number: stop instead of looping.
        if (batch.length > 0 && fresh.length === 0) {
          return { rows, complete: false, pages: page, note: 'The host returned the same rows again; paging is not honored, so the list may be incomplete.' };
        }
        for (const r of fresh) {
          seen.add(keyOf(r));
          rows.push(r);
        }
        if (batch.length < pageSize) return { rows, complete: true, pages: page };
      }
      return { rows, complete: false, pages: maxPages, note: `Stopped after ${maxPages} pages; the list may be incomplete.` };
    },
  };
}
