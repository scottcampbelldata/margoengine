// Measures Draco decode memory at scale: `node scripts/draco-scale.mjs [side] [--positions] [--out=file.drc]`.
// Encodes a side x side height-field grid ((side - 1)^2 x 2 triangles; 2237 gives 9,999,392) with the clean-room encoder
// of @margoengine/exporters (build it first), decodes it with the prebuilt and the clean-room decoder, and prints the
// output bytes and each decoder's peak Wasm memory. `--positions` encodes positions only, the worst memory per output
// byte; without it the grid has normals and UVs too. `--out` keeps the encoded stream
// (tests/fixtures/grid-1m-positions.drc is `708 --positions`).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const args = process.argv.slice(2),
  side = Number(args.find((a) => /^\d+$/.test(a)) ?? 2237),
  positionsOnly = args.includes('--positions'),
  outFile = args.find((a) => a.startsWith('--out='))?.slice(6);
const points = side * side,
  triangles = (side - 1) * (side - 1) * 2;
const position = new Float32Array(points * 3),
  normal = new Float32Array(points * 3),
  uv = new Uint16Array(points * 2);
for (let y = 0, v = 0; y < side; y++)
  for (let x = 0; x < side; x++, v++) {
    const h = Math.sin(x * 0.031) * Math.cos(y * 0.027) * 4 + Math.sin(x * 0.4 + y * 0.3) * 0.2;
    position.set([x * 0.01, h * 0.01, y * 0.01], v * 3);
    const dx = Math.cos(x * 0.031) * 0.124 * Math.cos(y * 0.027),
      dy = -Math.sin(x * 0.031) * Math.sin(y * 0.027) * 0.108,
      l = Math.hypot(dx, 1, dy);
    normal.set([-dx / l, 1 / l, -dy / l], v * 3);
    uv.set([Math.round((x / (side - 1)) * 65535), Math.round((y / (side - 1)) * 65535)], v * 2);
  }
const indices = new Uint32Array(triangles * 3);
for (let y = 0, i = 0; y < side - 1; y++)
  for (let x = 0; x < side - 1; x++, i += 6) {
    const a = y * side + x,
      c = a + side;
    indices.set([a, c, a + 1, a + 1, c, c + 1], i);
  }
const exporters = here('../../exporters/dist/');
const { loadNativeEncoder, encodeNativeMesh } = await import(pathToFileURL(exporters + 'draco-native-encode.js').href);
const encoder = await loadNativeEncoder(pathToFileURL(exporters + 'draco-native-encoder.wasm').href);
const attributes = [{ semantic: 'POSITION', kind: 'POSITION', values: position, width: 3, normalized: false, bits: 14 }];
if (!positionsOnly)
  attributes.push(
    { semantic: 'NORMAL', kind: 'NORMAL', values: normal, width: 3, normalized: false, bits: 10 },
    { semantic: 'TEXCOORD_0', kind: 'TEX_COORD', values: uv, width: 2, normalized: true, bits: 0 },
  );
const encoded = encodeNativeMesh(encoder, { indices, points, attributes, encodeSpeed: 5, decodeSpeed: 5 }).data;
if (outFile) writeFileSync(outFile, encoded);
const bytes = (g) => [g.positions, g.indices, g.normals, g.uvs, g.colors].reduce((s, a) => s + (a?.byteLength ?? 0), 0);
globalThis.require = createRequire(import.meta.url);
globalThis.__dirname = here('../dist/draco/');
runInThisContext(readFileSync(here('../dist/draco/draco_wasm_wrapper.js'), 'utf8'));
const prebuilt = await globalThis.DracoDecoderModule({ wasmBinary: readFileSync(here('../dist/draco/draco_decoder.wasm')) });
const { decodeDraco } = await import(pathToFileURL(here('../dist/codec.js')).href);
const { decodeNativeDraco } = await import(pathToFileURL(here('../dist/draco-native-codec.js')).href);
const native = (await WebAssembly.instantiate(readFileSync(here('../dist/draco-native.wasm')))).instance.exports;
const report = { side, triangles, points, positionsOnly, encodedBytes: encoded.length };
for (const [name, decode, memory] of [
  ['prebuilt', () => decodeDraco(prebuilt, encoded), () => prebuilt.HEAPU8.buffer.byteLength],
  ['native', () => decodeNativeDraco(native, encoded), () => native.memory.buffer.byteLength],
]) {
  const start = performance.now(),
    g = decode();
  report[name] = { outputBytes: bytes(g), peakWasmBytes: memory(), ms: Math.round(performance.now() - start) };
}
console.log(JSON.stringify(report));
