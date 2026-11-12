import { createApp } from '../app';
import { testDeps } from './helpers';

describe('app', () => {
  it('GET /health returns ok', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
