// The TypeScript generator: from one schema, a standalone module (no imports) of interfaces and encoders that write
// exactly the bytes the runtime codec writes. A generator for another language (Rust) reads the same normalized JSON
// (`schema.json`) and follows README "Wire format"; this file is the reference for how each field is written.
import type { NormalizedField, NormalizedSchema, SchemaCodec, SchemaDefinition, SchemaShape } from './schema.js';

/** Options of {@link generateTypeScript}. */
export interface GenerateOptions {
  /** A line naming where the schema came from, put in the header comment (default none). */
  source?: string;
}

const RANGES: Record<string, [number, number, string, string]> = {
  u8: [0, 255, 'w.u8(v)', 'r.u8()'],
  u16: [0, 65535, 'w.u16(v)', 'r.u16()'],
  u32: [0, 2 ** 32 - 1, 'w.u32(v)', 'r.u32()'],
  i8: [-128, 127, 'w.u8(v & 255)', '(r.u8() << 24) >> 24'],
  i16: [-32768, 32767, 'w.u16(v & 65535)', '(r.u16() << 16) >> 16'],
  i32: [-(2 ** 31), 2 ** 31 - 1, 'w.u32(v >>> 0)', 'r.u32() | 0'],
  uint: [0, 2 ** 32 - 1, 'w.varint(v)', 'r.varint()'],
  int: [-(2 ** 31), 2 ** 31 - 1, 'w.varint(v < 0 ? -2 * v - 1 : 2 * v)', 'unzigzag(r.varint())'],
};

const RUNTIME = `const utf8 = new TextEncoder(),
  text = new TextDecoder('utf-8', { fatal: true });
const unzigzag = (z: number): number => (z % 2 ? -(z + 1) / 2 : z / 2);
class Writer {
  bytes = new Uint8Array(64);
  view = new DataView(this.bytes.buffer);
  at = 0;
  room(n: number): void {
    if (this.at + n <= this.bytes.length) return;
    const bytes = new Uint8Array(Math.max(2 * this.bytes.length, this.at + n));
    bytes.set(this.bytes);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer);
  }
  u8(v: number): void {
    this.room(1);
    this.bytes[this.at++] = v;
  }
  u16(v: number): void {
    this.room(2);
    this.view.setUint16(this.at, v, true);
    this.at += 2;
  }
  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.at, v, true);
    this.at += 4;
  }
  f32(v: number): void {
    this.room(4);
    this.view.setFloat32(this.at, v, true);
    this.at += 4;
  }
  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.at, v, true);
    this.at += 8;
  }
  varint(v: number): void {
    this.room(5);
    for (; v > 127; v >>>= 7) this.bytes[this.at++] = (v & 127) | 128;
    this.bytes[this.at++] = v;
  }
  raw(b: Uint8Array): void {
    this.room(b.length);
    this.bytes.set(b, this.at);
    this.at += b.length;
  }
  done(): Uint8Array {
    return this.bytes.slice(0, this.at);
  }
}
class Reader {
  at = 0;
  bytes: Uint8Array;
  view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  fail(problem: string): RangeError {
    return new RangeError(\`Schema bytes \${problem}; pass bytes the matching encoder returned\`);
  }
  need(n: number): void {
    if (this.at + n > this.bytes.length) throw this.fail(\`are truncated at byte \${this.at} of \${this.bytes.length}\`);
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.at++];
  }
  u16(): number {
    this.need(2);
    this.at += 2;
    return this.view.getUint16(this.at - 2, true);
  }
  u32(): number {
    this.need(4);
    this.at += 4;
    return this.view.getUint32(this.at - 4, true);
  }
  finite(v: number): number {
    if (!Number.isFinite(v)) throw this.fail(\`hold a non-finite number at byte \${this.at}\`);
    return v;
  }
  f32(): number {
    this.need(4);
    this.at += 4;
    return this.finite(this.view.getFloat32(this.at - 4, true));
  }
  f64(): number {
    this.need(8);
    this.at += 8;
    return this.finite(this.view.getFloat64(this.at - 8, true));
  }
  varint(): number {
    let value = 0,
      scale = 1;
    for (let n = 0; ; n++, scale *= 128) {
      this.need(1);
      const b = this.bytes[this.at++];
      if (n === 4 && b > 15) throw this.fail(\`hold a varint wider than 32 bits at byte \${this.at - 1}\`);
      value += (b & 127) * scale;
      if (b < 128) return value;
    }
  }
  count(max: number): number {
    const n = this.varint();
    if (n > max) throw this.fail(\`hold a count of \${n}, over its limit of \${max}\`);
    if (n > this.bytes.length - this.at) this.need(n);
    return n;
  }
  ids(n: number, out: number[]): void {
    for (let i = 0, last = -1; i < n; i++) {
      const id = last + 1 + this.varint();
      if (id > 4294967295) throw this.fail(\`hold an entity id over 2^32 - 1 at byte \${this.at}\`);
      out.push((last = id));
    }
  }
  end(): void {
    if (this.at !== this.bytes.length) throw this.fail(\`have \${this.bytes.length - this.at} bytes past the end\`);
  }
}
const writeIds = (w: Writer, list: number[]): void => {
  for (let i = 0, last = -1; i < list.length; last = list[i++]) w.varint(list[i] - last - 1);
};
const integer = (p: string, v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number') throw new TypeError(\`\${p} must be a number\`);
  if (!Number.isInteger(v) || v < min || v > max)
    throw new RangeError(\`\${p} is \${v}, not an integer from \${min} to \${max}; pass a whole number in that range\`);
  return v;
};
const number = (p: string, v: unknown): number => {
  if (typeof v !== 'number') throw new TypeError(\`\${p} must be a number\`);
  return v;
};
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
`;

