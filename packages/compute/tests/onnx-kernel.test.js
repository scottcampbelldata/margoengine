import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from './onnx-fixtures.js';

async function runtime() {
  const bytes = await readFile(new URL('../src/onnx-kernel.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  const k = instance.exports;
  const message = () => new TextDecoder().decode(new Uint8Array(k.memory.buffer, k.message_ptr(), k.message_len()));
  const check = (n) => {
    assert.ok(n >= 0, message());
    return n;
  };
  const packet = (bytes) => {
    const ptr = k.reserve(bytes.length);
    assert.notEqual(ptr, 0xffffffff, message());
    new Uint8Array(k.memory.buffer, ptr, bytes.length).set(bytes);
  };
  const create = (kind, shape, data) => {
    packet(
      p.concat(
        new Uint8Array(Uint32Array.from(shape).buffer),
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ),
    );
    return check(k.create_tensor(kind, shape.length, shape.length * 4 + data.byteLength));
  };
  const read = (id, Type) => {
    check(k.describe(id));
    const metadata = JSON.parse(message());
    const len = k.data_len(id);
    const ptr = k.data_ptr(id);
    return { ...metadata, data: new Type(k.memory.buffer.slice(ptr, ptr + len)) };
  };
  return { k, message, check, packet, create, read };
}
test('ONNX Wasm parser and actual SIMD preserve int64, scalar broadcast, tails and retained output', async () => {
  const r = await runtime();
  const { k, check, packet, create, read } = r;
  const bytes = p.model(
    p.graph(
      [p.node('Add', ['x', 'b'], ['y'])],
      [p.valueInfo('x', 7, [5])],
      [p.valueInfo('y', 7, [5])],
      [p.tensor('b', 7, [], BigInt64Array.of(7n))],
    ),
  );
  packet(bytes);
  check(k.load_model(bytes.length));
  const meta = JSON.parse(r.message());
  const n = meta.graph.nodes[0];
  const b = meta.graph.initializers[0].id;
  const x = create(7, [5], BigInt64Array.of(9007199254740993n, -7n, 9223372036854775807n, -9223372036854775808n, 0n));
  packet(new Uint8Array(Uint32Array.of(x, b).buffer));
  assert.equal(check(k.execute(n.kernelIndex, n.attributeSet, 18, 2, 1)), 1);
  const y = k.output(0);
  const saved = read(y, BigInt64Array).data;
  assert.deepEqual([...saved], [9007199254741000n, 0n, -9223372036854775802n, -9223372036854775801n, 7n]);
  assert.equal(k.simd_groups(), 2n);
  const growth = create(1, [400000], new Float32Array(400000));
  assert.deepEqual(read(y, BigInt64Array).data, saved);
  for (const id of [x, y, growth, b]) check(k.drop_tensor(id));
  assert.equal(k.live_bytes(), 0);
  k.release();
});
test('ONNX Wasm runs f32 SIMD odd tails and isolates model instances', async () => {
  const r = await runtime();
  const q = await runtime();
  const { k, check, packet, create, read } = r;
  const bytes = p.model(p.graph([p.node('Mul', ['a', 'b'], ['y'])], [], []));
  packet(bytes);
  check(k.load_model(bytes.length));
  const n = JSON.parse(r.message()).graph.nodes[0];
  const values = Float32Array.of(0.1, 1e20, -3.5, -0, Infinity, NaN, 7, 8, 9);
  const a = create(1, [9], values);
  const b = create(1, [], Float32Array.of(2));
  packet(new Uint8Array(Uint32Array.of(a, b).buffer));
  check(k.execute(n.kernelIndex, n.attributeSet, 18, 2, 1));
  assert.deepEqual(
    read(k.output(0), Float32Array).data,
    Float32Array.from(values, (v) => v * 2),
  );
  assert.equal(k.simd_groups(), 2n);
  assert.equal(q.k.live_bytes(), 0);
  assert.equal(q.k.simd_groups(), 0n);
  k.release();
  q.k.release();
});
