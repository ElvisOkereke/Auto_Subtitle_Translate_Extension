import { ConsecutiveFailures, PromiseCache } from '../sessionCache';

describe('PromiseCache (OCR sessions)', () => {
  it('shares one in-flight load per key', async () => {
    const cache = new PromiseCache<number>();
    const create = jest.fn(async () => 1);
    await Promise.all([cache.get('det', create), cache.get('det', create)]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed load so the next request retries (a network blip must not disable OCR for good)', async () => {
    const cache = new PromiseCache<number>();
    await expect(cache.get('det', () => Promise.reject(new Error('download failed')))).rejects.toThrow('download failed');
    await expect(cache.get('det', async () => 2)).resolves.toBe(2);
  });

  it('clear() drops every cached session', async () => {
    const cache = new PromiseCache<number>();
    await cache.get('det', async () => 1);
    cache.clear();
    await expect(cache.get('det', async () => 3)).resolves.toBe(3);
  });
});

describe('ConsecutiveFailures (GPU run health)', () => {
  it('trips only after the limit of failures in a row', () => {
    const f = new ConsecutiveFailures(3);
    expect(f.failure()).toBe(false);
    expect(f.failure()).toBe(false);
    f.success();
    expect(f.failure()).toBe(false);
    expect(f.failure()).toBe(false);
    expect(f.failure()).toBe(true);
  });
});
