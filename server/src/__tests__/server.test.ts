import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server';
import { loadConfig } from '../config';
import { Repo } from '../db';

describe('server lifecycle', () => {
  it('stop() closes the HTTP server and the database cleanly; data survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-life-'));
    const dbPath = path.join(dir, 'app.db');
    const config = { ...loadConfig({ DEV_OUTBOX: '1', TRUST_PROXY_HOPS: '0' }), port: 0, dbPath };
    const running = await startServer(config);
    const res = await fetch(`http://127.0.0.1:${running.port}/v1/auth/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) });
    expect(res.status).toBe(200);
    await running.stop();
    await expect(fetch(`http://127.0.0.1:${running.port}/health`)).rejects.toBeTruthy();
    const reopened = new Repo(dbPath);
    expect(reopened.latestCode('a@example.com')).not.toBeNull();
    reopened.close();
  });
});
