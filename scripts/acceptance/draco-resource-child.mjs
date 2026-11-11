// Owned harness: no clocks, timing assertions, implementation inspection or GPU.
//
// Outputs (argument 5): `api` (default) asks each side for what Margo's public API returns. A mesh gets every
// attribute in its stored type and as float32 (DracoDecoder hands glTF float accessors; the prebuilt converts inside
// its Wasm, the native side in JavaScript, as draco-native-codec.ts does). A point cloud gets its stored type only:
// DracoPointsDecoder on either decoder never converts point attributes (codec.ts decodeDracoPoints,
// draco-native-codec.ts decodeNativePoints). `float` also converts point-cloud attributes to float32 on both sides,
// the prebuilt in its Wasm and the native side in JavaScript: a like-for-like row that carries both conversion costs,
// which no Margo call pays (KB4824a residue, bug sweep L5b 2026-11-11).
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [variant, path, , outputs = 'api'] = process.argv.slice(2),
  counts = {
    compileCalls: 0,
    instantiateCalls: 0,
    wasmBytes: 0,
    wrapperBytes: 0,
    inputCopyBytes: 0,
    resultCopyBytes: 0,
    publicAllocationCalls: 0,
  };
const rss = () => ({ rssBytes: process.memoryUsage.rss(), peakRSSBytes: process.resourceUsage().maxRSS * 1024 });
assert.ok(['api', 'float'].includes(outputs), 'outputs must be api or float');
const baseline = rss(),
  sha = (b) => createHash('sha256').update(b).digest('hex'),
  widths = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 9: 4, 10: 8, 11: 1 };
