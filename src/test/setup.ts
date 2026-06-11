import "@testing-library/jest-dom";

// Real in-memory IndexedDB implementation for crypto modules that need
// to persist sessions across calls (deviceRatchet, accountKeyBackup, …).
// Falls back gracefully if a test never touches IndexedDB.
import 'fake-indexeddb/auto';

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
