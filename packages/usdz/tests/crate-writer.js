// Minimal USD Crate 0.8 writer for tests: LZ4 (greedy, with matches), Usd integer coding, compressed int/float arrays,
// list ops, inline and out-of-line values. Exercises the reader paths the small OpenUSD fixture does not reach.
export function lz4(src) {
  const out = [],
    table = new Map();
  let anchor = 0,
    i = 0;
  const length = (n) => {
    while (n >= 255) {
      out.push(255);
      n -= 255;
    }
    out.push(n);
  };
  const emit = (end, match, offset) => {
    const lit = end - anchor;
    out.push((Math.min(lit, 15) << 4) | (match === undefined ? 0 : Math.min(match - 4, 15)));
    if (lit >= 15) length(lit - 15);
    for (let k = anchor; k < end; k++) out.push(src[k]);
    if (match !== undefined) {
      out.push(offset & 255, offset >> 8);
      if (match - 4 >= 15) length(match - 19);
    }
  };
  while (i + 4 <= src.length - 5) {
    const key = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24),
      prev = table.get(key);
    table.set(key, i);
    if (prev !== undefined && i - prev < 65536) {
      let n = 4;
      while (i + n < src.length - 5 && src[prev + n] === src[i + n]) n++;
      emit(i, n, i - prev);
      i += n;
      anchor = i;
    } else i++;
  }
  emit(src.length);
  return Uint8Array.from(out);
}
const fast = (bytes, chunked = false) => {
  const block = lz4(bytes);
  if (!chunked) return Buffer.concat([Buffer.from([0]), block]);
  const h = Buffer.alloc(5);
  h[0] = 1;
  h.writeInt32LE(block.length, 1);
  return Buffer.concat([h, block]);
};
export function encodeInts(values) {
  const deltas = values.map((v, i) => v - (i ? values[i - 1] : 0)),
    counts = new Map();
  for (const d of deltas) counts.set(d, (counts.get(d) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0,
    codes = Buffer.alloc((values.length * 2 + 7) >> 3),
    rest = [],
    head = Buffer.alloc(4);
  head.writeInt32LE(common);
  deltas.forEach((d, i) => {
    const code = d === common ? 0 : d >= -128 && d < 128 ? 1 : d >= -32768 && d < 32768 ? 2 : 3;
    codes[i >> 2] |= code << ((i & 3) * 2);
    if (code) {
      const b = Buffer.alloc(1 << (code - 1));
      code === 1 ? b.writeInt8(d) : code === 2 ? b.writeInt16LE(d) : b.writeInt32LE(d);
      rest.push(b);
    }
  });
  return Buffer.concat([head, codes, ...rest]);
}
const u64 = (v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  },
  u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return b;
  };
const ints = (values, chunked) => {
  const c = fast(encodeInts(values), chunked);
  return Buffer.concat([u64(c.length), c]);
};
/** specs: [{path, type (spec type), fields: {name: value}}]; values are {type, inline} or {type, array, data, compressed} built with the helpers below. */
export const V = {
  token: (s) => ({ token: s }),
  tokens: (list) => ({ tokens: list }),
  double: (v) => ({ type: 9, bytes: Buffer.from(new Float64Array([v]).buffer) }),
  inlineFloat: (v) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    return { type: 8, inline: b.readUInt32LE() };
  },
  half: (bits) => ({ type: 7, inline: bits }),
  vec3d: (v) => ({ type: 23, bytes: Buffer.from(new Float64Array(v).buffer) }),
  vec3f: (v) => ({ type: 24, bytes: Buffer.from(new Float32Array(v).buffer) }),
  inlineVec3: (v) => ({ type: 23, inline: Buffer.from(Int8Array.from(v).buffer).readUIntLE(0, 3) }),
  vec3fArray: (v) => ({
    type: 24,
    array: true,
    bytes: Buffer.concat([u64(v.length / 3), Buffer.from(new Float32Array(v).buffer)]),
  }),
  intArray: (v) => ({ type: 3, array: true, compressed: true, bytes: Buffer.concat([u64(v.length), ints(v)]) }),
  floatArrayInts: (v) => ({
    type: 8,
    array: true,
    compressed: true,
    bytes: Buffer.concat([u64(v.length), Buffer.from('i'), ints(v)]),
  }),
  floatArrayTable: (v) => {
    const table = [...new Set(v)];
    return {
      type: 8,
      array: true,
      compressed: true,
      bytes: Buffer.concat([
        u64(v.length),
        Buffer.from('t'),
        u32(table.length),
        Buffer.from(new Float32Array(table).buffer),
        ints(v.map((x) => table.indexOf(x))),
      ]),
    };
  },
  pathList: (paths, prepend = false) => ({ pathList: paths, prepend }),
  specifier: (n) => ({ type: 42, inline: n }),
  dictionary: () => ({ type: 31, inline: 0 }),
};
/** `options.jumps` rewrites the path jump table (fuzzing: hostile jump tables). */
export function writeCrate(specs, options = {}) {
  const tokens = [],
    tok = (s) => {
      let i = tokens.indexOf(s);
      if (i < 0) i = tokens.push(s) - 1;
      return i;
    },
    data = [];
  let offset = 88;
  // Path tree in depth-first order; properties are leaves with negative element tokens.
  const paths = ['/'],
    kids = new Map([['/', []]]);
  for (const { path } of specs)
    if (path !== '/') {
      const dot = path.lastIndexOf('.'),
        slash = path.lastIndexOf('/'),
        parent = dot > slash ? path.slice(0, dot) : path.slice(0, slash) || '/';
      if (!kids.has(parent)) throw new Error('parent first: ' + path);
      kids.get(parent).push(path);
      kids.set(path, []);
    }
  const order = [],
    walk = (p) => {
      order.push(p);
      kids.get(p).forEach(walk);
    };
  walk('/');
  const pathIndex = (p) => order.indexOf(p),
    siblingsAfter = (p) => {
      const parent = [...kids].find(([, c]) => c.includes(p));
      return parent ? parent[1].slice(parent[1].indexOf(p) + 1) : [];
    };
  const element = (p) => {
    if (p === '/') return 0;
    const dot = p.lastIndexOf('.'),
      slash = p.lastIndexOf('/');
    return dot > slash ? -tok(p.slice(dot + 1)) : tok(p.slice(slash + 1));
  };
  let jumps = order.map((p, i) => {
    const child = kids.get(p).length > 0,
      next = siblingsAfter(p)[0];
    return child && next ? order.indexOf(next) - i : child ? -1 : next ? 0 : -2;
  });
  if (options.jumps) jumps = options.jumps(jumps);
  const rep = (v) => {
    const type = v.token !== undefined ? 11 : v.tokens ? 41 : v.pathList ? 34 : v.type;
    if (v.token !== undefined) return (1n << 62n) | (11n << 48n) | BigInt(tok(v.token));
    if (v.inline !== undefined) return (1n << 62n) | (BigInt(type) << 48n) | BigInt(v.inline);
    const bytes = v.tokens
      ? Buffer.concat([u64(v.tokens.length), ...v.tokens.map((t) => u32(tok(t)))])
      : v.pathList
        ? Buffer.concat([
            Buffer.from([v.prepend ? 32 : 3]),
            u64(v.pathList.length),
            ...v.pathList.map((p) => u32(pathIndex(p))),
          ])
        : v.bytes;
    const at = offset;
    data.push(bytes);
    offset += bytes.length;
    return (v.array ? 1n << 63n : 0n) | (v.compressed ? 1n << 61n : 0n) | (BigInt(type) << 48n) | BigInt(at);
  };
  const fields = [],
    fieldSets = [],
    specRows = [];
  for (const s of specs) {
    const start = fieldSets.length;
    for (const [name, v] of Object.entries(s.fields)) {
      fields.push([tok(name), rep(v)]);
      fieldSets.push(fields.length - 1);
    }
    fieldSets.push(-1);
    specRows.push([pathIndex(s.path), start, s.type]);
  }
  order.forEach(element);
  const raw = Buffer.from(tokens.join('\0') + '\0'),
    packed = fast(raw),
    repBytes = Buffer.concat(fields.map(([, r]) => u64(r))),
    repPacked = fast(repBytes, true);
  const sections = [
    ['TOKENS', Buffer.concat([u64(tokens.length), u64(raw.length), u64(packed.length), packed])],
    ['STRINGS', u64(0)],
    ['FIELDS', Buffer.concat([u64(fields.length), ints(fields.map((f) => f[0])), u64(repPacked.length), repPacked])],
    ['FIELDSETS', Buffer.concat([u64(fieldSets.length), ints(fieldSets)])],
    [
      'PATHS',
      Buffer.concat([
        u64(order.length),
        u64(order.length),
        ints(order.map((_, i) => i)),
        ints(order.map(element)),
        ints(jumps),
      ]),
    ],
    [
      'SPECS',
      Buffer.concat([
        u64(specRows.length),
        ints(specRows.map((r) => r[0])),
        ints(
          specRows.map((r) => r[1]),
          true,
        ),
        ints(specRows.map((r) => r[2])),
      ]),
    ],
  ];
  const body = [],
    toc = [u64(sections.length)];
  for (const [name, bytes] of sections) {
    const n = Buffer.alloc(16);
    n.write(name);
    toc.push(n, u64(offset), u64(bytes.length));
    body.push(bytes);
    offset += bytes.length;
  }
  const head = Buffer.alloc(88);
  head.write('PXR-USDC');
  head[9] = 8;
  head.writeBigUInt64LE(BigInt(offset), 16);
  return Buffer.concat([head, ...data, ...body, ...toc]);
}
