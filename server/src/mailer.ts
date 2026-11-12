// Login-code email: Resend's HTTP API in production, an in-memory outbox in
// development and tests (DEV_OUTBOX=1).

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export class OutboxMailer implements Mailer {
  readonly sent: { to: string; subject: string; text: string; at: number }[] = [];

  async send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text, at: Date.now() });
    if (this.sent.length > 200) this.sent.shift();
  }
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Email send failed (${res.status})`);
  }
}