const ident = (name: string): string => name.replace(/[^A-Za-z0-9]/g, '_');
const lit = (v: number): string => (Object.is(v, -0) ? '-0' : String(v));

/**
 * The TypeScript source of a standalone module (no imports, erasable syntax only, so Node runs it as it is) with an
 * interface per struct and `encode<Name>`, `decode<Name>`, `encode<Name>Delta`, `decode<Name>Delta` and `same<Name>`
 * per struct, writing and checking exactly what `schema.encode` and `schema.decode` do, plus `SCHEMA_HASH`.
 *
 * @example
 * ```ts
 * import { writeFileSync } from 'node:fs';
 * import { generateTypeScript } from '@margoengine/netcode/generate';
 * import { defineSchema } from '@margoengine/netcode';
 * const schema = defineSchema({ types: { Ping: { at: 'f64' } } });
 * writeFileSync('ping.protocol.ts', generateTypeScript(schema, { source: 'schema.ts' }));
 * ```
 * @throws TypeError when `schema` is neither a compiled schema nor its normalized JSON.
 */
export function generateTypeScript(
  schema: SchemaCodec<SchemaShape> | SchemaCodec<SchemaDefinition> | { json: NormalizedSchema; hash: number },
  options: GenerateOptions = {},
): string {
  const json = (schema as { json?: NormalizedSchema })?.json,
    hash = (schema as { hash?: number })?.hash;
  if (!json?.types || typeof hash !== 'number')
    throw new TypeError('generateTypeScript needs a schema from defineSchema; pass defineSchema({ types })');
  const out: string[] = [],
    helpers: string[] = [];
  const type = (f: NormalizedField): string => {
    switch (f.type) {
      case 'bool':
        return 'boolean';
      case 'string':
        return 'string';
      case 'bytes':
        return 'Uint8Array';
      case 'enum':
        return f.values.map((v) => JSON.stringify(v)).join(' | ');
      case 'array':
        return `${type(f.of).includes('|') ? `(${type(f.of)})` : type(f.of)}[]`;
      case 'optional':
        return type(f.of);
      case 'map':
        return `Map<number, ${type(f.of)}>`;
      case 'struct':
        return f.name;
      default:
        return 'number';
    }
  };
  // Emits the helpers of field `f` under id `id` and returns their names.
  const done = new Set<string>();
  const field = (id: string, f: NormalizedField): { w: string; r: string; s: string; dw?: string; dr?: string } => {
    if (f.type === 'struct')
      return { w: `w_${f.name}`, r: `r_${f.name}`, s: `same${f.name}`, dw: `dw_${f.name}`, dr: `dr_${f.name}` };
    const names = { w: `w_${id}`, r: `r_${id}`, s: `s_${id}` } as {
      w: string;
      r: string;
      s: string;
      dw?: string;
      dr?: string;
    };
    if (f.type === 'map') Object.assign(names, { dw: `dw_${id}`, dr: `dr_${id}` });
    if (done.has(id)) return names;
    done.add(id);
    const T = type(f),
      fn = (name: string, params: string, ret: string, body: string) =>
        helpers.push(`function ${name}(${params}): ${ret} {\n${body}\n}`);
    switch (f.type) {
      case 'bool':
        fn(
          names.w,
          'w: Writer, v: boolean, p: string',
          'void',
          `  if (typeof v !== 'boolean') throw new TypeError(\`\${p} must be a boolean\`);\n  w.u8(v ? 1 : 0);`,
        );
        fn(
          names.r,
          'r: Reader',
          'boolean',
          `  const b = r.u8();\n  if (b > 1) throw r.fail(\`hold a boolean byte of \${b} at byte \${r.at - 1}\`);\n  return b === 1;`,
        );
        fn(names.s, 'a: boolean, b: boolean', 'boolean', '  return a === b;');
        break;
      case 'f32':
        fn(
          names.w,
          'w: Writer, v: number, p: string',
          'void',
          `  if (!Number.isFinite(Math.fround(number(p, v)))) throw new RangeError(\`\${p} is \${v}, not a finite 32-bit float; pass a finite number\`);\n  w.f32(v);`,
        );
        fn(names.r, 'r: Reader', 'number', '  return r.f32();');
        fn(names.s, 'a: number, b: number', 'boolean', '  return Math.fround(a) === Math.fround(b);');
        break;
      case 'f64':
        fn(
          names.w,
          'w: Writer, v: number, p: string',
          'void',
          `  if (!Number.isFinite(number(p, v))) throw new RangeError(\`\${p} is \${v}, not a finite number; pass a finite number\`);\n  w.f64(v);`,
        );
        fn(names.r, 'r: Reader', 'number', '  return r.f64();');
        fn(names.s, 'a: number, b: number', 'boolean', '  return a === b;');
        break;
      case 'quantized': {
        const steps = 2 ** f.bits - 2,
          size = Math.ceil(f.bits / 8),
          scale = steps / (f.max - f.min),
          span = f.max - f.min;
        const q = `Math.round((v - ${lit(f.min)}) * ${lit(scale)})`;
        fn(`q_${id}`, 'v: number', 'number', `  return ${q};`);
        fn(
          names.w,
          'w: Writer, v: number, p: string',
          'void',
          `  const x = number(p, v);\n  if (!(x >= ${lit(f.min)} && x <= ${lit(f.max)})) throw new RangeError(\`\${p} is \${v}, outside its quantized range ${f.min}..${f.max}; widen the range\`);\n  const n = q_${id}(x);\n  for (let i = 0; i < ${size}; i++) w.u8(Math.floor(n / 2 ** (8 * i)) & 255);`,
        );
        fn(
          names.r,
          'r: Reader',
          'number',
          `  let n = 0;\n  for (let i = 0; i < ${size}; i++) n += r.u8() * 2 ** (8 * i);\n  if (n > ${steps}) throw r.fail(\`hold quantized step \${n} over its top step ${steps} at byte \${r.at - ${size}}\`);\n  return ${lit(f.min)} + ${lit(span)} * (n / ${steps});`,
        );
        fn(names.s, 'a: number, b: number', 'boolean', `  return q_${id}(a) === q_${id}(b);`);
        break;
      }
      case 'string':
        fn(
          names.w,
          'w: Writer, v: string, p: string',
          'void',
          `  if (typeof v !== 'string') throw new TypeError(\`\${p} must be a string\`);\n  const bytes = utf8.encode(v);\n  if (bytes.length > ${f.maxLength}) throw new RangeError(\`\${p} is \${bytes.length} UTF-8 bytes, over its limit of ${f.maxLength}; shorten it\`);\n  w.varint(bytes.length);\n  w.raw(bytes);`,
        );
        fn(
          names.r,
          'r: Reader',
          'string',
          `  const n = r.count(${f.maxLength}),\n    at = r.at;\n  r.need(n);\n  r.at += n;\n  try {\n    return text.decode(r.bytes.subarray(at, at + n));\n  } catch {\n    throw r.fail(\`hold text that is not UTF-8 at byte \${at}\`);\n  }`,
        );
        fn(names.s, 'a: string, b: string', 'boolean', '  return a === b;');
        break;
      case 'bytes':
        fn(
          names.w,
          'w: Writer, v: Uint8Array, p: string',
          'void',
          `  if (!(v instanceof Uint8Array)) throw new TypeError(\`\${p} must be a Uint8Array\`);\n  if (v.length > ${f.maxLength}) throw new RangeError(\`\${p} is \${v.length} bytes, over its limit of ${f.maxLength}; shorten it\`);\n  w.varint(v.length);\n  w.raw(v);`,
        );
        fn(
          names.r,
          'r: Reader',
          'Uint8Array',
          `  const n = r.count(${f.maxLength});\n  r.need(n);\n  r.at += n;\n  return r.bytes.slice(r.at - n, r.at);`,
        );
        fn(names.s, 'a: Uint8Array, b: Uint8Array', 'boolean', '  return sameBytes(a, b);');
        break;
      case 'enum': {
        const values = JSON.stringify(f.values);
        helpers.push(`const values_${id}: readonly (${T})[] = ${values};`);
        fn(
          names.w,
          `w: Writer, v: ${T}, p: string`,
          'void',
          `  const i = values_${id}.indexOf(v);\n  if (i < 0) throw new RangeError(\`\${p} is \${String(v)}; use one of ${f.values.join(', ')}\`);\n  w.varint(i);`,
        );
        fn(
          names.r,
          'r: Reader',
          T,
          `  const i = r.varint();\n  if (i >= ${f.values.length}) throw r.fail(\`hold enum index \${i} of only ${f.values.length} values\`);\n  return values_${id}[i];`,
        );
        fn(names.s, `a: ${T}, b: ${T}`, 'boolean', '  return a === b;');
        break;
      }
      case 'array': {
        const item = field(`${id}_i`, f.of);
        fn(
          names.w,
          `w: Writer, v: ${T}, p: string`,
          'void',
          `  if (!Array.isArray(v)) throw new TypeError(\`\${p} must be an array\`);\n  if (v.length > ${f.maxLength}) throw new RangeError(\`\${p} has \${v.length} items, over its limit of ${f.maxLength}; send fewer or raise maxLength in the schema\`);\n  w.varint(v.length);\n  for (let i = 0; i < v.length; i++) ${item.w}(w, v[i], \`\${p}[\${i}]\`);`,
        );
        fn(
          names.r,
          'r: Reader',
          T,
          `  const n = r.count(${f.maxLength}),\n    out: ${T} = new Array(n);\n  for (let i = 0; i < n; i++) out[i] = ${item.r}(r);\n  return out;`,
        );
        fn(
          names.s,
          `a: ${T}, b: ${T}`,
          'boolean',
          `  return a.length === b.length && a.every((v, i) => ${item.s}(v, b[i]));`,
        );
        break;
      }
      case 'optional': {
        const inner = field(`${id}_v`, f.of);
        fn(
          names.w,
          `w: Writer, v: ${T} | undefined, p: string`,
          'void',
          `  if (v === undefined) return w.u8(0);\n  w.u8(1);\n  ${inner.w}(w, v, p);`,
        );
        fn(
          names.r,
          'r: Reader',
          `${T} | undefined`,
          `  const flag = r.u8();\n  if (flag > 1) throw r.fail(\`hold an optional flag of \${flag} at byte \${r.at - 1}\`);\n  return flag ? ${inner.r}(r) : undefined;`,
        );
        fn(
          names.s,
          `a: ${T} | undefined, b: ${T} | undefined`,
          'boolean',
          `  return a === undefined || b === undefined ? a === b : ${inner.s}(a, b);`,
        );
        break;
      }
      case 'map': {
        const item = field(`${id}_i`, f.of),
          V = type(f.of),
          max = f.maxSize;
        fn(
          `ids_${id}`,
          `v: ${T}, p: string`,
          'number[]',
          `  if (!(v instanceof Map)) throw new TypeError(\`\${p} must be a Map from entity id to value\`);\n  if (v.size > ${max}) throw new RangeError(\`\${p} has \${v.size} entries, over its limit of ${max}; send fewer or raise maxSize in the schema\`);\n  const keys = [...v.keys()];\n  for (const id of keys) integer(\`\${p} id\`, id, 0, 4294967295);\n  return keys.sort((x, y) => x - y);`,
        );
        fn(
          names.w,
          `w: Writer, v: ${T}, p: string`,
          'void',
          `  const keys = ids_${id}(v, p);\n  w.varint(keys.length);\n  writeIds(w, keys);\n  for (const id of keys) ${item.w}(w, v.get(id) as ${V}, \`\${p}(\${id})\`);`,
        );
        fn(
          names.r,
          'r: Reader',
          T,
          `  const n = r.count(${max}),\n    keys: number[] = [];\n  r.ids(n, keys);\n  return new Map(keys.map((id) => [id, ${item.r}(r)]));`,
        );
        fn(
          names.s,
          `a: ${T}, b: ${T}`,
          'boolean',
          `  if (a.size !== b.size) return false;\n  for (const [id, v] of a) if (!b.has(id) || !${item.s}(v, b.get(id) as ${V})) return false;\n  return true;`,
        );
        fn(
          names.dw as string,
          `w: Writer, v: ${T}, base: ${T}, p: string`,
          'void',
          `  const keys = ids_${id}(v, p);\n  const removed = [...base.keys()].filter((id) => !v.has(id)).sort((x, y) => x - y);\n  const changed = keys.filter((id) => !base.has(id) || !${item.s}(v.get(id) as ${V}, base.get(id) as ${V}));\n  w.varint(removed.length);\n  writeIds(w, removed);\n  w.varint(changed.length);\n  writeIds(w, changed);\n  for (const id of changed) {\n    const value = v.get(id) as ${V};\n    ${item.dw ? `if (base.has(id)) ${item.dw}(w, value, base.get(id) as ${V}, \`\${p}(\${id})\`);\n    else ` : ''}${item.w}(w, value, \`\${p}(\${id})\`);\n  }`,
        );
        fn(
          names.dr as string,
          `r: Reader, base: ${T}`,
          T,
          `  const removed: number[] = [],\n    changed: number[] = [];\n  r.ids(r.count(base.size), removed);\n  for (const id of removed) if (!base.has(id)) throw r.fail(\`remove entity \${id}, which the baseline lacks\`);\n  r.ids(r.count(${max}), changed);\n  const gone = new Set(removed),\n    out = new Map(base);\n  for (const id of removed) out.delete(id);\n  for (const id of changed) {\n    if (gone.has(id)) throw r.fail(\`both remove and change entity \${id}\`);\n    out.set(id, ${item.dr ? `out.has(id) ? ${item.dr}(r, out.get(id) as ${V}) : ` : ''}${item.r}(r));\n  }\n  if (out.size > ${max}) throw r.fail(\`leave \${out.size} entries, over the map limit of ${max}\`);\n  return new Map([...out].sort((x, y) => x[0] - y[0]));`,
        );
        break;
      }
      default: {
        const [min, max, write, read] = RANGES[f.type];
        fn(
          names.w,
          'w: Writer, v: number, p: string',
          'void',
          `  integer(p, v, ${lit(min)}, ${lit(max)});\n  ${write};`,
        );
        fn(names.r, 'r: Reader', 'number', `  return ${read};`);
        fn(names.s, 'a: number, b: number', 'boolean', '  return a === b;');
      }
    }
    return names;
  };
  out.push(
    `// Generated by @margoengine/netcode/generate${options.source ? ` from ${options.source}` : ''}; do not edit.`,
    '// Standalone: no imports. The bytes match @margoengine/netcode schema.encode for the same schema.',
    '',
    `/** FNV-1a hash of the normalized schema: both ends must agree. */`,
    `export const SCHEMA_HASH = ${hash};`,
    '',
  );
  const structs: string[] = [];
  for (const [name, fields] of Object.entries(json.types)) {
    const entries = Object.entries(fields),
      lines = entries.map(([key, f]) => `  ${key}${f.type === 'optional' ? '?' : ''}: ${type(f)};`);
    out.push(`export interface ${name} {\n${lines.join('\n')}\n}`, '');
    const codecs = entries.map(([key, f]) => [key, f, field(`${ident(name)}_${key}`, f)] as const),
      maskBytes = Math.ceil(entries.length / 8);
    structs.push(
      `function w_${name}(w: Writer, v: ${name}, p: string): void {\n  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Map) throw new TypeError(\`\${p} must be a ${name} object\`);\n${codecs.map(([key, , c]) => `  ${c.w}(w, v.${key}, \`\${p}.${key}\`);`).join('\n')}\n}`,
      `function r_${name}(r: Reader): ${name} {\n  const out = {} as ${name};\n${codecs
        .map(([key, f, c]) =>
          f.type === 'optional'
            ? `  {\n    const value = ${c.r}(r);\n    if (value !== undefined) out.${key} = value;\n  }`
            : `  out.${key} = ${c.r}(r);`,
        )
        .join('\n')}\n  return out;\n}`,
      `/** Whether two ${name} values encode to the same bytes. */\nexport function same${name}(a: ${name}, b: ${name}): boolean {\n  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;\n  return ${codecs.map(([key, , c]) => `${c.s}(a.${key}, b.${key})`).join(' && ')};\n}`,
      `function dw_${name}(w: Writer, v: ${name}, base: ${name}, p: string): void {\n  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Map) throw new TypeError(\`\${p} must be a ${name} object\`);\n  const mask = new Uint8Array(${maskBytes});\n${codecs.map(([key, , c], i) => `  if (!${c.s}(v.${key}, base.${key})) mask[${i >> 3}] |= ${1 << (i & 7)};`).join('\n')}\n  w.raw(mask);\n${codecs
        .map(([key, f, c], i) => {
          const write =
            c.dw && f.type !== 'optional'
              ? `${c.dw}(w, v.${key}, base.${key}, \`\${p}.${key}\`)`
              : `${c.w}(w, v.${key}, \`\${p}.${key}\`)`;
          return `  if (mask[${i >> 3}] & ${1 << (i & 7)}) ${write};`;
        })
        .join('\n')}\n}`,
      `function dr_${name}(r: Reader, base: ${name}): ${name} {\n  r.need(${maskBytes});\n  const mask = r.bytes.slice(r.at, r.at + ${maskBytes});\n  r.at += ${maskBytes};\n${entries.length & 7 ? `  if (mask[${maskBytes - 1}] >> ${entries.length & 7}) throw r.fail('set a change bit past the ${entries.length} fields of ${name}');\n` : ''}  const out = {} as ${name};\n${codecs
        .map(([key, f, c], i) => {
          const read = c.dr && f.type !== 'optional' ? `${c.dr}(r, base.${key})` : `${c.r}(r)`;
          return f.type === 'optional'
            ? `  {\n    const value = mask[${i >> 3}] & ${1 << (i & 7)} ? ${read} : base.${key};\n    if (value !== undefined) out.${key} = value;\n  }`
            : `  out.${key} = mask[${i >> 3}] & ${1 << (i & 7)} ? ${read} : base.${key};`;
        })
        .join('\n')}\n  return out;\n}`,
      `/** Bytes of a ${name}. */\nexport function encode${name}(value: ${name}): Uint8Array {\n  const w = new Writer();\n  w_${name}(w, value, '${name}');\n  return w.done();\n}`,
      `/** The ${name} in \`bytes\`; RangeError for truncated or malformed bytes. */\nexport function decode${name}(bytes: Uint8Array): ${name} {\n  const r = new Reader(bytes),\n    value = r_${name}(r);\n  r.end();\n  return value;\n}`,
      `/** Bytes of a ${name} as a change from \`baseline\`. */\nexport function encode${name}Delta(value: ${name}, baseline: ${name}): Uint8Array {\n  const w = new Writer();\n  dw_${name}(w, value, baseline, '${name}');\n  return w.done();\n}`,
      `/** The ${name} that \`encode${name}Delta(value, baseline)\` described. */\nexport function decode${name}Delta(bytes: Uint8Array, baseline: ${name}): ${name} {\n  const r = new Reader(bytes),\n    value = dr_${name}(r, baseline);\n  r.end();\n  return value;\n}`,
    );
  }
  return `${out.join('\n')}\n${RUNTIME}\n${helpers.join('\n\n')}\n\n${structs.join('\n\n')}\n`;
}
