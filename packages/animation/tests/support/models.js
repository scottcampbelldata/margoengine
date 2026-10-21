// glTF-pro models on a WebGPU-less engine (no engine.use, whose setup needs a device), for CPU-side animation tests.
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../../gltf-pro/dist/index.js';

export async function engine(capacity = 256) {
  return new Engine(
    { width: 1, height: 1, getContext() {} },
    await TransformStore.create(capacity),
    { backend: 'webgl2', add() {}, remove() {}, dispose() {}, render() {} },
    undefined,
    null,
  );
}
export const model = (engine, { doc, buffers }) => new PBRModel(engine, new GLTFAsset(doc, buffers));
/** A model read back from a GLB, as the raw-rig round trip does. */
export function fromGLB(engine, glb) {
  const view = new DataView(glb.buffer, glb.byteOffset),
    json = view.getUint32(12, true);
  return new PBRModel(
    engine,
    new GLTFAsset(
      JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + json))),
      [],
      glb.subarray(28 + json, 28 + json + view.getUint32(20 + json, true)),
    ),
  );
}
/** A node's local quaternion as stored. */
export function quaternion(node) {
  const t = node.engine.store.transforms,
    id = node.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
}
export function position(node) {
  const t = node.engine.store.transforms,
    id = node.id;
  return [t.x[id], t.y[id], t.z[id]];
}
export const near = (actual, expected, tolerance = 1e-6, label = '') => {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${label} [${i}] ${actual[i]} != ${expected[i]}`);
};
/** Quaternion [x, y, z, w] of `degrees` about the unit axis. */
export const axisAngle = (axis, degrees) => {
  const h = (degrees * Math.PI) / 360,
    s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
};
/** Same rotation (q and -q are equal). */
export const sameRotation = (a, b, tolerance = 1e-6, label = '') => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  assert.ok(Math.abs(d - 1) <= tolerance, `${label} rotations differ: ${a} vs ${b}`);
};
