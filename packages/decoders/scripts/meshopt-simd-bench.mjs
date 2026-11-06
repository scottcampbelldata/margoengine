// Times every compressed view of a glTF binary through both meshopt decoders, median of 15 passes.
// Run after `npm run build --workspace packages/decoders`: `node packages/decoders/scripts/meshopt-simd-bench.mjs <file.glb>`.
import { readFileSync } from 'node:fs';
import { meshoptDecodeGltfBuffer } from '../dist/meshopt.js';
import { MeshoptSIMDDecoder, meshoptDecodeGltfBufferSIMD } from '../dist/meshopt-simd.js';

const data = new Uint8Array(readFileSync(process.argv[2])),
  view = new DataView(data.buffer, data.byteOffset),
  length = view.getUint32(12, true),
  at = 20 + length + 8,
  json = JSON.parse(Buffer.from(data.subarray(20, 20 + length))),
  binary = data.subarray(at, at + view.getUint32(20 + length, true)),
  calls = json.bufferViews.flatMap((bufferView) => {
    const c = bufferView.extensions?.EXT_meshopt_compression ?? bufferView.extensions?.KHR_meshopt_compression;
    if (!c) return [];
    const start = c.byteOffset ?? 0;
    return [[binary.subarray(start, start + c.byteLength), c.count, c.byteStride, c.mode, c.filter ?? 'NONE']];
  }),
  median = (decode) => {
    const times = [];
    for (let pass = 0; pass < 15; pass++) {
      const start = performance.now();
      for (const call of calls) decode(...call);
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[7];
  };

await MeshoptSIMDDecoder.ready;
const output = calls.reduce((sum, call) => sum + call[1] * call[2], 0),
  typescript = median(meshoptDecodeGltfBuffer),
  simd = median(meshoptDecodeGltfBufferSIMD);
console.log(`${calls.length} views, ${output} bytes out: TypeScript ${typescript.toFixed(2)} ms, Wasm SIMD ${simd.toFixed(2)} ms`);
