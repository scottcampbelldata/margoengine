/** Phones use single-sampled scenes without transient MSAA buffers. */
export function sceneSamples():1|4{return /Mobi|Android/.test(globalThis.navigator?.userAgent)?1:4;}
