// Server configuration from environment variables (secrets never leave the server).

export interface ServerConfig {
  port: number;
  dbPath: string;
  /** Public base URL of this server (Stripe return URLs). */
  publicUrl: string;
  adminToken: string;
  anthropic: { baseURL: string; apiKey?: string; authToken?: string };
  deepl: { apiKey: string; endpoint?: string };
  stripe: { secretKey: string; webhookSecret: string; prices: { standard: string; pro: string } };
  mail: { resendApiKey?: string; from: string };
  /** Dev/test: keep sent emails in memory (GET /dev/outbox) instead of sending them. */
  devOutbox: boolean;
  /** Reverse proxies in front of the server that append to X-Forwarded-For (Cloud Run: 1). 0 = use the socket address. */
  trustProxyHops: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.DB_PATH ?? 'app.db',
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
    adminToken: env.ADMIN_TOKEN ?? '',
    anthropic: {
      baseURL: (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, ''),
      apiKey: env.ANTHROPIC_API_KEY || undefined,
      authToken: env.ANTHROPIC_AUTH_TOKEN || undefined,
    },
    deepl: { apiKey: env.DEEPL_API_KEY ?? '', endpoint: env.DEEPL_ENDPOINT || undefined },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
      prices: { standard: env.STRIPE_PRICE_STANDARD ?? '', pro: env.STRIPE_PRICE_PRO ?? '' },
    },
    mail: { resendApiKey: env.RESEND_API_KEY || undefined, from: env.MAIL_FROM ?? 'Auto Subtitle Translator <login@example.com>' },
    devOutbox: env.DEV_OUTBOX === '1',
    trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 0),
  };
}
