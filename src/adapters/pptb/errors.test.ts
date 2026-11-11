import { describe, expect, it, vi } from 'vitest';
import { classifyHostError, ConnectionChangedError, HostCallError, toPortErrorClass, withRetry } from './errors';

describe('classifyHostError', () => {
  it.each([
    [{ status: 429, message: 'Too many requests' }, 'throttled'],
    [new Error('Number of requests exceeded the limit (service protection)'), 'throttled'],
    [Object.assign(new Error('Unauthorized'), { status: 401 }), 'auth'],
    [new Error('AADSTS70043: The refresh token has expired'), 'auth'],
    [Object.assign(new Error('Principal user is missing prvReadRole privilege'), { status: 403 }), 'permission'],
    [new Error('Access is denied'), 'permission'],
    [Object.assign(new Error('Resource not found'), { status: 404 }), 'notFound'],
    [new Error('Failed to fetch'), 'network'],
    [new Error('503 Service Unavailable'), 'network'],
    [new Error('something odd'), 'unknown'],
    ['plain string failure', 'unknown'],
  ])('classifies %j as %s', (input, kind) => {
    expect(classifyHostError(input).kind).toBe(kind);
  });

  it('reads Retry-After from a property, a header map or the message', () => {
    expect(classifyHostError({ message: 'x', status: 429, retryAfter: 7 }).retryAfterMs).toBe(7000);
    expect(classifyHostError({ message: 'x', status: 429, headers: { 'retry-after': '3' } }).retryAfterMs).toBe(3000);
    expect(classifyHostError(new Error('429 too many requests, Retry-After: 12')).retryAfterMs).toBe(12000);
  });

  it('removes bearer tokens and JWTs from messages', () => {
    const m = classifyHostError(new Error('failed Bearer abc.def-ghi and eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl')).message;
    expect(m).not.toContain('abc.def-ghi');
    expect(m).not.toContain('eyJhbGciOi');
  });

  it('maps auth to the port class permission and keeps the other classes', () => {
    expect(toPortErrorClass('auth')).toBe('permission');
    expect(toPortErrorClass('throttled')).toBe('throttled');
    expect(toPortErrorClass('network')).toBe('network');
  });
});

describe('withRetry', () => {
  const noJitter = () => 1;

  it('retries a throttled call, waits for Retry-After and then succeeds', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let n = 0;
    const result = await withRetry(
      async () => {
        if (++n < 3) throw { message: '429', status: 429, retryAfter: 2 };
        return 'ok';
      },
      { sleep, random: noJitter },
    );
    expect(result).toBe('ok');
    expect(n).toBe(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('uses exponential backoff when no Retry-After is available, capped', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 4) throw new Error('throttled');
        return 1;
      },
      { sleep, random: noJitter, baseDelayMs: 100, maxDelayMs: 250 },
    );
    expect(sleeps).toEqual([100, 200, 250]);
  });

  it('honors an explicit Retry-After longer than the backoff cap (never retries earlier than asked)', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 3) throw { message: '429', status: 429, retryAfter: 120 };
        return 'ok';
      },
      { sleep, random: noJitter }, // default backoff cap is 30 s
    );
    expect(sleeps).toEqual([120_000, 120_000]);
  });

  it('applies the cap to computed backoff only, not to a Retry-After below the waiting budget', async () => {
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 2) throw { message: '429', status: 429, retryAfter: 90 };
        return 1;
      },
      { sleep: async (ms) => void sleeps.push(ms), random: noJitter, maxDelayMs: 1_000 },
    );
    expect(sleeps).toEqual([90_000]);
  });

  it('stops retrying instead of retrying early when Retry-After exceeds the waiting budget', async () => {
    const sleeps: number[] = [];
    const call = vi.fn(async () => {
      throw { message: '429', status: 429, retryAfter: 600 };
    });
    await expect(withRetry(call, { sleep: async (ms) => void sleeps.push(ms) })).rejects.toMatchObject({
      classified: { kind: 'throttled', retryAfterMs: 600_000 },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('lets the caller choose the waiting budget', async () => {
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 2) throw { message: '429', status: 429, retryAfter: 600 };
        return 1;
      },
      { sleep: async (ms) => void sleeps.push(ms), maxRetryAfterMs: 900_000 },
    );
    expect(sleeps).toEqual([600_000]);
  });

  it('does not retry a changed connection', async () => {
    const call = vi.fn(async () => {
      throw new ConnectionChangedError();
    });
    await expect(withRetry(call, { sleep: async () => undefined })).rejects.toMatchObject({ classified: { kind: 'connectionChanged' } });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts with the classified error', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    await expect(withRetry(async () => { throw { message: '429', status: 429 }; }, { sleep, maxAttempts: 3 })).rejects.toMatchObject({
      name: 'HostCallError',
      classified: { kind: 'throttled' },
    });
    expect(sleeps).toHaveLength(2);
  });

  it('does not retry permission, auth, not-found or unknown failures', async () => {
    for (const err of [{ status: 403, message: 'no' }, { status: 401, message: 'no' }, { status: 404, message: 'no' }, new Error('weird')]) {
      const call = vi.fn(async () => { throw err; });
      await expect(withRetry(call, { sleep: async () => undefined })).rejects.toBeInstanceOf(HostCallError);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a network failure only once', async () => {
    const call = vi.fn(async () => { throw new Error('Failed to fetch'); });
    await expect(withRetry(call, { sleep: async () => undefined, random: noJitter })).rejects.toMatchObject({ classified: { kind: 'network' } });
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe('classifyHostError: a bad request that mentions a privilege table is not a permission problem', () => {
  it('a FormatException on privilegeobjecttypecodes is not classified as permission', () => {
    const e = Object.assign(new Error("An exception System.FormatException was thrown while trying to convert input value '[REDACTED]' to attribute 'privilegeobjecttypecodes.objecttypecode'."), { status: 400 });
    expect(classifyHostError(e).kind).not.toBe('permission');
  });
  it('a real missing-privilege message still is', () => {
    expect(classifyHostError(new Error('Principal user (Id=x) is missing prvReadRole privilege (Id=y)')).kind).toBe('permission');
  });
});
