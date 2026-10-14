declare global {var margoLow:number|undefined;}
/** Phones, and the desktop light tier (`margoLow`, its maximum pixel ratio), use single-sampled scenes without transient MSAA buffers. */
export function sceneSamples():1|4{return globalThis.margoLow||/Mobi|Android/.test(globalThis.navigator?.userAgent)?1:4;}
