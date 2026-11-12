import fs from 'fs';
import path from 'path';
import { installChromeMock } from '../test/chromeMock';
import { describeTabError, getTargetTab } from '../popup';

describe('popup helpers', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('targets the active tab by default', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 7 }]);
    await expect(getTargetTab()).resolves.toEqual({ id: 7 });
    expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it('honours a pinned ?tabId=', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.get.mockResolvedValue({ id: 42 });
    window.history.replaceState(null, '', '/popup.html?tabId=42');
    await expect(getTargetTab()).resolves.toEqual({ id: 42 });
    expect(chromeMock.tabs.get).toHaveBeenCalledWith(42);
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
  });

  it('ignores a malformed ?tabId=', async () => {
    const chromeMock = installChromeMock();
    chromeMock.tabs.query.mockResolvedValue([{ id: 3 }]);
    window.history.replaceState(null, '', '/popup.html?tabId=abc');
    await expect(getTargetTab()).resolves.toEqual({ id: 3 });
  });

  it('explains a missing content script in plain words', () => {
    const message = describeTabError(new Error('Could not establish connection. Receiving end does not exist.'));
    expect(message).toMatch(/can't run the extension/);
    expect(describeTabError(new Error('other'))).toBe('other');
  });
});

describe('popup modes', () => {
  async function loadPopup(syncData: Record<string, unknown> = {}) {
    const html = fs.readFileSync(path.join(__dirname, '../../popup.html'), 'utf8');
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
    const chromeMock = installChromeMock(syncData);
    chromeMock.tabs.query.mockResolvedValue([{ id: 1 }]);
    chromeMock.tabs.sendMessage.mockImplementation(async (_id: number, msg: any) => {
      if (msg.type === 'GET_SUBTITLE_MODE_STATE') return { mode: 'off', state: 'stopped', videoId: 'v1', hasBox: false };
      if (msg.type === 'GET_SCREEN_TRANSLATE_STATE') return { state: 'inactive' };
      if (msg.type === 'GET_SUBTITLE_STATE') return { active: false };
      return { success: true };
    });
    jest.isolateModules(() => require('../popup'));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise(r => setTimeout(r, 20));
    return chromeMock;
  }

  const hidden = (id: string) => document.getElementById(id)!.classList.contains('hidden');

  it('shows the audio panel by default and the subtitle panel after choosing Subtitles', async () => {
    await loadPopup();
    expect(hidden('audioPanel')).toBe(false);
    expect(hidden('subtitlePanel')).toBe(true);
    document.getElementById('modeSubtitles')!.click();
    expect(hidden('audioPanel')).toBe(true);
    expect(hidden('subtitlePanel')).toBe(false);
    // Screen Translate (page text) stays available in both modes.
    expect(hidden('screenTranslateButton')).toBe(false);
  });

  it('offers the nine subtitle languages, Korean by default, and persists the choice', async () => {
    const chromeMock = await loadPopup();
    const select = document.getElementById('subtitleLanguage') as HTMLSelectElement;
    expect([...select.options].map(o => o.value)).toEqual(['ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'pt', 'ru']);
    expect(select.value).toBe('ko');
    select.value = 'ja';
    select.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 10));
    const saved = chromeMock.runtime.sendMessage.mock.calls.map((c: any[]) => c[0]).find((m: any) => m.type === 'UPDATE_SETTINGS');
    expect(saved.settings.subtitleLanguage).toBe('ja');
  });

  it('sends DRAW_SUBTITLE_BOX to the tab with the chosen language', async () => {
    const chromeMock = await loadPopup({ subtitleLanguage: 'ko' });
    document.getElementById('modeSubtitles')!.click();
    document.getElementById('drawSubtitleBox')!.click();
    await new Promise(r => setTimeout(r, 10));
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'DRAW_SUBTITLE_BOX', lang: 'ko' });
  });
});

describe('popup translation engine settings', () => {
  async function loadPopup(syncData: Record<string, unknown> = {}, localData: Record<string, unknown> = {}) {
    const html = fs.readFileSync(path.join(__dirname, '../../popup.html'), 'utf8');
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
    const chromeMock = installChromeMock(syncData);
    (chromeMock as any).storage.local.get = jest.fn(async () => localData);
    chromeMock.tabs.query.mockResolvedValue([{ id: 1 }]);
    chromeMock.tabs.sendMessage.mockImplementation(async (_id: number, msg: any) => {
      if (msg.type === 'GET_SUBTITLE_MODE_STATE') return { mode: 'off', state: 'stopped', videoId: 'v1', hasBox: false };
      if (msg.type === 'GET_SCREEN_TRANSLATE_STATE') return { state: 'inactive' };
      if (msg.type === 'GET_SUBTITLE_STATE') return { active: false };
      return { success: true };
    });
    jest.isolateModules(() => require('../popup'));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise(r => setTimeout(r, 20));
    return chromeMock;
  }
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const savedSettings = (chromeMock: any) =>
    chromeMock.runtime.sendMessage.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.type === 'UPDATE_SETTINGS').map((m: any) => m.settings);

  it('offers the three engine modes and three Claude models', async () => {
    await loadPopup();
    expect([...el<HTMLSelectElement>('engineMode').options].map(o => o.value)).toEqual(['fast-then-best', 'fast', 'best']);
    expect([...el<HTMLSelectElement>('claudeModel').options].map(o => o.value)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('shows the key field for direct access and the gateway fields for a gateway', async () => {
    await loadPopup();
    const hidden = (id: string) => el(id).classList.contains('hidden');
    expect(hidden('anthropicKeyGroup')).toBe(false);
    expect(hidden('claudeGatewayGroup')).toBe(true);
    el<HTMLSelectElement>('claudeAccess').value = 'gateway';
    el('claudeAccess').dispatchEvent(new Event('change'));
    expect(hidden('anthropicKeyGroup')).toBe(true);
    expect(hidden('claudeGatewayGroup')).toBe(false);
  });

  it('rejects an http gateway URL that is not loopback with a visible message', async () => {
    const chromeMock = await loadPopup({ claudeAccess: 'gateway' });
    el<HTMLInputElement>('claudeGatewayUrl').value = 'http://gateway.example.com';
    el('claudeGatewayUrl').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 10));
    expect(el('claudeStatus').textContent).toMatch(/https/i);
    expect(savedSettings(chromeMock).some((s: any) => s.claudeGatewayUrl === 'http://gateway.example.com')).toBe(false);

    el<HTMLInputElement>('claudeGatewayUrl').value = 'https://gateway.example.com/anthropic';
    el('claudeGatewayUrl').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 10));
    expect(el('claudeStatus').textContent).toBe('');
    expect(savedSettings(chromeMock).at(-1).claudeGatewayUrl).toBe('https://gateway.example.com/anthropic');
  });

  it('marks Claude modes as needing Claude access until a key is set', async () => {
    await loadPopup();
    const label = (v: string) => [...el<HTMLSelectElement>('engineMode').options].find(o => o.value === v)!.textContent!;
    expect(label('best')).toMatch(/needs Claude access/);
    el<HTMLInputElement>('anthropicApiKey').value = 'sk-ant';
    el('anthropicApiKey').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 10));
    expect(label('best')).not.toMatch(/needs Claude access/);
  });
});

