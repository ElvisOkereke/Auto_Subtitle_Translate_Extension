import { installChromeMock, ChromeMock } from '../test/chromeMock';

let chromeMock: ChromeMock;

function loadContentScript() {
  jest.isolateModules(() => {
    require('../content');
  });
}

const overlay = () => document.getElementById('subtitle-overlay-extension');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('content script subtitle overlay', () => {
  beforeEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
    chromeMock = installChromeMock({ subtitleStyle: 'top', fontSize: 'large' });
    loadContentScript();
  });

  it('starts capture on toggle and reports the tab state', async () => {
    expect(await chromeMock.dispatch({ type: 'GET_SUBTITLE_STATE' })).toEqual({ active: false });

    const response = await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });

    expect(response).toEqual({ active: true });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'START_CAPTURE' });
    expect(overlay()).not.toBeNull();
    expect(await chromeMock.dispatch({ type: 'GET_SUBTITLE_STATE' })).toEqual({ active: true });
  });

  it('reverts and shows the reason when capture fails to start', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ success: false, error: 'nope' });

    const response = await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });

    expect(response).toEqual({ active: false });
    expect(overlay()?.textContent).toContain('Error: nope');
  });

  it('applies the stored position and font size, and follows setting changes', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await flush();
    await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'Bonjour', language: 'fr' });

    expect(overlay()!.style.top).toBe('8%');
    expect(overlay()!.querySelector('.subtitle-text')!.classList.contains('large')).toBe(true);

    chromeMock.storage.onChanged.listeners.forEach(l =>
      l({ subtitleStyle: { newValue: 'bottom' }, fontSize: { newValue: 'small' } }, 'sync')
    );

    expect(overlay()!.style.bottom).toBe('10%');
    expect(overlay()!.style.top).toBe('');
    const line = overlay()!.querySelector('.subtitle-text')!;
    expect(line.classList.contains('small')).toBe(true);
    expect(line.classList.contains('large')).toBe(false);
  });

  it('keeps at most two caption lines and does not wipe status notices', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await chromeMock.dispatch({ type: 'CAPTION_STATUS', message: 'Speech model ready' });
    for (const text of ['one', 'two', 'three']) {
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text, language: 'en' });
    }

    const lines = [...overlay()!.querySelectorAll('.subtitle-text')].map(el => el.textContent);
    expect(lines).toEqual(['two', 'three']);
    expect(overlay()!.querySelector('.subtitle-status')!.textContent).toBe('Speech model ready');
  });

  describe('captions follow the media element', () => {
    function media(paused: boolean, currentTime: number) {
      const el = document.createElement('video');
      Object.defineProperty(el, 'paused', { value: paused, writable: true, configurable: true });
      Object.defineProperty(el, 'currentTime', { value: currentTime, writable: true, configurable: true });
      document.body.appendChild(el);
      return el as HTMLVideoElement & { paused: boolean; currentTime: number };
    }
    const lines = () => [...(overlay()?.querySelectorAll<HTMLElement>('.subtitle-text') ?? [])].map(el => el.textContent);

    it('a caption arriving while the video is paused is not shown', async () => {
      media(true, 30);
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'late', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 500 });
      expect(lines()).toEqual([]);
    });

    it('captions stay for their reading time (video time) and freeze while paused', async () => {
      const v = media(false, 30);
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'Hi', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 200 });
      expect(lines()).toEqual(['Hi']);
      // Paused at 31: however long we wait, video time stays at 31 < 30 + 1.5.
      v.currentTime = 31;
      v.paused = true;
      v.dispatchEvent(new Event('pause'));
      await new Promise(r => setTimeout(r, 400));
      expect(lines()).toEqual(['Hi']);
      // Playing again past its reading time: gone.
      v.paused = false;
      v.currentTime = 31.6;
      v.dispatchEvent(new Event('play'));
      v.dispatchEvent(new Event('timeupdate'));
      await new Promise(r => setTimeout(r, 400));
      expect(lines()).toEqual([]);
    });

    it('a seek clears the captions on screen', async () => {
      const v = media(false, 30);
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'before the seek', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 200 });
      v.currentTime = 90;
      v.dispatchEvent(new Event('seeking'));
      expect(lines()).toEqual([]);
    });

    it('a caption arriving during a YouTube ad is not shown', async () => {
      const player = document.createElement('div');
      player.className = 'html5-video-player ad-showing';
      document.body.appendChild(player);
      const v = media(false, 5);
      player.appendChild(v);
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'during the ad', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 200 });
      expect(lines()).toEqual([]);
    });

    it('with several videos, captions follow the one that is playing', async () => {
      // A large paused video (e.g. a muted preview) and the small one actually playing.
      const big = media(true, 400);
      big.getBoundingClientRect = () => ({ width: 1280, height: 720 }) as DOMRect;
      media(false, 30);
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'from the playing one', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 200 });
      expect(lines()).toEqual(['from the playing one']);
    });
  });

  it('caption lines keep their source text and speech-end time as data attributes', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    const endedAt = Date.now() - 300; // a fresh caption (stale ones are dropped)
    await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'Hello', language: 'en', captionId: 'c1', source: '안녕하세요', speechEndedAt: endedAt });
    const line = overlay()!.querySelector<HTMLElement>('.subtitle-text')!;
    expect(line.dataset.source).toBe('안녕하세요');
    expect(line.dataset.speechEndedAt).toBe(String(endedAt));
  });

  it('an upgrade replaces a displayed caption’s text in place', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'DeepL one', language: 'en', captionId: 'c1' });
    await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'DeepL two', language: 'en', captionId: 'c2' });
    await chromeMock.dispatch({ type: 'UPGRADE_SUBTITLE', captionId: 'c1', text: 'Claude one' });
    const lines = [...overlay()!.querySelectorAll('.subtitle-text')].map(el => el.textContent);
    expect(lines).toEqual(['Claude one', 'DeepL two']);
  });

  it('an upgrade for a caption no longer shown is ignored', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    for (const [text, id] of [['one', 'c1'], ['two', 'c2'], ['three', 'c3']]) {
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text, language: 'en', captionId: id });
    }
    await chromeMock.dispatch({ type: 'UPGRADE_SUBTITLE', captionId: 'c1', text: 'late Claude' });
    const lines = [...overlay()!.querySelectorAll('.subtitle-text')].map(el => el.textContent);
    expect(lines).toEqual(['two', 'three']);
  });

  it('replaces download progress instead of stacking it', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await chromeMock.dispatch({ type: 'CAPTION_STATUS', message: 'Downloading speech model... 10%', replace: true });
    await chromeMock.dispatch({ type: 'CAPTION_STATUS', message: 'Downloading speech model... 55%', replace: true });

    const statuses = [...overlay()!.querySelectorAll('.subtitle-status')].map(el => el.textContent);
    expect(statuses).toEqual(['Downloading speech model... 55%']);
  });

  it('ignores subtitles after captions were turned off', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    expect(chromeMock.runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'STOP_CAPTURE' });
    expect(overlay()).toBeNull();

    await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'late', language: 'en' });
    expect(overlay()).toBeNull();
  });

  it('marks itself inactive when capture is stopped elsewhere', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await chromeMock.dispatch({ type: 'CAPTURE_STOPPED' });
    expect(await chromeMock.dispatch({ type: 'GET_SUBTITLE_STATE' })).toEqual({ active: false });
    expect(overlay()!.textContent).toContain('Captions stopped');
  });

  it('does not observe DOM mutations on the host page', () => {
    const observe = jest.spyOn(MutationObserver.prototype, 'observe');
    loadContentScript();
    expect(observe).not.toHaveBeenCalled();
  });
});
