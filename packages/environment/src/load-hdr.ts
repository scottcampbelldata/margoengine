// What loadEnvironmentImage imports for a .hdr file: a re-export of dist/hdr.js, so the import() never names a file that
// parseEnvironmentImage (dist/parse-image.js) imports statically. An app that uses both keeps the parser in its main
// chunk, as the synchronous parse needs, and the bundler finds no ineffective dynamic import (KB-ENV-LOADCHUNK2).
export { parseHDR } from './hdr.js';
