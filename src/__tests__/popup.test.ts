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
