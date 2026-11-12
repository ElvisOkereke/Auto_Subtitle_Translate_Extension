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
