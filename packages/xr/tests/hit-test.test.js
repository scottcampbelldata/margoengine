// AR hit testing against a fake session with the WebXR Hit Test Module's shapes: sources from the viewer, an input
// source and transient input, results as poses in the reference space, cancellation and the error cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HitTest } from '../dist/index.js';

const pose = (x, y, z, q = [0, 0, 0, 1]) => ({
  transform: {
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]),
    inverse: { matrix: new Float32Array(16) },
    position: { x, y, z, w: 1 },
    orientation: { x: q[0], y: q[1], z: q[2], w: q[3] },
  },
  emulatedPosition: false,
});
const space = { reference: true };
class Session extends EventTarget {
  enabledFeatures = ['webgpu', 'local', 'hit-test'];
  inputSources = [];
  requests = [];
  cancelled = 0;
  async requestReferenceSpace(type) {
    return { type };
  }
  async requestHitTestSource(options) {
    this.requests.push(options);
    return { kind: 'space', cancel: () => this.cancelled++ };
  }
  async requestHitTestSourceForTransientInput(options) {
    this.requests.push(options);
    return { kind: 'transient', cancel: () => this.cancelled++ };
  }
}
const result = (p, anchor) => ({
  getPose: (base) => (base === space ? p : null),
  ...(anchor && { createAnchor: async () => ({ anchorSpace: {}, delete() {} }) }),
});
const frameOf = (session, results, transient = []) => ({
  session,
  getHitTestResults: (source) => (source.kind === 'space' ? results : []),
  getHitTestResultsForTransientInput: (source) => (source.kind === 'transient' ? transient : []),
});

test('a viewer hit test returns poses in the reference space, nearest first', async () => {
  const session = new Session(),
    xr = { session, referenceSpace: space },
    hits = await HitTest.create(xr);
  assert.deepEqual(session.requests[0].space, { type: 'viewer' });
  assert.deepEqual(session.requests[0].entityTypes, ['plane']);
  assert.equal('offsetRay' in session.requests[0], false);
  const frame = frameOf(session, [result(pose(0, 0, -1.5), true), result(null), result(pose(0, 0, -3))]);
  const list = hits.results(frame);
  assert.equal(list.length, 2, 'results without a pose in the space are left out');
  assert.deepEqual(list[0].position, [0, 0, -1.5]);
  assert.deepEqual(list[0].orientation, [0, 0, 0, 1]);
  assert.equal(list[0].matrix[14], -1.5);
  assert.deepEqual(hits.first(frame).position, [0, 0, -1.5]);
  const anchor = await hits.anchor(list[0]);
  assert.ok(anchor.anchorSpace);
  await assert.rejects(hits.anchor(list[1]), { name: 'MargoError', code: 'unsupported' });
  assert.deepEqual(hits.results({ ...frame, session: new Session() }), [], "another session's frame");
  assert.deepEqual(hits.results(frameOf(session, [])), [], 'no surface found yet');
});

test('input-source and transient-input sources, entity types and offset rays', async () => {
  const session = new Session(),
    xr = { session, referenceSpace: space },
    controller = { targetRaySpace: { ray: 1 }, handedness: 'right', targetRayMode: 'tracked-pointer', profiles: [] };
  globalThis.XRRay = class {
    constructor(origin, direction) {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      this.origin = origin;
      this.direction = { x: direction.x / length, y: direction.y / length, z: direction.z / length, w: 0 };
    }
  };
  try {
    await HitTest.create(xr, {
      from: controller,
      entityTypes: ['plane', 'point'],
      offsetRay: { origin: [0, 0.1, 0], direction: [0, -2, 0] },
    });
    const request = session.requests[0];
    assert.equal(request.space, controller.targetRaySpace);
    assert.deepEqual(request.entityTypes, ['plane', 'point']);
    assert.deepEqual(request.offsetRay.origin, { x: 0, y: 0.1, z: 0, w: 1 });
    assert.deepEqual(request.offsetRay.direction, { x: 0, y: -1, z: 0, w: 0 });
  } finally {
    delete globalThis.XRRay;
  }
  const taps = await HitTest.create(xr, { from: { profile: 'generic-touchscreen' } });
  assert.equal(session.requests[1].profile, 'generic-touchscreen');
  const tap = { handedness: 'none', targetRayMode: 'screen', targetRaySpace: {}, profiles: ['generic-touchscreen'] },
    list = taps.results(frameOf(session, [], [{ inputSource: tap, results: [result(pose(1, 0, -2, [0, 1, 0, 0]))] }]));
  assert.equal(list.length, 1);
  assert.equal(list[0].inputSource, tap);
  assert.deepEqual(list[0].orientation, [0, 1, 0, 0]);
});

test('cancel and the session ending stop the source; errors name the fix', async () => {
  const session = new Session(),
    xr = { session, referenceSpace: space },
    hits = await HitTest.create(xr);
  assert.equal(hits.active, true);
  hits.cancel();
  hits.cancel();
  assert.equal(session.cancelled, 1);
  assert.equal(hits.active, false);
  assert.deepEqual(hits.results(frameOf(session, [result(pose(0, 0, -1))])), []);
  const other = await HitTest.create(xr, { from: { profile: 'generic-touchscreen' } });
  session.dispatchEvent(new Event('end'));
  assert.equal(other.active, false);
  assert.equal(session.cancelled, 2);

  await assert.rejects(HitTest.create({ session: null, referenceSpace: undefined }), { code: 'state' });
  const plain = new Session();
  plain.enabledFeatures = ['webgpu', 'local'];
  await assert.rejects(HitTest.create({ session: plain, referenceSpace: space }), {
    code: 'unsupported',
    message: /'hit-test' feature/,
  });
  const old = new Session();
  old.requestHitTestSource = undefined;
  await assert.rejects(HitTest.create({ session: old, referenceSpace: space }), { code: 'unsupported' });
  await assert.rejects(HitTest.create(xr, { entityTypes: ['floor'] }), TypeError);
  await assert.rejects(HitTest.create(xr, { entityTypes: [] }), TypeError);
  await assert.rejects(HitTest.create(xr, { from: 'eyes' }), TypeError);
  await assert.rejects(HitTest.create(xr, { from: { profile: '' } }), TypeError);
  await assert.rejects(HitTest.create(xr, { offsetRay: { direction: [0, 0, 0] } }), RangeError);
  await assert.rejects(HitTest.create(xr, { offsetRay: { origin: [0, 0, 0] } }), { code: 'unsupported' }, 'no XRRay');
});
