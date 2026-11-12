// Production entry: node server/dist/main.js (environment: see server/README.md).
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { Repo } from './db';

const config = loadConfig(process.env);
const repo = new Repo(config.dbPath);
const app = createApp({ config, repo });
serve({ fetch: app.fetch, port: config.port }, info => console.log(`proxy listening on :${info.port}`));