const getters = {
  1: 'getInt8',
  2: 'getUint8',
  3: 'getInt16',
  4: 'getUint16',
  5: 'getInt32',
  6: 'getUint32',
  9: 'getFloat32',
  10: 'getFloat64',
  11: 'getUint8',
};
function floats(b, type, normalized) {
  if (type === 9 && !normalized) return Buffer.from(b);
  const width = widths[type],
    v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    out = Buffer.alloc((b.length / width) * 4),
    max = { 1: 127, 2: 255, 3: 32767, 4: 65535, 5: 2147483647, 6: 4294967295 }[type];
  for (let i = 0; i < b.length / width; i++) {
    let x = v[getters[type]](i * width, true);
    if (normalized && max) x = Math.max(-1, x / max);
    out.writeFloatLE(x, i * 4);
  }
  return out;
}
let decode, memory, wasm, wasmHash;
if (variant === 'native-full' || variant === 'native-gltf') {
  wasm = readFileSync(process.argv[4]);
  counts.wasmBytes = wasm.length;
  wasmHash = sha(wasm);
  const mod = new WebAssembly.Module(wasm);
  counts.compileCalls++;
  const m = new WebAssembly.Instance(mod).exports;
  counts.instantiateCalls++;
  memory = () => m.memory.buffer.byteLength;
  decode = (input) => {
    const p = m.draco_alloc(input.length);
    counts.publicAllocationCalls++;
    assert.ok(p);
    let out = 0,
      size = 0;
    try {
      new Uint8Array(m.memory.buffer, p, input.length).set(input);
      counts.inputCopyBytes += input.length;
      out = m.draco_decode(p, input.length, 16777216, 134217728, 268435456, variant === 'native-gltf' ? 1 : 0);
      assert.ok(out);
      const v = new DataView(m.memory.buffer);
      size = v.getUint32(out, true);
      const b = Buffer.from(new Uint8Array(m.memory.buffer, out, size));
      counts.resultCopyBytes += size;
      const code = b.readUInt32LE(4);
      if (code) return { ok: false, code };
      const points = b.readUInt32LE(8),
        n = b.readUInt32LE(16),
        count = b.readUInt32LE(20),
        indices = b.subarray(24, 24 + n * 4),
        attributes = [];
      let at = 24 + n * 4;
      for (let i = 0; i < count; i++) {
        const [semantic, type, width, normalized] = b.subarray(at, at + 4),
          id = b.readUInt32LE(at + 4),
          len = b.readUInt32LE(at + 8);
        at += 12;
        const native = b.subarray(at, at + len);
        at += len;
        const float = outputs === 'float' || b.readUInt32LE(12) ? floats(native, type, normalized) : null;
        counts.resultCopyBytes += float?.length ?? 0;
        attributes.push({ semantic, type, width, normalized: !!normalized, id, native, float });
      }
      return { ok: true, points, indices, attributes };
    } finally {
      if (out) m.draco_free(out, size);
      m.draco_free(p, input.length);
    }
  };
} else {
  assert.ok(
    process.env.MARGO_DRACO_ORACLE_ROOT,
    'Set MARGO_DRACO_ORACLE_ROOT to the verified opaque copies outside this repository',
  );
  const folder = realpathSync(resolve(process.env.MARGO_DRACO_ORACLE_ROOT, variant)),
    repo = realpathSync(resolve(import.meta.dirname, '../..'));
  assert.ok(
    folder !== repo &&
      !folder.toLowerCase().startsWith(repo.toLowerCase() + '/') &&
      !folder.toLowerCase().startsWith(repo.toLowerCase() + '\\'),
    'opaque execution must stay outside this repository',
  );
  const { createRequire } = await import('node:module'),
    { runInThisContext } = await import('node:vm');
  globalThis.require = createRequire(resolve(folder, 'rss.cjs'));
  globalThis.__dirname = folder;
  const wrapper = readFileSync(resolve(folder, 'draco_wasm_wrapper.js'));
  counts.wrapperBytes = wrapper.length;
  runInThisContext(wrapper.toString(), { filename: resolve(folder, 'draco_wasm_wrapper.js'), timeout: 10000 });
  wasm = readFileSync(resolve(folder, 'draco_decoder.wasm'));
  counts.wasmBytes = wasm.length;
  wasmHash = sha(wasm);
  const { m } = await new Promise((done, reject) =>
    globalThis
      .DracoDecoderModule({
        wasmBinary: wasm,
        instantiateWasm(imports, receive) {
          const mod = new WebAssembly.Module(wasm);
          counts.compileCalls++;
          const instance = new WebAssembly.Instance(mod, imports);
          counts.instantiateCalls++;
          receive(instance, mod);
          return instance.exports;
        },
      })
      .then((m) => done({ m }), reject),
  );
  memory = () => m.HEAPU8.buffer.byteLength;
  decode = (input) => {
    const d = new m.Decoder(),
      b = new m.DecoderBuffer(),
      mesh = input[7] === 1,
      g = mesh ? new m.Mesh() : new m.PointCloud();
    b.Init(new Int8Array(input.buffer, input.byteOffset, input.byteLength), input.length);
    counts.inputCopyBytes += input.length;
    let status;
    try {
      status = mesh ? d.DecodeBufferToMesh(b, g) : d.DecodeBufferToPointCloud(b, g);
      if (!status.ok()) return { ok: false };
      const points = g.num_points(),
        faces = mesh ? g.num_faces() : 0,
        attributes = [];
      let indices = Buffer.alloc(0);
      if (faces) {
        const len = faces * 12,
          p = m._malloc(len);
        counts.publicAllocationCalls++;
        try {
          assert.ok(d.GetTrianglesUInt32Array(g, len, p));
          indices = Buffer.from(m.HEAPU8.subarray(p, p + len));
          counts.resultCopyBytes += len;
        } finally {
          m._free(p);
        }
      }
      for (let i = 0; i < g.num_attributes(); i++) {
        const a = d.GetAttribute(g, i),
          type = a.data_type(),
          width = a.num_components(),
          count = points * width,
          len = count * widths[type],
          p = m._malloc(Math.max(len, count * 4));
        counts.publicAllocationCalls++;
        try {
          const nativeOK = d.GetAttributeDataArrayForAllPoints(g, a, type, len, p),
            native = nativeOK ? Buffer.from(m.HEAPU8.subarray(p, p + len)) : undefined,
            floatOK =
              (outputs === 'float' || mesh) && d.GetAttributeDataArrayForAllPoints(g, a, m.DT_FLOAT32, count * 4, p),
            float = floatOK ? Buffer.from(m.HEAPU8.subarray(p, p + count * 4)) : undefined;
          counts.resultCopyBytes += (native?.length ?? 0) + (float?.length ?? 0);
          attributes.push({
            semantic: a.attribute_type(),
            type,
            width,
            normalized: a.normalized(),
            id: a.unique_id(),
            native,
            float,
          });
        } finally {
          m._free(p);
        }
      }
      return { ok: true, points, indices, attributes };
    } finally {
      if (status) m.destroy(status);
      [g, b, d].forEach((x) => m.destroy(x));
    }
  };
}
const initialized = { ...rss(), linearBytes: memory() };
let result, retained;
if (path) {
  const input = readFileSync(path);
  retained = decode(input);
  if (retained.ok)
    result = {
      ok: true,
      output: {
        points: retained.points,
        indices: sha(retained.indices),
        attributes: retained.attributes.map((a) => ({
          ...a,
          native: a.native ? sha(a.native) : null,
          float: a.float ? sha(a.float) : null,
        })),
      },
    };
  else result = retained;
}
const final = { ...rss(), linearBytes: memory() };
assert.equal(counts.compileCalls, 1);
assert.equal(counts.instantiateCalls, 1);
console.log(JSON.stringify({ variant, outputs, wasmHash, counts, baseline, initialized, final, ...result }));
// Keep the decoded buffers strongly reachable until after high-water capture.
assert.ok(!path || retained);
