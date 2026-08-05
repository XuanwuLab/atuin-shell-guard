// Accelerate only the direct hook's fixed 60-second deadline in integration tests.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  realSetTimeout(callback, delay === 60000 ? 1000 : delay, ...args);
