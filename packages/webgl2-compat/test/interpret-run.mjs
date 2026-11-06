// Run by interpret.test.js twice, with and without `--disallow-code-generation-from-strings`: every compute entry point
// of the corpus that binds only buffers runs on the same seeded memory, and one line of JSON gives a digest of the
// memory (or the error) each leaves. With the flag `new Function` throws, so the interpreter runs them.
import { createHash } from 'node:crypto';
import { loadInterpreter, runComputeOnCPU } from '../dist/compute.js';
import { checkWGSL } from '../dist/wgsl.js';
import { readCorpus } from './corpus/store.mjs';

let seed = 12345;
const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
/** Small floats and small integers in turn, so indexes often stay in range and the float paths run. */
function memory() {
  const words = new Uint32Array(1024),
    floats = new Float32Array(words.buffer);
  for (let i = 0; i < words.length; i++)
    if (next() & 1) floats[i] = (next() % 2000) / 1000 - 1;
    else words[i] = next() % 64;
  return words;
}

let evalRefused = false;
try {
  new Function('');
} catch (error) {
  evalRefused = error instanceof EvalError;
}
if (evalRefused) await loadInterpreter();
const digests = {};
const seen = new Set();
for (const m of readCorpus().modules) {
  if (!m.entryPoints.compute) continue;
  const module = checkWGSL(m.code);
  const vars = module.globals.filter((g) => g.kind === 'var' && g.binding !== undefined);
  if (vars.some((g) => g.space !== 'uniform' && g.space !== 'storage')) continue;
  for (const pipeline of m.pipelines) {
    if (!pipeline.compute) continue;
    const { entryPoint, constants = {} } = pipeline.compute,
      id = JSON.stringify([m.key, entryPoint, constants]);
    if (seen.has(id)) continue;
    seen.add(id);
    const buffers = new Map(vars.map((g) => [`${g.group}:${g.binding}`, memory()]));
    let outcome = 'ran';
    try {
      runComputeOnCPU({ module, entryPoint, constants, buffers, workgroups: [2], workBudget: 20_000 });
    } catch (error) {
      outcome = error.message;
    }
    const hash = createHash('sha256').update(outcome);
    for (const [key, words] of buffers) hash.update(key).update(new Uint8Array(words.buffer));
    digests[id] = hash.digest('hex');
  }
}
console.log(JSON.stringify({ evalRefused, digests }));
