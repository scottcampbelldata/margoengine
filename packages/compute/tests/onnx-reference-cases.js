import { loadOnnx, OnnxTensor } from '../dist/onnx.js';

const types = [
  '',
  'float32',
  'uint8',
  'int8',
  'uint16',
  'int16',
  'int32',
  'int64',
  'string',
  'bool',
  'float16',
  'float64',
  'uint32',
  'uint64',
];
const constructors = [
  null,
  Float32Array,
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Int32Array,
  BigInt64Array,
  null,
  Uint8Array,
  Uint16Array,
  Float64Array,
  Uint32Array,
  BigUint64Array,
];
const bytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: ${String(actual)} vs ${String(expected)}`);
}
/** Run identical pinned data in Node and a real browser, with no oracle runtime at test time. */
export async function checkOnnxReference(c) {
  using model = await loadOnnx(bytes(c.model));
  const persistent = model.work.liveBytes;
  const feeds = Object.fromEntries(
    Object.entries(c.feeds).map(([name, t]) => {
      const values =
        t.kind === 8
          ? t.data
          : constructors[t.kind].from(t.data, (v) => ([7, 13].includes(t.kind) ? BigInt(v) : Number(v)));
      return [name, new OnnxTensor(types[t.kind], values, t.shape)];
    }),
  );
  const output = await model.run(feeds);
  let maxAbsoluteError = 0;
  c.expected.forEach((r, j) => {
    const actual = output[`y${j}`];
    equal(actual.dtype, types[r.kind], 'output dtype');
    equal(JSON.stringify(actual.shape), JSON.stringify(r.shape), 'output shape');
    const expected = r.kind === 8 ? r.data : new constructors[r.kind](bytes(r.data).buffer);
    equal(actual.data.length, expected.length, 'output length');
    for (let i = 0; i < expected.length; i++) {
      const v = actual.data[i],
        e = expected[i];
      const label = `${c.id}, output ${j}, element ${i}`;
      if (typeof e !== 'number' || ![1, 10, 11].includes(r.kind)) equal(v, e, label);
      else if (!Object.is(v, e) && !(Number.isNaN(v) && Number.isNaN(e))) {
        const bound = r.kind === 11 ? 1e-11 : 1e-6;
        const error = Math.abs(v - e);
        if (!(error <= bound + bound * Math.abs(e))) throw new Error(`${label}: ${v} vs ${e}`);
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
      }
    }
  });
  equal(model.work.liveBytes, persistent, 'temporary storage after inference');
  return maxAbsoluteError;
}
