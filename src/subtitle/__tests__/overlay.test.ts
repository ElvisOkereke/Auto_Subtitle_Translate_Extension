import { SubtitleOverlay } from '../overlay';

function fakeVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperty(video, 'videoWidth', { value: 1920 });
  Object.defineProperty(video, 'videoHeight', { value: 1080 });
  Object.defineProperty(video, 'currentTime', { value: 12.5, writable: true });
  document.body.appendChild(video);
  return video;
}

// jsdom lacks ResizeObserver.
beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

describe('SubtitleOverlay', () => {
  const box = { x: 0.2, y: 0.75, w: 0.6, h: 0.14 };

  afterEach(() => (document.body.innerHTML = ''));

  it('renders style C: see-through tint and contrasting bold text', () => {
    const overlay = new SubtitleOverlay(fakeVideo(), box);
    overlay.show('It could be top Camille though');
    const el = overlay.element;
    expect(el.classList.contains('ast-subtitle-overlay')).toBe(true);
    expect(el.hasAttribute('data-ast-owned')).toBe(true);
    expect(el.style.background).toBe('rgba(0, 0, 0, 0.55)');
    expect(el.style.pointerEvents).toBe('none');
    const text = el.querySelector<HTMLElement>('.ast-subtitle-text')!;
    expect(text.textContent).toBe('It could be top Camille though');
    expect(text.style.color).toBe('rgb(255, 224, 102)');
    expect(text.style.fontWeight).toBe('800');
    expect(text.style.textShadow).toContain('4px');
  });

  it('is hidden until shown and after clear()', () => {
    const overlay = new SubtitleOverlay(fakeVideo(), box);
    expect(overlay.element.style.display).toBe('none');
    overlay.show('hello');
    expect(overlay.element.style.display).not.toBe('none');
    overlay.clear();
    expect(overlay.element.style.display).toBe('none');
    expect(overlay.element.textContent).toBe('');
  });

  it('records line start, quality and the video time it was shown at', () => {
    const overlay = new SubtitleOverlay(fakeVideo(), box);
    overlay.show('hello', { lineStart: 11.9, quality: 'fast' });
    expect(overlay.element.dataset.lineStart).toBe('11.9');
    expect(overlay.element.dataset.quality).toBe('fast');
    expect(overlay.element.dataset.shownAt).toBe('12.5');
  });

  it('removes itself on destroy()', () => {
    const overlay = new SubtitleOverlay(fakeVideo(), box);
    overlay.show('hello');
    overlay.destroy();
    expect(document.querySelector('.ast-subtitle-overlay')).toBeNull();
  });
});
