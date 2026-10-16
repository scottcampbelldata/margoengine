/** `options` with every value the app left undefined filled from `globalThis.margoPreset[key]` (set by @margoengine/quality). */
export function preset<T extends object>(key: string, options: T): T;
