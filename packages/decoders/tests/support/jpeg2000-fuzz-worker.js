// Runs the fuzz cases from `skip` on, each on its own instance of the shipped Wasm module, and tells the parent which
// one it is about to decode, so that the parent can stop a case that never returns.
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { decodeJPEG2000Module, jpeg2000Settings } from '../../dist/jpeg2000-codec.js';
import { fuzzCases } from './jpeg2000-fuzz.js';

const { mutations, seed, skip, maxPixels } = workerData;
const module = new WebAssembly.Module(readFileSync(new URL('../../dist/jpeg2000.wasm', import.meta.url)));
let at = skip;
for (const { name, bytes, options } of fuzzCases({ mutations, seed, skip })) {
  parentPort.postMessage({ at, name });
  let outcome = 'decoded';
  let failure;
  try {
    const { exports } = new WebAssembly.Instance(module);
    const image = decodeJPEG2000Module(exports, bytes, jpeg2000Settings({ maxPixels, ...options }));
    if (image.data.length !== image.width * image.height * 4) failure = 'the picture has the wrong size';
  } catch (error) {
    outcome = error.code ?? error.name;
    // A trap (a panic, a failed allocation, a stack overflow) arrives as the cause of the decoder's own error.
    const coded = ['failed', 'unsupported'].includes(error.code) || error instanceof RangeError;
    if (!coded || error.cause !== undefined || /invalid result layout/.test(error.message))
      failure = `${error.name}: ${error.message}`;
  }
  parentPort.postMessage({ at, name, outcome, failure, bytes: failure ? bytes.slice() : undefined });
  at++;
}
parentPort.postMessage({ done: true });
