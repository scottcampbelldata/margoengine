declare global {
  var margoLow: number | undefined;
}
/**
 * MSAA samples of the scene passes. Phones, and the desktop light tier (`margoLow`, its maximum pixel ratio), use
 * single-sampled scenes without transient MSAA buffers. Pass the engine so one created with `exactSize` gets 1.
 */
export function sceneSamples(engine?: { exact?: 1 }): 1 | 4 {
  return engine?.exact || (globalThis.margoLow || /Mobi|Android/.test(globalThis.navigator?.userAgent) ? 1 : 4);
}
