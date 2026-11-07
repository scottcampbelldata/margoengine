// The KTX2 readers `decodeImage` needs, in one module it can load on demand: they are imported statically elsewhere in
// this package, so an import() of each would split nothing (tests/dist-dynamic-imports.test.js).
export { KTX2Decoder } from './ktx2.js';
export { parseKTX2 } from './ktx2-layers.js';
