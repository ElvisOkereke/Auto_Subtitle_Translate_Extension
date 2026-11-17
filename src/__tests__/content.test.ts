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
      expect(JSON.parse(overlay()!.dataset.dropped!)).toEqual({ paused: 1 });
    });

    it('the newest caption holds (video time) and freezes while paused', async () => {
      const v = media(false, 30);
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'Hi', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 200 });
      expect(lines()).toEqual(['Hi']);
      // Paused at 31: however long we wait, video time stays at 31.
      v.currentTime = 31;
      v.paused = true;
      v.dispatchEvent(new Event('pause'));
      await new Promise(r => setTimeout(r, 400));
      expect(lines()).toEqual(['Hi']);
      // Playing again past its reading time: as the newest line it still holds...
      v.paused = false;
      v.currentTime = 31.6;
      v.dispatchEvent(new Event('play'));
      v.dispatchEvent(new Event('timeupdate'));
      await new Promise(r => setTimeout(r, 400));
      expect(lines()).toEqual(['Hi']);
      // ...until 7 s of video after it appeared.
      v.currentTime = 37.1;
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

    it('when another video starts, captions follow it from a clean slate', async () => {
      const a = media(false, 600);
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'from video A', language: 'en', captionId: 'a1', speechEndedAt: Date.now() - 200 });
      expect(lines()).toEqual(['from video A']);
      a.paused = true;
      a.dispatchEvent(new Event('pause'));
      const b = media(false, 10);
      b.dispatchEvent(new Event('play', { bubbles: false }));
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'from video B', language: 'en', captionId: 'b1', speechEndedAt: Date.now() - 200 });
      expect(lines()).toEqual(['from video B']);
    });

    it('a muted video that plays (a hover preview, a background loop) is not followed', async () => {
      media(false, 30); // the one with the sound
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      const preview = media(false, 2);
      preview.muted = true;
      preview.dispatchEvent(new Event('play'));
      preview.paused = true; // the preview stops; the real video keeps playing
      preview.dispatchEvent(new Event('pause'));
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'still captioned', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 200 });
      expect(lines()).toEqual(['still captioned']);
    });

    it('captions sit on the video, not at the bottom of the window (YouTube default layout)', async () => {
      const v = media(false, 10);
      v.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 450, right: 900, bottom: 500, x: 100, y: 50 }) as DOMRect;
      Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await new Promise(r => setTimeout(r, 150));
      const style = overlay()!.style;
      expect(style.left).toBe('500px'); // the video's centre
      expect(style.top).toBe('86px'); // the suite's setting is "top": 8% of the video's height below its top edge (50 + 36)
      expect(style.maxWidth).toBe('640px'); // 80% of the video's width
    });

    describe('read-ahead captions (shown by video time)', () => {
      const raLines = () => [...(overlay()?.querySelectorAll<HTMLElement>('.subtitle-text[data-video-start]') ?? [])].map(el => el.textContent);
      const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
      const bufferedTo = (v: HTMLVideoElement, end: number) =>
        Object.defineProperty(v, 'buffered', { value: { length: 1, start: () => 0, end: () => end }, configurable: true });

      it('a caption made ahead appears when the video reaches its start, not when it arrives', async () => {
        const v = media(false, 5);
        await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
        await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'ahead of time', language: 'en', captionId: 'r1', videoStart: 6, videoEnd: 7.5 });
        await wait(150);
        expect(raLines()).toEqual([]);
        v.currentTime = 6.05;
        await wait(150);
        expect(raLines()).toEqual(['ahead of time']);
        v.currentTime = 7.9;
        await wait(150);
        expect(raLines()).toEqual([]);
      });

      it('a caption on screen is inserted once and then left alone (re-inserting restarts its fade: flicker)', async () => {
        const v = media(false, 7.1);
        await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
        await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'steady', language: 'en', captionId: 'r1', videoStart: 6, videoEnd: 9 });
        await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'steady too', language: 'en', captionId: 'r2', videoStart: 7, videoEnd: 9 });
        await wait(150);
        expect(raLines()).toEqual(['steady', 'steady too']);
        const container = overlay()!.querySelector('.subtitle-captions')!;
        const mutations: MutationRecord[] = [];
        const observer = new MutationObserver(m => mutations.push(...m));
        observer.observe(container, { childList: true });
        v.currentTime = 7.6;
        await wait(450); // several ticks
        observer.disconnect();
        expect(mutations).toEqual([]);
      });

      it('after a seek back, a caption made earlier shows again', async () => {
        const v = media(false, 6.2);
        await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
        await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'once more', language: 'en', captionId: 'r1', videoStart: 6, videoEnd: 7.5 });
        await wait(150);
        expect(raLines()).toEqual(['once more']);
        v.currentTime = 60;
        v.dispatchEvent(new Event('seeking'));
        await wait(150);
        expect(raLines()).toEqual([]);
        v.currentTime = 6.5;
        v.dispatchEvent(new Event('seeking'));
        await wait(150);
        expect(raLines()).toEqual(['once more']);
      });

      it('a Claude upgrade before the start is the text that appears', async () => {
        const v = media(false, 5);
        await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
        await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'fast', language: 'en', captionId: 'r1', videoStart: 6, videoEnd: 7.5 });
        await chromeMock.dispatch({ type: 'UPGRADE_SUBTITLE', captionId: 'r1', text: 'better' });
        v.currentTime = 6.1;
        await wait(150);
        expect(raLines()).toEqual(['better']);
      });

      it('healthy read-ahead: audio goes to the pipeline, the overlay says read-ahead, live captions are not shown', async () => {
        const v = media(false, 10);
        bufferedTo(v, 60);
        await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
        for (const t of [10, 11, 12]) {
          window.dispatchEvent(new MessageEvent('message', { data: { astAudio: true, t, pcm: new Float32Array(16000) }, source: window }));
        }
        await wait(300);
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'READ_AHEAD_AUDIO', t: 10 }));
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'READ_AHEAD_STATE', healthy: true }));
        expect(overlay()!.dataset.path).toBe('read-ahead');
        await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'live duplicate', language: 'en', captionId: 'l1', speechEndedAt: Date.now() - 200 });
        expect(lines()).toEqual([]);
      });

      it('a seek outside the audio read ahead forgets it and tells the pipeline to start over', async () => {
        const v = media(false, 10);
        bufferedTo(v, 60);
        await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
        for (const t of [10, 11, 12]) {
          window.dispatchEvent(new MessageEvent('message', { data: { astAudio: true, t, pcm: new Float32Array(16000) }, source: window }));
        }
        await wait(50);
        v.currentTime = 80;
        v.dispatchEvent(new Event('seeking'));
        await wait(50);
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'READ_AHEAD_RESET' }));
      });

      it('a live caption for speech a read-ahead caption already covers is not shown twice', async () => {
        media(false, 20);
        await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
        await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'read ahead', language: 'en', captionId: 'r1', videoStart: 19, videoEnd: 21.5 });
        await wait(300);
        await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'live copy', language: 'en', captionId: 'l1', speechEndedAt: Date.now() - 100 });
        expect(lines()).toEqual(['read ahead']);
      });
    });

    it('a new source on the followed video (next item, no seek) clears the screen', async () => {
      const v = media(false, 300);
      await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
      await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'previous video', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 200 });
      v.currentTime = 0;
      v.dispatchEvent(new Event('emptied'));
      expect(lines()).toEqual([]);
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

  it('debug panel: appears when switched on, shows the audio pipeline and the problems first', async () => {
    document.body.innerHTML = '';
    chromeMock = installChromeMock({});
    await chromeMock.storage.local.set({ debugPanel: true, devExposeInternals: true }); // open root, so the test can read it
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: any) => {
      if (msg.type === 'GET_DEBUG_STATE') {
        return {
          captureTabId: 1,
          thisTabId: 1,
          offscreenOpen: true,
          settings: { translationEngineMode: 'fast', translationProvider: 'deepl', claudeAccess: 'key', claudeModel: 'claude-opus-5-5', speechModel: 'turbo', sourceLanguage: 'ko', targetLanguage: 'en', keys: { deepl: false, google: false, anthropic: false, gateway: false, account: false } },
          audioDiag: { frames: 10, peakRms: 0.05, results: 2, model: 'onnx-community/whisper-base (wasm)' },
          model: { status: 'ready' },
          gpu: false,
          transcripts: [],
          events: [],
        };
      }
      return { success: true };
    });
    loadContentScript();
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await new Promise(r => setTimeout(r, 1200));
    const panel = document.getElementById('ast-debug-panel')!;
    expect(panel).not.toBeNull();
    const text = panel.shadowRoot!.textContent!;
    expect(text).toContain('No WebGPU');
    expect(text).toContain('No deepl key');
    expect(text).toContain('Audio mode');
    expect(text).toContain('onnx-community/whisper-base (wasm)');
    await chromeMock.storage.local.set({ debugPanel: false });
    for (const l of (chromeMock.storage as any).onChanged.listeners) l({ debugPanel: { newValue: false } }, 'local');
    expect(document.getElementById('ast-debug-panel')).toBeNull();
  });

  it('debug panel: the page cannot read it (closed shadow root) outside the test harness', async () => {
    document.body.innerHTML = '';
    chromeMock = installChromeMock({});
    await chromeMock.storage.local.set({ debugPanel: true });
    loadContentScript();
    await new Promise(r => setTimeout(r, 50));
    const panel = document.getElementById('ast-debug-panel')!;
    expect(panel).not.toBeNull();
    expect(panel.shadowRoot).toBeNull();
  });

  it('marks itself inactive when capture is stopped elsewhere', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await chromeMock.dispatch({ type: 'CAPTURE_STOPPED' });
    expect(await chromeMock.dispatch({ type: 'GET_SUBTITLE_STATE' })).toEqual({ active: false });
    expect(overlay()!.textContent).toContain('Captions stopped');
  });

  it('removes its caption lines when capture is stopped elsewhere', async () => {
    await chromeMock.dispatch({ type: 'TOGGLE_SUBTITLES' });
    await chromeMock.dispatch({ type: 'DISPLAY_SUBTITLE', text: 'last words', language: 'en', captionId: 'c1', speechEndedAt: Date.now() - 200 });
    expect(overlay()!.querySelectorAll('.subtitle-text').length).toBe(1);
    await chromeMock.dispatch({ type: 'CAPTURE_STOPPED' });
    expect(overlay()!.querySelectorAll('.subtitle-text').length).toBe(0);
  });

  it('does not observe DOM mutations on the host page', () => {
    const observe = jest.spyOn(MutationObserver.prototype, 'observe');
    loadContentScript();
    expect(observe).not.toHaveBeenCalled();
  });
});
