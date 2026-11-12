// Production entry: node server/dist/main.js (environment: see server/README.md).
import { loadConfig } from './config';
import { startServer } from './server';

const config = loadConfig(process.env);
if (process.env.TRUST_PROXY_HOPS === undefined) {
  console.warn('TRUST_PROXY_HOPS is not set: client IPs come from the socket. Behind Caddy or a load balancer set it (1 per proxy), or all users share one rate-limit bucket.');
}

startServer(config).then(running => {
  console.log(`proxy listening on :${running.port}`);
  // Graceful shutdown (docker stop / systemd): close connections and the database.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      running.stop().then(() => process.exit(0));
    });
  }
});
