// debugPanel.ts - the on-page debug panel (Settings > Debug panel). Shows what
// the extension is doing in this tab, refreshed every second, with the likely
// problems first; "Copy report" copies it all (plus the raw state) as text.
// Lives in a shadow root so the page's CSS can't touch it.
import { buildDebugReport, type DebugReport, type DebugState } from './debugReport';

export type DebugStateSource = () => Promise<DebugState>;

const REFRESH_MS = 1000;

const STYLE = `
:host { all: initial; }
.panel { position: fixed; top: 12px; left: 12px; z-index: 2147483647; width: min(400px, calc(100vw - 24px)); max-height: 70vh;
  display: flex; flex-direction: column; background: rgba(16, 18, 24, 0.94); color: #e8eaef; border: 1px solid #3a4150;
  border-radius: 8px; font: 12px/1.45 'Segoe UI', system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,0.45); }
.bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid #2c323d; }
.bar strong { flex: 1; font-size: 12.5px; }
button { font: inherit; color: #e8eaef; background: #2a303b; border: 1px solid #434b5a; border-radius: 5px; padding: 3px 9px; cursor: pointer; }
button:hover { background: #343b48; }
button:focus-visible { outline: 2px solid #f0c45a; outline-offset: 1px; }
.body { overflow: auto; padding: 8px 10px 10px; display: grid; gap: 10px; }
.problems { display: grid; gap: 4px; }
.problem { background: #3d1c1a; color: #f6b3ae; border-radius: 5px; padding: 5px 8px; }
.ok { color: #8fd8b0; }
h3 { margin: 0 0 3px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: #9aa3b2; font-weight: 600; }
table { border-collapse: collapse; width: 100%; }
td { padding: 2px 0; vertical-align: top; }
td:first-child { color: #9aa3b2; padding-right: 10px; white-space: nowrap; width: 1%; }
td:last-child { word-break: break-word; }
.collapsed .body { display: none; }
.collapsed { width: auto; }
.copied { color: #8fd8b0; }
`;

export class DebugPanel {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private timer: number | null = null;
  private last: { state: DebugState; report: DebugReport } | null = null;
  private collapsed = false;

  /**
   * `inspectable`: an open shadow root, for the test harness (devExposeInternals).
   * Otherwise closed, so the page's own scripts can't read the panel.
   */
  constructor(
    private readonly source: DebugStateSource,
    private readonly inspectable = false
  ) {}

  get element(): HTMLDivElement | null {
    return this.host;
  }

  start(): void {
    if (this.host) return;
    this.host = document.createElement('div');
    this.host.id = 'ast-debug-panel';
    this.host.setAttribute('data-ast-owned', '');
    this.root = this.host.attachShadow({ mode: this.inspectable ? 'open' : 'closed' });
    this.root.innerHTML = `<style>${STYLE}</style><div class="panel" role="region" aria-label="Subtitle Translator debug panel">
      <div class="bar"><strong>Subtitle Translator: debug</strong>
      <button type="button" data-act="copy">Copy report</button><button type="button" data-act="collapse">Hide</button></div>
      <div class="body"><div>Collecting…</div></div></div>`;
    this.root.addEventListener('click', e => this.onClick(e));
    (document.body ?? document.documentElement).appendChild(this.host);
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  /** The whole report as text (problems, sections, then the raw state). */
  reportText(): string {
    if (!this.last) return 'No data yet.';
    const { state, report } = this.last;
    const lines = [`Subtitle Translator debug report, ${new Date(state.at).toISOString()}`, ''];
    lines.push(report.problems.length ? 'Problems:' : 'Problems: none found');
    for (const p of report.problems) lines.push(`  - ${p}`);
    for (const s of report.sections) {
      lines.push('', `${s.title}:`);
      for (const [k, v] of s.rows) lines.push(`  ${k}: ${v}`);
    }
    lines.push('', 'Raw state:', JSON.stringify(state, null, 1));
    return lines.join('\n');
  }

  private async onClick(e: Event): Promise<void> {
    const button = (e.target as HTMLElement).closest('button');
    if (!button) return;
    if (button.dataset.act === 'collapse') {
      this.collapsed = !this.collapsed;
      this.root?.querySelector('.panel')?.classList.toggle('collapsed', this.collapsed);
      button.textContent = this.collapsed ? 'Show' : 'Hide';
    } else if (button.dataset.act === 'copy') {
      const text = this.reportText();
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        // Clipboard refused (page focus or permissions): show the text so it can be selected and copied.
        const area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'width:100%;height:160px;font:11px monospace;background:#0e1015;color:#e8eaef;';
        this.root?.querySelector('.body')?.prepend(area);
        area.select();
        button.textContent = 'Select and copy';
      }
      window.setTimeout(() => (button.textContent = 'Copy report'), 2500);
    }
  }

  private async refresh(): Promise<void> {
    let state: DebugState;
    try {
      state = await this.source();
    } catch (error) {
      this.render(null, `Could not collect the state: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const report = buildDebugReport(state);
    this.last = { state, report };
    this.render(report);
  }

  private render(report: DebugReport | null, failure?: string): void {
    const body = this.root?.querySelector('.body');
    if (!body) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    if (!report) {
      body.innerHTML = `<div class="problem">${esc(failure ?? 'No data')}</div>`;
      return;
    }
    const problems = report.problems.length
      ? `<div class="problems">${report.problems.map(p => `<div class="problem">${esc(p)}</div>`).join('')}</div>`
      : '<div class="ok">No problems found.</div>';
    const sections = report.sections
      .map(s => `<section><h3>${esc(s.title)}</h3><table>${s.rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></section>`)
      .join('');
    const keep = body.querySelector('textarea');
    body.innerHTML = problems + sections;
    if (keep) body.prepend(keep);
  }
}
