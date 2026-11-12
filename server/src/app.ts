// The hosted proxy's HTTP API (Hono). createApp takes every dependency so tests
// run it in-process (app.request) with fakes.
import { Hono } from 'hono';
import type { ServerConfig } from './config';
import type { Repo } from './db';

export interface AppDeps {
  config: ServerConfig;
  repo: Repo;
  /** Time source (tests move it). */
  clock?: () => number;
}

export function createApp(deps: AppDeps): Hono {
  void deps;
  const app = new Hono();
  app.get('/health', c => c.json({ ok: true }));
  return app;
}
