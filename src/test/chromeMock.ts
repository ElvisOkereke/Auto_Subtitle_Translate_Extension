// Minimal in-memory chrome.* mock for jsdom unit tests.

type Listener = (...args: any[]) => any;

export interface ChromeMock {
  runtime: {
    onMessage: { addListener: jest.Mock; listeners: Listener[] };
    sendMessage: jest.Mock;
  };
  storage: {
    sync: { get: jest.Mock; set: jest.Mock; data: Record<string, unknown> };
    local: { get: jest.Mock; set: jest.Mock; data: Record<string, unknown> };
    onChanged: { addListener: jest.Mock; listeners: Listener[] };
  };
  tabs: { query: jest.Mock; get: jest.Mock; sendMessage: jest.Mock };
  /** Deliver a runtime message to every registered listener; resolves with the first sendResponse value. */
  dispatch: (message: unknown) => Promise<unknown>;
}

function area(data: Record<string, unknown>) {
  return {
    data,
    get: jest.fn(async (keys?: string | string[] | Record<string, unknown>) => {
      if (keys === undefined) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? data[k] : d]));
    }),
    set: jest.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
  };
}

export function installChromeMock(syncData: Record<string, unknown> = {}): ChromeMock {
  const messageListeners: Listener[] = [];
  const changeListeners: Listener[] = [];
  const mock: ChromeMock = {
    runtime: {
      onMessage: { addListener: jest.fn((l: Listener) => messageListeners.push(l)), listeners: messageListeners },
      sendMessage: jest.fn(async () => ({ success: true })),
    },
    storage: {
      sync: area({ ...syncData }),
      local: area({}),
      onChanged: { addListener: jest.fn((l: Listener) => changeListeners.push(l)), listeners: changeListeners },
    },
    tabs: { query: jest.fn(async () => []), get: jest.fn(), sendMessage: jest.fn() },
    dispatch: message =>
      new Promise(resolve => {
        let responded = false;
        const sendResponse = (value: unknown) => {
          if (!responded) {
            responded = true;
            resolve(value);
          }
        };
        const keepOpen = messageListeners.map(l => l(message, {}, sendResponse)).some(r => r === true);
        if (!keepOpen) setTimeout(() => sendResponse(undefined), 0);
      }),
  };
  (globalThis as any).chrome = mock;
  return mock;
}
