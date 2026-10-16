import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { build } from 'vite';

// Exercise the internal front ends without adding parser internals to the public API.
const bundled = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    minify: false,
    target: 'es2022',
    lib: { entry: fileURLToPath(new URL('../src/document.ts', import.meta.url)), formats: ['es'] },
  },
});
const source = (Array.isArray(bundled) ? bundled[0] : bundled).output.find((output) => output.type === 'chunk').code;
const { parseDocument, array, property, objectName, findChild, id, ParseBudget } = await import(
  `data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=margo-fbx-reader-test.js`).toString('base64')}`
);
const encode = (text) => new TextEncoder().encode(text);
const ascii = `; FBX 7.4.0 reader fixture
FBXHeaderExtension: { FBXVersion: 7400 }
Objects: {
 Geometry: 1, "Geometry::Triangle", "Mesh" {
  Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
  PolygonVertexIndex: *3 { a: 0,1,-3 }
 }
 Model: 2, "Model::Triangle", "Mesh" {
  Properties70: {
   P: "Lcl Translation", "Lcl Translation", "", "A", 1,2,3
   P: "Visibility", "Visibility", "", "A", 1
  }
 }
}
Connections: {
 C: "OO",1,2
 C: "OO",2,0
}
`;

const string = (value) => {
  const bytes = Buffer.from(value),
    header = Buffer.alloc(5);
  header[0] = 83;
  header.writeUInt32LE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
};
const long = (value) => {
  const bytes = Buffer.alloc(9);
  bytes[0] = 76;
  bytes.writeBigInt64LE(BigInt(value), 1);
  return bytes;
};
function values(
  type,
  entries,
  { compressed = false, count = entries.length, encoding = compressed ? 1 : 0, payload } = {},
) {
  const width = type === 'd' || type === 'l' ? 8 : type === 'b' ? 1 : 4;
  const raw = Buffer.alloc(entries.length * width);
  for (let i = 0; i < entries.length; i++) {
    if (type === 'd') raw.writeDoubleLE(entries[i], i * width);
    else if (type === 'f') raw.writeFloatLE(entries[i], i * width);
    else if (type === 'l') raw.writeBigInt64LE(BigInt(entries[i]), i * width);
    else if (type === 'b') raw[i] = entries[i];
    else raw.writeInt32LE(entries[i], i * width);
  }
  const data = payload ?? (compressed ? deflateSync(raw) : raw),
    header = Buffer.alloc(13);
  header[0] = type.charCodeAt(0);
  header.writeUInt32LE(count, 1);
  header.writeUInt32LE(encoding, 5);
  header.writeUInt32LE(data.length, 9);
  return Buffer.concat([header, data]);
}
const geometry = (
  properties = [
    ['Vertices', [values('d', [0, 0, 0, 1, 0, 0, 0, 1, 0])], []],
    ['PolygonVertexIndex', [values('i', [0, 1, -3])], []],
  ],
) => ['Geometry', [long(1), string('Geometry::Triangle'), string('Mesh')], properties];
const model = (value) => ['Model', [long(value), string(`Model::Node${value}`), string('Null')], []];
const connection = (child, parent, kind = 'OO', name) => [
  'C',
  [string(kind), long(child), long(parent), ...(name ? [string(name)] : [])],
  [],
];
const roots = (children = [geometry(), model(2)], connections = [connection(1, 2), connection(2, 0)]) => [
  ['Objects', [], children],
  ['Connections', [], connections],
];
function binary(nodes = roots(), version = 7400) {
  const size = version >= 7500 ? 25 : 13;
  function node([name, properties, children], offset) {
    const text = Buffer.from(name),
      payload = Buffer.concat(properties),
      parts = [];
    let end = offset + size + text.length + payload.length;
    for (const child of children) {
      const part = node(child, end);
      parts.push(part);
      end += part.length;
    }
    if (children.length) {
      parts.push(Buffer.alloc(size));
      end += size;
    }
    const header = Buffer.alloc(size);
    for (const [index, value] of [end, properties.length, payload.length].entries()) {
      if (size === 25) header.writeBigUInt64LE(BigInt(value), index * 8);
      else header.writeUInt32LE(value, index * 4);
    }
    header[size - 1] = text.length;
    return Buffer.concat([header, text, payload, ...parts]);
  }
  const header = Buffer.alloc(27);
  header.write('Kaydara FBX Binary  \0\x1a\0');
  header.writeUInt32LE(version, 23);
  const parts = [header];
  let offset = 27;
  for (const entry of nodes) {
    const part = node(entry, offset);
    parts.push(part);
    offset += part.length;
  }
  parts.push(Buffer.alloc(size));
  return Buffer.concat(parts);
}

test('ASCII and binary 7400/7500 lower to the same indexed document', async () => {
  for (const bytes of [encode(ascii), binary(), binary(roots(), 7500)]) {
    const doc = await parseDocument(bytes);
    assert.equal(doc.objects.size, 2);
    assert.deepEqual([...array(doc.objects.get(1n), 'Vertices')], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.ok(array(doc.objects.get(1n), 'Vertices') instanceof Float64Array);
    assert.ok(array(doc.objects.get(1n), 'PolygonVertexIndex') instanceof Int32Array);
    assert.deepEqual(doc.connections, [
      { kind: 'OO', child: 1n, parent: 2n },
      { kind: 'OO', child: 2n, parent: 0n },
    ]);
  }
  const doc = await parseDocument(encode(ascii));
  assert.deepEqual(property(doc.objects.get(2n), 'Lcl Translation'), [1, 2, 3]);
  assert.equal(property(doc.objects.get(2n), 'Visibility'), 1);
  assert.equal(property(doc.objects.get(2n), 'Absent', 9), 9);
  assert.equal(objectName(doc.objects.get(1n)), 'Triangle');
  assert.equal(findChild(doc.objects.get(1n), 'Unknown'), undefined);
});

test('deflate arrays use 32-bit count/encoding/length headers in both binary versions', async () => {
  for (const version of [7400, 7500, 7700]) {
    const doc = await parseDocument(
      binary(
        roots([
          geometry([
            ['Vertices', [values('d', [0, 0, 0, 1, 0, 0, 0, 1, 0], { compressed: true })], []],
            ['PolygonVertexIndex', [values('i', [0, 1, -3], { compressed: true })], []],
          ]),
          model(2),
        ]),
        version,
      ),
    );
    assert.deepEqual([...array(doc.objects.get(1n), 'Vertices')], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual([...array(doc.objects.get(1n), 'PolygonVertexIndex')], [0, 1, -3]);
  }
});

test('signed int64 ids and key ticks are exact, including an offset byte view', async () => {
  const large = 9007199254740993n,
    tick = 9223372036854775807n;
  const text = ascii
    .replace('Model: 2,', `Model: ${large},`)
    .replace('C: "OO",1,2', `C: "OO",1,${large}`)
    .replace('C: "OO",2,0', `C: "OO",${large},0`)
    .replace('  Properties70:', `  KeyTime: *2 { a: -1,${tick} }\n  Properties70:`);
  const bin = binary(
    roots(
      [
        geometry(),
        [
          'Model',
          [long(large), string('Node\0\x01Model'), string('Null')],
          [['KeyTime', [values('l', [-1n, tick])], []]],
        ],
      ],
      [connection(1, large), connection(large, 0)],
    ),
  );
  for (const bytes of [encode(text), bin]) {
    const padded = new Uint8Array(bytes.length + 17);
    padded.set(bytes, 7);
    const doc = await parseDocument(new DataView(padded.buffer, 7, bytes.length));
    assert.ok(doc.objects.has(large));
    assert.deepEqual([...findChild(doc.objects.get(large), 'KeyTime').properties[0]], [-1n, tick]);
  }
  assert.equal(objectName((await parseDocument(bin)).objects.get(large)), 'Node');
  assert.equal(id(-9223372036854775808n), -9223372036854775808n);
  assert.throws(() => id(Number(large)), /exact integer/);
  assert.throws(() => id(9223372036854775808n), /int64/);
});

test('ASCII supports comments, quoted escapes, scientific values, and direct properties', async () => {
  const text = ascii
    .replace('"Model::Triangle"', '"Model::A \\\"quoted\\\" name"')
    .replace('  Properties70:', '  Custom: 1e-3 ; comment\n  Properties70:')
    .replace('Geometry: 1,', 'Geometry: 1, ; continued properties\r\n')
    .replace('"Mesh" {\n  Vertices', '"Mesh"\r\n {\n  Vertices')
    .replace('0,0,0,1,0,0,0,1,0', '0,0,0, ; comment in an array\r\n1,0,0,\n0,1,0');
  const doc = await parseDocument(encode(text));
  assert.equal(objectName(doc.objects.get(2n)), 'A "quoted" name');
  assert.equal(property(doc.objects.get(2n), 'Custom'), 0.001);
});

test('document indexing rejects duplicate ids, absent references, and model cycles', async () => {
  const invalids = [
    [roots([geometry(), model(1)]), /duplicate/],
    [roots(undefined, [connection(1, 99)]), /missing connection/],
    [roots(undefined, [connection(99, 0)]), /missing connection/],
    [roots([geometry(), model(2), model(3)], [connection(2, 3), connection(3, 2)]), /cycle/],
  ];
  for (const [nodes, expected] of invalids) await assert.rejects(parseDocument(binary(nodes)), expected);
  await assert.rejects(parseDocument(encode(ascii.replace('Model: 2,', 'Model: 1,'))), /duplicate/);
  await assert.rejects(parseDocument(encode(ascii.replace('C: "OO",1,2', 'C: "OO",1,99'))), /missing connection/);
});

test('binary record bounds, sentinels, header integers, array sizes, and encodings are checked', async () => {
  const truncated = binary().subarray(0, binary().length - 1);
  const badEnd = binary();
  badEnd.writeUInt32LE(badEnd.length + 1, 27);
  const badProperties = binary();
  badProperties.writeUInt32LE(1, 35);
  const unsafe = binary(roots(), 7500);
  unsafe.writeBigUInt64LE(9007199254740992n, 27);
  for (const bytes of [truncated, badEnd, badProperties, unsafe])
    await assert.rejects(parseDocument(bytes), /Invalid FBX/);
  for (const options of [
    { count: 10 },
    { encoding: 2 },
    { compressed: true, payload: Buffer.from('invalid zlib') },
    { compressed: true, count: 1 },
    { compressed: true, count: 20 },
  ]) {
    const nodes = roots([geometry([['Vertices', [values('d', [0, 1, 2], options)], []]]), model(2)]);
    await assert.rejects(parseDocument(binary(nodes)), /Invalid FBX/);
  }
  const huge = roots([geometry([['Vertices', [values('d', [], { count: 0xffffffff })], []]]), model(2)]);
  await assert.rejects(parseDocument(binary(huge)), /decoded array byte budget/);
});

test('ASCII counts, incomplete syntax, versions, and unsafe integers reject predictably', async () => {
  for (const text of [
    ascii.replace('*9', '*10'),
    ascii.replace('*9', '*1'),
    ascii.replace('0,0,0,1', '0 0,0,1'),
    ascii.replace('"Mesh"', '"Mesh'),
    ascii.replace('7400', '7300'),
    ascii.replace('Model: 2,', 'Model: 9223372036854775808,'),
  ]) {
    await assert.rejects(parseDocument(encode(text)), /Invalid FBX/);
  }
  await assert.rejects(parseDocument(encode(ascii.replace('*9', '*4294967295'))), /decoded array byte budget/);
  let deep = 'Leaf: 1';
  for (let i = 0; i < 66; i++) deep = `Nested: {\n${deep}\n}`;
  await assert.rejects(parseDocument(encode(`Objects: {\n${deep}\n}`)), /node budget/);
});

test('cumulative decoded allocation limits apply across compressed arrays', async () => {
  const raw = Buffer.alloc(8_000_000),
    compressed = deflateSync(raw),
    data = values('d', [], { count: 1_000_000, compressed: true, payload: compressed });
  const nodes = roots([geometry(Array.from({ length: 9 }, (_, index) => [`Unknown${index}`, [data], []])), model(2)]);
  await assert.rejects(parseDocument(binary(nodes)), /decoded.*byte budget/);
  // Byte arrays reuse the inflated allocation, so this isolates the 64 MiB
  // cumulative array limit from the separate 128 MiB allocation limit.
  const byteData = values('b', [], { count: raw.length, compressed: true, payload: compressed });
  await assert.rejects(
    parseDocument(
      binary(roots([geometry(Array.from({ length: 9 }, (_, index) => [`Raw${index}`, [byteData], []])), model(2)])),
    ),
    /decoded array byte budget/,
  );
  const budget = new ParseBudget();
  budget.array(64 * 1024 * 1024);
  assert.throws(() => budget.array(1), /decoded array byte budget/);
});

test('supported version endpoints and malformed compressed payloads are explicit', async () => {
  assert.equal((await parseDocument(encode(ascii.replace('7400', '7700')))).version, 7700);
  for (const version of [7300, 7701]) {
    await assert.rejects(parseDocument(binary(roots(), version)), /unsupported version/);
    await assert.rejects(parseDocument(encode(ascii.replace('7400', String(version)))), /unsupported version/);
  }
  await assert.rejects(
    parseDocument(encode(ascii.replace('FBXVersion: 7400', 'FBXVersion: "invalid"'))),
    /invalid ASCII version/,
  );
  const raw = Buffer.alloc(24),
    compressed = deflateSync(raw);
  for (const payload of [
    compressed.subarray(0, compressed.length - 1),
    Buffer.concat([compressed, Buffer.from('junk')]),
  ])
    await assert.rejects(
      parseDocument(
        binary(
          roots([geometry([['Vertices', [values('d', [], { count: 3, compressed: true, payload })], []]]), model(2)]),
        ),
      ),
      /Invalid FBX/,
    );
});

test('abort reasons are preserved before and during asynchronous parsing', async () => {
  const reason = new Error('stop reader');
  await assert.rejects(parseDocument(binary(), AbortSignal.abort(reason)), (error) => error === reason);
  const controller = new AbortController(),
    pending = parseDocument(binary(), controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  const large = values('d', [], { count: 1_000_000, compressed: true, payload: deflateSync(Buffer.alloc(8_000_000)) });
  const inflating = new AbortController(),
    inflation = parseDocument(binary(roots([geometry([['Vertices', [large], []]]), model(2)])), inflating.signal);
  const timer = setTimeout(() => inflating.abort(reason), 0);
  try {
    await assert.rejects(inflation, (error) => error === reason);
  } finally {
    clearTimeout(timer);
  }
  const bomb = values('d', [], { count: 1, compressed: true, payload: deflateSync(Buffer.alloc(8_000_000)) });
  await assert.rejects(
    parseDocument(binary(roots([geometry([['Vertices', [bomb], []]]), model(2)]))),
    /exceeds declared array size/,
  );
});
