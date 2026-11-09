// Independent count walk for the outside-file harness, from the PLY format description.
// Every declared element/property advances the cursor; no Margo parser or its output is used.
import assert from 'node:assert/strict';

const types = {
  char: ['getInt8', 1],
  int8: ['getInt8', 1],
  uchar: ['getUint8', 1],
  uint8: ['getUint8', 1],
  short: ['getInt16', 2],
  int16: ['getInt16', 2],
  ushort: ['getUint16', 2],
  uint16: ['getUint16', 2],
  int: ['getInt32', 4],
  int32: ['getInt32', 4],
  uint: ['getUint32', 4],
  uint32: ['getUint32', 4],
  float: ['getFloat32', 4],
  float32: ['getFloat32', 4],
  double: ['getFloat64', 8],
  float64: ['getFloat64', 8],
};

export function referencePLYFacts(bytes) {
  const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1 << 20)).toString('latin1');
  const end = /^end_header[\t ]*(?:\r\n|\n|\r)/m.exec(prefix);
  assert.ok(end, 'PLY header must end with a newline');
  const start = end.index + end[0].length;
  const header = prefix.slice(0, start);
  const format = /^format (\S+) 1\.0[\t ]*(?:\r\n|\n|\r)/m.exec(header)?.[1];
  assert.ok(['ascii', 'binary_big_endian', 'binary_little_endian'].includes(format));
  const elements = [];
  for (const line of header.split(/\r\n|\n|\r/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'element') elements.push({ name: parts[1], count: Number(parts[2]), properties: [] });
    if (parts[0] !== 'property') continue;
    const list = parts[1] === 'list';
    const property = { name: parts[list ? 4 : 2], type: parts[list ? 3 : 1], count: list ? parts[2] : undefined };
    assert.ok(types[property.type], 'known scalar width');
    if (list) assert.ok(types[property.count] && !property.count.startsWith('float') && property.count !== 'double');
    elements.at(-1).properties.push(property);
  }
  const tokens = format === 'ascii' ? new TextDecoder().decode(bytes.subarray(start)).trim().split(/\s+/) : undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start,
    token = 0,
    vertices = 0,
    triangles = 0;
  const read = (type) => {
    if (tokens) {
      assert.ok(token < tokens.length, 'complete ASCII body');
      const value = Number(tokens[token++]);
      assert.ok(Number.isFinite(value));
      return value;
    }
    const [method, size] = types[type];
    assert.ok(offset + size <= bytes.length, 'complete binary scalar');
    const value = view[method](offset, format === 'binary_little_endian');
    offset += size;
    return value;
  };
  for (const element of elements) {
    assert.ok(Number.isSafeInteger(element.count) && element.count >= 0);
    if (element.name === 'vertex') vertices += element.count;
    for (let row = 0; row < element.count; row++)
      for (const property of element.properties) {
        if (!property.count) {
          read(property.type);
          continue;
        }
        const count = read(property.count);
        assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 65536, 'valid list count');
        if (element.name === 'face' && ['vertex_index', 'vertex_indices'].includes(property.name)) {
          assert.ok(count >= 3, 'face has at least three corners');
          triangles += count - 2;
        }
        for (let i = 0; i < count; i++) read(property.type);
      }
  }
  assert.equal(tokens ? token : offset, tokens ? tokens.length : bytes.length, 'PLY walk ended at the end of the file');
  return { vertices, triangles };
}
