// Production entry: node server/dist/main.js (environment: see server/README.md).
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { Repo } from './db';

const config = loadConfig(process.env);
if (process.env.TRUST_PROXY_HOPS === undefined) {
  console.warn('TRUST_PROXY_HOPS is not set: client IPs come from the socket. Behind Cloud Run or a load balancer set it to 1, or all users share one rate-limit bucket.');
}
const repo = new Repo(config.dbPath);
const app = createApp({ config, repo });
serve({ fetch: app.fetch, port: config.port }, info => console.log(`proxy listening on :${info.port}`));
