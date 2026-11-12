// Starts and stops the HTTP server with its database (graceful shutdown closes
// the SQLite connection so the WAL is checkpointed and nothing is lost).
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import type { ServerConfig } from './config';
import { Repo } from './db';

export interface RunningServer {
  port: number;
  stop(): Promise<void>;
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const repo = new Repo(config.dbPath);
  const app = createApp({ config, repo });
  const server = serve({ fetch: app.fetch, port: config.port });
  await new Promise<void>(resolve => (server.listening ? resolve() : server.once('listening', () => resolve())));
  const { port } = server.address() as AddressInfo;
  let stopped = false;
  return {
    port,
    stop: () =>
      new Promise<void>(resolve => {
        if (stopped) return resolve();
        stopped = true;
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => {
          repo.close();
          resolve();
        });
      }),
  };
}
