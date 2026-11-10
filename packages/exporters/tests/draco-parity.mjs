// CPU-only clean-room interoperability proof. Execute opaque legacy builds only
// from an explicitly supplied outside directory; no implementation text is read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitGLB, readAccessor } from '@margoengine/exporters';
import { encodeDracoMesh } from '../dist/draco-encode.js';
import { loadInNode } from '../dist/encoder-host.js';
import { encodeNativeMesh, loadNativeEncoder } from '../dist/draco-native-encode.js';
import { decodeDraco } from '../../decoders/dist/codec.js';
import { decodeNativeDraco } from '../../decoders/dist/draco-native-codec.js';

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const oracle = option('oracle');
assert.ok(
  oracle,
  'Supply --oracle=<outside folder> containing opaque draco_encoder_wrapper.cjs, draco_encoder.wasm, draco_decoder.cjs and draco_decoder.wasm',
);
const root = resolve(import.meta.dirname, '../../..');
const outside = resolve(oracle);
const fromRoot = relative(root, outside);
assert.ok(
  isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`),
  'The legacy oracle must live outside this repository',
);
const models = args.filter((a) => !a.startsWith('--'));
assert.ok(models.length, 'Supply original openly licensed GLB model paths');
const url = (name) => pathToFileURL(resolve(outside, name));
const { module: oldEncoder } = await loadInNode(url('draco_encoder_wrapper.cjs'), url('draco_encoder.wasm'));
const { module: oldDecoder } = await loadInNode(url('draco_decoder.cjs'), url('draco_decoder.wasm'));
const native = await loadNativeEncoder(new URL('../dist/draco-native-encoder.wasm', import.meta.url).href);
const {
  instance: { exports: nativeDecoder },
} = await WebAssembly.instantiate(readFileSync(new URL('../../decoders/dist/draco-native.wasm', import.meta.url)));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const component = (values) =>
  values instanceof Float32Array
    ? 5126
    : values instanceof Uint32Array
      ? 5125
      : values instanceof Uint16Array
        ? 5123
        : values instanceof Int16Array
          ? 5122
          : values instanceof Int8Array
            ? 5120
            : 5121;
const kind = (name) =>
  name === 'POSITION'
    ? 'POSITION'
    : name === 'NORMAL'
      ? 'NORMAL'
      : /^TEXCOORD_/.test(name)
        ? 'TEX_COORD'
        : /^COLOR_/.test(name)
          ? 'COLOR'
          : 'GENERIC';
const bits = (name, settings) =>
  name === 'POSITION'
    ? settings.positionBits
    : name === 'NORMAL'
      ? settings.normalBits
      : /^TEXCOORD_/.test(name)
        ? settings.texcoordBits
        : /^COLOR_/.test(name)
          ? settings.colorBits
          : name === 'TANGENT'
            ? settings.tangentBits
            : 0;
const defaults = {
  positionBits: 14,
  normalBits: 10,
  texcoordBits: 12,
  colorBits: 8,
  tangentBits: 12,
  encodeSpeed: 5,
  decodeSpeed: 5,
};
const settings = args.includes('--matrix')
  ? [
      { ...defaults, name: 'default' },
      { ...defaults, name: 'fast', encodeSpeed: 10, decodeSpeed: 10 },
      { ...defaults, name: 'exact', positionBits: 0, normalBits: 0, texcoordBits: 0, colorBits: 0, tangentBits: 0 },
      {
        ...defaults,
        name: 'precise',
        positionBits: 18,
        normalBits: 12,
        texcoordBits: 14,
        tangentBits: 16,
        encodeSpeed: 0,
        decodeSpeed: 0,
      },
    ]
  : [{ ...defaults, name: 'default' }];

function request(attributes) {
  return {
    attributeIds: Object.fromEntries(attributes.map((a, i) => [a.semantic, i])),
    componentTypes: Object.fromEntries(attributes.map((a) => [a.semantic, component(a.values)])),
  };
}
function values(decoded, name) {
  return name === 'POSITION'
    ? decoded.positions
    : name === 'NORMAL'
      ? decoded.normals
      : name === 'TEXCOORD_0'
        ? decoded.uvs
        : name === 'COLOR_0'
          ? decoded.colors
          : decoded.attributes[name].array;
}
function triangles(decoded) {
  const ids = decoded.attributes._B136_ID.array;
  const out = [];
  for (let i = 0; i < decoded.indices.length; i += 3) {
    const [a, b, c] = Array.from(decoded.indices.slice(i, i + 3), (v) => ids[v]);
    out.push([`${a},${b},${c}`, `${b},${c},${a}`, `${c},${a},${b}`].sort()[0]);
  }
  return out.sort();
}
function sourceRows(decoded) {
  const map = new Map();
  decoded.attributes._B136_ID.array.forEach((id, row) => map.set(id, row));
  return map;
}
function checkAttributes(job, ours, reference) {
  const a = sourceRows(ours),
    b = sourceRows(reference),
    errors = {};
  assert.deepEqual(
    [...a.keys()].sort((x, y) => x - y),
    [...b.keys()].sort((x, y) => x - y),
  );
  for (const attribute of job.attributes) {
    const name = attribute.semantic,
      av = values(ours, name),
      bv = values(reference, name),
      width = attribute.width;
    let maximum = 0,
      oldMaximum = 0,
      squared = 0,
      oldSquared = 0;
    for (const [id, row] of a) {
      const oldRow = b.get(id);
      let error = 0,
        oldError = 0;
      for (let k = 0; k < width; k++) {
        const x = av[row * width + k],
          y = bv[oldRow * width + k];
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `${name} nonfinite output`);
        if (!(attribute.values instanceof Float32Array) || attribute.bits === 0) {
          assert.equal(x, y, `${name}/${id}/${k} exact value`);
        } else {
          const input = attribute.values[id * width + k];
          error += (x - input) ** 2;
          oldError += (y - input) ** 2;
        }
      }
      maximum = Math.max(maximum, Math.sqrt(error));
      oldMaximum = Math.max(oldMaximum, Math.sqrt(oldError));
      squared += error;
      oldSquared += oldError;
    }
    assert.ok(maximum <= oldMaximum, `${name} maximum error ${maximum} exceeds ${oldMaximum}`);
    assert.ok(squared <= oldSquared, `${name} squared error ${squared} exceeds ${oldSquared}`);
    errors[name] = { maximum, oldMaximum, squared, oldSquared };
  }
  return errors;
}

const output = option('output') ?? 'test-results/batch-136/draco-parity.json';
const rows = [],
  failures = [],
  ineligible = [];
for (const model of models) {
  const source = readFileSync(model),
    parts = splitGLB(new Uint8Array(source));
  for (const [meshIndex, mesh] of (parts.json.meshes ?? []).entries())
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      const reason =
        (primitive.mode ?? 4) !== 4
          ? 'not a triangle primitive'
          : primitive.targets?.length
            ? 'morph targets are outside the Draco export contract'
            : primitive.extensions?.KHR_draco_mesh_compression
              ? 'already compressed input'
              : primitive.attributes?.POSITION === undefined
                ? 'no POSITION attribute'
                : undefined;
      if (reason) {
        ineligible.push({ model, meshIndex, primitiveIndex, reason });
        continue;
      }
      for (const setting of settings) {
        const name = `${model}/${meshIndex}/${primitiveIndex}/${setting.name}`;
        const attributes = Object.entries(primitive.attributes)
          .sort()
          .map(([semantic, id]) => {
            const a = readAccessor(parts, id);
            return {
              semantic,
              kind: kind(semantic),
              values: a.values,
              width: a.width,
              normalized: a.normalized,
              bits: bits(semantic, setting),
            };
          });
        const points = attributes[0].values.length / attributes[0].width;
        const indices =
          primitive.indices === undefined
            ? Uint32Array.from({ length: points }, (_, i) => i)
            : Uint32Array.from(readAccessor(parts, primitive.indices).values);
        assert.equal(indices.length % 3, 0, `${name} incomplete source triangle`);
        const job = { points, indices, attributes, encodeSpeed: setting.encodeSpeed, decodeSpeed: setting.decodeSpeed };
        try {
          const encoded = encodeNativeMesh(native, job),
            legacy = encodeDracoMesh(oldEncoder, job),
            options = request(attributes);
          assert.deepEqual(
            decodeNativeDraco(nativeDecoder, encoded.data, options),
            decodeDraco(oldDecoder, encoded.data, options),
            name + ' native/old decode',
          );
          const tagged = {
            ...job,
            attributes: [
              ...attributes,
              {
                semantic: '_B136_ID',
                kind: 'GENERIC',
                values: Uint32Array.from({ length: points }, (_, i) => i),
                width: 1,
                normalized: false,
                bits: 0,
              },
            ],
          };
          const taggedOptions = request(tagged.attributes);
          const ours = decodeNativeDraco(nativeDecoder, encodeNativeMesh(native, tagged).data, taggedOptions);
          const reference = decodeDraco(oldDecoder, encodeDracoMesh(oldEncoder, tagged).data, taggedOptions);
          assert.deepEqual(triangles(ours), triangles(reference), name + ' oriented source corners');
          const errors = checkAttributes(job, ours, reference);
          const row = {
            name,
            modelSha256: hash(source),
            points,
            faces: indices.length / 3,
            bytes: encoded.data.length,
            oldBytes: legacy.data.length,
            method: encoded.data[8],
            errors,
          };
          rows.push(row);
          assert.ok(row.bytes <= row.oldBytes, `${name} compression ${row.bytes} exceeds ${row.oldBytes}`);
          console.log(`${name}: ${row.bytes}/${row.oldBytes} B, exact oriented corners and decoder agreement`);
        } catch (error) {
          failures.push({ name, message: error.message });
          console.error(`${name}: ${error.message}`);
        }
      }
    }
}
mkdirSync(resolve(output, '..'), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      encoderSha256: hash(readFileSync(new URL('../dist/draco-native-encoder.wasm', import.meta.url))),
      oracleEncoderSha256: hash(readFileSync(url('draco_encoder.wasm'))),
      rows,
      failures,
      ineligible,
    },
    null,
    2,
  ) + '\n',
);
assert.ok(rows.length, 'No eligible triangle streams were tested');
assert.equal(failures.length, 0, JSON.stringify(failures));
console.log(`Draco parity: ${rows.length} rows passed; no wall-clock measurements`);
