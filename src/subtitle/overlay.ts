// overlay.ts - translated subtitle laid over the user's box (style "C" from the design).
import type { NormalizedBox } from './types';
import { boxToPage, contentRect } from './videoGeometry';

const LINE_HEIGHT = 1.15;
const MAX_LINES = 2;

/**
 * Largest integer font size (px) at which the text fits maxWidth x maxHeight,
 * wrapping onto at most two lines. Binary search; min/max bound the result.
 */
export function fitText(el: HTMLElement, maxWidth: number, maxHeight: number, min = 10, max = 200): number {
  let lo = min;
  let hi = Math.max(min, Math.min(max, Math.floor(maxHeight / LINE_HEIGHT)));
  const fits = (size: number) => {
    el.style.fontSize = `${size}px`;
    return el.scrollWidth <= maxWidth + 0.5 && el.scrollHeight <= Math.min(maxHeight, MAX_LINES * LINE_HEIGHT * size) + 0.5;
  };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  el.style.fontSize = `${lo}px`;
  return lo;
}

export class SubtitleOverlay {
  readonly element: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly onLayoutChange = () => this.position();
  private readonly onFullscreenChange = () => {
    this.attach();
    this.position();
  };

  constructor(private readonly video: HTMLVideoElement, private box: NormalizedBox) {
    this.element = document.createElement('div');
    this.element.className = 'ast-subtitle-overlay';
    this.element.setAttribute('data-ast-owned', '');
    Object.assign(this.element.style, {
      position: 'fixed',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
      background: 'rgba(0, 0, 0, 0.55)',
      pointerEvents: 'none',
      zIndex: '2147483646',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);

    this.text = document.createElement('span');
    this.text.className = 'ast-subtitle-text';
    Object.assign(this.text.style, {
      color: '#ffe066',
      fontWeight: '800',
      textShadow: '0 0 4px #000',
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      lineHeight: String(LINE_HEIGHT),
      textAlign: 'center',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
    } satisfies Partial<CSSStyleDeclaration>);
    this.element.appendChild(this.text);

    this.attach();
    this.resizeObserver = new ResizeObserver(this.onLayoutChange);
    this.resizeObserver.observe(video);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('resize', this.onLayoutChange);
    window.addEventListener('scroll', this.onLayoutChange, true);
  }

  /** Inside the fullscreen element when one is active, so the overlay stays visible. */
  private attach(): void {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.contains(this.video) ? fullscreen : document.body;
    if (this.element.parentElement !== parent) parent.appendChild(this.element);
  }

  private position(): void {
    const page = boxToPage(this.box, this.video.getBoundingClientRect(), contentRect(this.video));
    Object.assign(this.element.style, {
      left: `${page.x}px`,
      top: `${page.y}px`,
      width: `${page.width}px`,
      height: `${page.height}px`,
    });
    if (this.element.style.display !== 'none' && this.text.textContent) {
      this.text.style.maxWidth = `${page.width}px`;
      fitText(this.text, page.width * 0.98, page.height * 0.96);
    }
  }

  show(text: string, meta?: { lineStart: number; quality: 'fast' | 'better' }): void {
    this.text.textContent = text;
    this.element.style.display = 'flex';
    if (meta) {
      this.element.dataset.lineStart = String(meta.lineStart);
      this.element.dataset.quality = meta.quality;
    }
    this.element.dataset.shownAt = String(this.video.currentTime);
    this.attach();
    this.position();
  }

  clear(): void {
    this.text.textContent = '';
    this.element.style.display = 'none';
    delete this.element.dataset.lineStart;
    delete this.element.dataset.quality;
  }

  setBox(box: NormalizedBox): void {
    this.box = box;
    this.position();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('resize', this.onLayoutChange);
    window.removeEventListener('scroll', this.onLayoutChange, true);
    this.element.remove();
  }
}
