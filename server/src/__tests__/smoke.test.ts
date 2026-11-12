import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const MAIN = path.join(ROOT, 'server/dist/main.js');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

describe('built server', () => {
  it('smoke: the built server starts and answers /health', async () => {
    expect(fs.existsSync(MAIN)).toBe(true); // npm run server:build
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-proxy-'));
    const child = spawn(process.execPath, [MAIN], {
      env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'app.db'), DEV_OUTBOX: '1', TRUST_PROXY_HOPS: '0' },
      stdio: 'pipe',
    });
    try {
      let body: unknown = null;
      for (let i = 0; i < 50 && body === null; i++) {
        await new Promise(r => setTimeout(r, 100));
        body = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json(), () => null);
      }
      expect(body).toEqual({ ok: true });
    } finally {
      child.kill();
    }
  }, 20_000);
});
