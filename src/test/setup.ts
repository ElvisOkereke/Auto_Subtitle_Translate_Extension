// Jest setupFilesAfterEnv target — required by jest.config.js's testEnvironment: 'jsdom'.
import { deserialize, serialize } from 'node:v8';

// jsdom hides Node's structuredClone; browsers (and fake-indexeddb) rely on it.
if (typeof globalThis.structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => deserialize(serialize(value));
}

export {};
