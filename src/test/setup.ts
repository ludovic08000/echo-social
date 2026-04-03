import "@testing-library/jest-dom";

// Mock indexedDB for crypto modules
if (typeof globalThis.indexedDB === 'undefined') {
  const mockIDB = {
    open: () => {
      const req = {
        result: null,
        error: null,
        onsuccess: null as any,
        onerror: null as any,
        onupgradeneeded: null as any,
      };
      setTimeout(() => req.onerror?.({ target: req }), 0);
      return req;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { value: mockIDB, writable: true });
}

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
