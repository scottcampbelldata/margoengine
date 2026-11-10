// Clean-room protobuf fixtures from ONNX's normative ModelProto field numbers.
const text = new TextEncoder();
export function varint(n) {
  n = BigInt.asUintN(64, BigInt(n));
  const result = [];
  while (n >= 128n) {
    result.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  result.push(Number(n));
  return Uint8Array.from(result);
}
export function concat(...parts) {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
export function field(id, value) {
  if (typeof value === 'number' || typeof value === 'bigint') return concat(varint(id * 8), varint(value));
  if (typeof value === 'string') value = text.encode(value);
  return concat(varint(id * 8 + 2), varint(value.length), value);
}
export const message = (...fields) => concat(...fields);
export const attr = (name, value, kind = typeof value === 'string' ? 3 : 2) =>
  message(field(1, name), field(20, kind), field(kind === 3 ? 4 : 3, value));
export const intsAttr = (name, values) => message(field(1, name), field(20, 7), ...values.map((v) => field(8, v)));
export const node = (op, inputs, outputs, attributes = [], domain = '') =>
  message(
    ...inputs.map((v) => field(1, v)),
    ...outputs.map((v) => field(2, v)),
    field(4, op),
    ...attributes.map((v) => field(5, v)),
    ...(domain ? [field(7, domain)] : []),
  );
export const tensor = (name, kind, shape, data) =>
  message(
    ...shape.map((n) => field(1, n)),
    field(2, kind),
    field(8, name),
    field(9, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
  );
export const valueInfo = (name, kind = 1, shape = []) =>
  message(
    field(1, name),
    field(
      2,
      field(
        1,
        message(
          field(1, kind),
          field(
            2,
            message(
              ...shape.map((v) => field(1, v == null ? message() : typeof v === 'string' ? field(2, v) : field(1, v))),
            ),
          ),
        ),
      ),
    ),
  );
export const graph = (nodes, inputs, outputs, initializers = []) =>
  message(
    ...nodes.map((n) => field(1, n)),
    field(2, 'clean-room-fixture'),
    ...initializers.map((t) => field(5, t)),
    ...inputs.map((v) => field(11, v)),
    ...outputs.map((v) => field(12, v)),
  );
export const model = (body, version = 18, extra = []) =>
  message(field(1, 10), field(7, body), field(8, message(field(1, ''), field(2, version))), ...extra);

// Minimal independent reader for the float32 TensorProto reference-data fixtures.
export function referenceTensor(bytes) {
  let at = 0;
  const uint = () => {
    let n = 0n,
      shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (at >= bytes.length) throw new Error('truncated fixture');
      const b = bytes[at++];
      n |= BigInt(b & 127) << shift;
      if (b < 128) return n;
      shift += 7n;
    }
    throw new Error('fixture varint overflow');
  };
  const fields = new Map();
  while (at < bytes.length) {
    const key = Number(uint());
    const tag = key >>> 3;
    const wire = key & 7;
    let v;
    if (wire === 0) v = uint();
    else {
      const n = wire === 2 ? Number(uint()) : wire === 5 ? 4 : wire === 1 ? 8 : NaN;
      if (!Number.isSafeInteger(n) || at + n > bytes.length) throw new Error('invalid reference fixture');
      v = bytes.slice(at, at + n);
      at += n;
    }
    const list = fields.get(tag) ?? [];
    list.push(v);
    fields.set(tag, list);
  }
  const shape = (fields.get(1) ?? []).flatMap((v) => {
    if (typeof v === 'bigint') return Number(v);
    const values = [];
    let p = 0;
    while (p < v.length) {
      let n = 0n,
        s = 0n,
        b;
      do {
        b = v[p++];
        n |= BigInt(b & 127) << s;
        s += 7n;
      } while (b & 128);
      values.push(Number(n));
    }
    return values;
  });
  const kind = Number(fields.get(2)?.[0]);
  if (kind !== 1) throw new Error('reference fixture is not float32');
  const raw = fields.get(9)?.[0] ?? concat(...(fields.get(4) ?? []));
  if (!(raw instanceof Uint8Array)) throw new Error('missing reference fixture data');
  return {
    name: new TextDecoder().decode(fields.get(8)?.[0] ?? new Uint8Array()),
    shape,
    data: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)),
  };
}
export const floatAttr = (name, value) =>
  message(field(1, name), field(20, 1), varint(21), new Uint8Array(Float32Array.of(value).buffer));
export const floatsAttr = (name, values) =>
  message(field(1, name), field(20, 6), field(7, new Uint8Array(Float32Array.from(values).buffer)));
export const stringsAttr = (name, values) => message(field(1, name), field(20, 8), ...values.map((v) => field(9, v)));
