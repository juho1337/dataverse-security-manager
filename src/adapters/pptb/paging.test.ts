import { describe, expect, it } from 'vitest';
import { ConnectionChangedError } from './errors';
import { createPageNumberStrategy } from './paging';

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
const key = (r: Record<string, unknown>) => String(r['id']);
const build = (p: number, s: number) => `page=${p};count=${s}`;

/** A fake host paging over `all`, honoring page and count. */
const pager = (all: Record<string, unknown>[], onCall?: (page: number) => void) => async (fx: string) => {
  const page = Number(/page=(\d+)/.exec(fx)?.[1]);
  const size = Number(/count=(\d+)/.exec(fx)?.[1]);
  onCall?.(page);
  return { value: all.slice((page - 1) * size, page * size) };
};

describe('page-number paging strategy', () => {
  it('reads every page until a short page and reports complete', async () => {
    const r = await createPageNumberStrategy({ pageSize: 4 }).readAll(build, pager(rowsOf(10)), key);
    expect(r.rows).toHaveLength(10);
    expect(r).toMatchObject({ complete: true, pages: 3 });
  });

  it('asks for one more page when the last page is exactly full, then stops on the empty page', async () => {
    const pages: number[] = [];
    const r = await createPageNumberStrategy({ pageSize: 5 }).readAll(build, pager(rowsOf(10), (p) => pages.push(p)), key);
    expect(r.complete).toBe(true);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('flags the result incomplete and keeps earlier rows when a later page fails', async () => {
    const fetchPage = async (fx: string) => {
      if (fx.startsWith('page=2')) throw new Error('503 service unavailable');
      return { value: rowsOf(4) };
    };
    const r = await createPageNumberStrategy({ pageSize: 4 }).readAll(build, fetchPage, key);
    expect(r.rows).toHaveLength(4);
    expect(r.complete).toBe(false);
    expect(r.error?.kind).toBe('network');
    expect(r.note).toContain('Page 2');
  });

  it('abandons the read, with no partial rows, when a later page reports a changed connection', async () => {
    const fetchPage = async (fx: string) => {
      if (fx.startsWith('page=2')) throw new ConnectionChangedError();
      return { value: rowsOf(4) };
    };
    await expect(createPageNumberStrategy({ pageSize: 4 }).readAll(build, fetchPage, key)).rejects.toBeInstanceOf(ConnectionChangedError);
  });

  it('throws when the first page fails (nothing usable)', async () => {
    await expect(createPageNumberStrategy().readAll(build, async () => { throw new Error('boom'); }, key)).rejects.toThrow('boom');
  });

  it('does not loop forever when the host ignores the page number', async () => {
    const r = await createPageNumberStrategy({ pageSize: 3 }).readAll(build, async () => ({ value: rowsOf(3) }), key);
    expect(r.rows).toHaveLength(3);
    expect(r.complete).toBe(false);
    expect(r.note).toContain('paging is not honored');
  });

  it('stops at the page limit and says so', async () => {
    const r = await createPageNumberStrategy({ pageSize: 1, maxPages: 3 }).readAll(build, pager(rowsOf(50)), key);
    expect(r.rows).toHaveLength(3);
    expect(r).toMatchObject({ complete: false, pages: 3 });
  });
});
