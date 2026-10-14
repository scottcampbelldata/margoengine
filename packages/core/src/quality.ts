declare global {var margoLow:unknown;}
/** Phones, and desktops measured too slow (`margoLow`), use single-sampled scenes without transient MSAA buffers. */
export function sceneSamples():1|4{return globalThis.margoLow||/Mobi|Android/.test(globalThis.navigator?.userAgent)?1:4;}
