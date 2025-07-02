// Jest setup file for testing environment

// Mock chrome API for testing
declare global {
  namespace chrome {
    namespace runtime {
      const sendMessage: jest.MockedFunction<typeof chrome.runtime.sendMessage>;
      const onMessage: {
        addListener: jest.MockedFunction<any>;
      };
      const onInstalled: {
        addListener: jest.MockedFunction<any>;
      };
      const getURL: jest.MockedFunction<typeof chrome.runtime.getURL>;
    }
    namespace storage {
      namespace sync {
        const get: jest.MockedFunction<typeof chrome.storage.sync.get>;
        const set: jest.MockedFunction<typeof chrome.storage.sync.set>;
      }
    }
    namespace tabs {
      const query: jest.MockedFunction<typeof chrome.tabs.query>;
      const sendMessage: jest.MockedFunction<typeof chrome.tabs.sendMessage>;
      const create: jest.MockedFunction<typeof chrome.tabs.create>;
      const onUpdated: {
        addListener: jest.MockedFunction<any>;
      };
      const onRemoved: {
        addListener: jest.MockedFunction<any>;
      };
    }
    namespace tabCapture {
      const capture: jest.MockedFunction<typeof chrome.tabCapture.capture>;
    }
    namespace permissions {
      const contains: jest.MockedFunction<typeof chrome.permissions.contains>;
    }
  }
}

// Create mock chrome object
const mockChrome = {
  runtime: {
    sendMessage: jest.fn(),
    onMessage: {
      addListener: jest.fn()
    },
    onInstalled: {
      addListener: jest.fn()
    },
    getURL: jest.fn(),
    lastError: null
  },
  storage: {
    sync: {
      get: jest.fn(),
      set: jest.fn()
    }
  },
  tabs: {
    query: jest.fn(),
    sendMessage: jest.fn(),
    create: jest.fn(),
    onUpdated: {
      addListener: jest.fn()
    },
    onRemoved: {
      addListener: jest.fn()
    }
  },
  tabCapture: {
    capture: jest.fn()
  },
  permissions: {
    contains: jest.fn()
  }
};

// Assign to global
(global as any).chrome = mockChrome;

// Mock Audio Context
(global as any).AudioContext = jest.fn().mockImplementation(() => ({
  close: jest.fn(),
  createAnalyser: jest.fn(),
  createGain: jest.fn(),
  createScriptProcessor: jest.fn()
}));

(global as any).webkitAudioContext = (global as any).AudioContext;

// Mock MediaRecorder
(global as any).MediaRecorder = jest.fn().mockImplementation(() => ({
  start: jest.fn(),
  stop: jest.fn(),
  pause: jest.fn(),
  resume: jest.fn(),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn()
}));

// Mock fetch
(global as any).fetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
});
