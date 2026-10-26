// Behaviour of the machinery entries that other tests only reach through the index: kinematics, surface, telemetry,
// materials, metrology and overlays, imported by their own subpath the way an app does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, Geometry } from '../../core/dist/extension.js';
import { Kinematics } from '@margoengine/machinery/kinematics';
import { SurfacePhysics } from '@margoengine/machinery/surface';
import { TelemetryChannel } from '@margoengine/machinery/telemetry';
import { industrialMaterial, industrialMaterials } from '@margoengine/machinery/materials';
import { vertexAnchor, edgeAnchor, faceAnchor, holeAnchor, measureDistance } from '@margoengine/machinery/metrology';
import { EngineeringAnnotations, projectAnnotation } from '@margoengine/machinery/overlays';

async function scene(capacity = 16) {
  return new Engine(
    { width: 200, height: 200, clientWidth: 200, clientHeight: 200 },
    await TransformStore.create(capacity),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function frame(time, entries) {
  const data = new ArrayBuffer(6 + entries.length * 6),
    view = new DataView(data);
  view.setUint32(0, time, true);
  view.setUint16(4, entries.length, true);
  entries.forEach(([id, value], i) => {
    view.setUint16(6 + i * 6, id, true);
    view.setFloat32(8 + i * 6, value, true);
  });
  return data;
}

test('kinematics: a gear coupling drives its target and rejects values outside the limits', async () => {
  const e = await scene();
  try {
    const a = e.createMesh(),
      b = e.createMesh(),
      k = Kinematics.attach(
        e,
        [
          { node: a, axis: 'z', min: -1, max: 1 },
          { node: b, axis: 'z', min: -2, max: 2 },
        ],
        { gears: [{ source: 0, target: 1, ratio: 2 }] },
      );
    assert.equal(k.jointCount, 2);
    assert.ok(k.isDriven(1));
    k.setValue(0, 0.5);
    near(k.value(0), 0.5);
    near(k.value(1), 1);
    assert.throws(() => k.setValue(0, 1.5), RangeError);
    assert.throws(() => k.setValue(1, 0), RangeError, 'a driven joint cannot be set');
    near(k.value(1), 1, 1e-6);
    assert.throws(() => k.setValues([0]), { name: 'RangeError', message: /exactly one value per joint/ });
  } finally {
    e.dispose();
  }
});

test('kinematics: setup errors name the fix and use the documented classes and codes', async () => {
  const e = await scene();
  try {
    const a = e.createMesh(),
      b = e.createMesh(),
      joints = [
        { node: a, axis: 'z', min: -1, max: 1 },
        { node: b, axis: 'z', min: -1, max: 1 },
      ];
    assert.throws(() => new Kinematics(joints, { iterations: 0 }), RangeError);
    const cycle = new Kinematics(joints, {
      gears: [
        { source: 0, target: 1, ratio: 1 },
        { source: 1, target: 0, ratio: 1 },
      ],
    });
    assert.throws(() => e.use(cycle), { name: 'MargoError', code: 'state', message: /Couplings form a cycle/ });
    const zeroRatio = new Kinematics(joints, { gears: [{ source: 0, target: 1, ratio: 0 }] });
    assert.throws(() => e.use(zeroRatio), { name: 'TypeError', message: /non-zero/ });
    const detached = new Kinematics(joints);
    assert.throws(() => detached.solve(), { name: 'MargoError', code: 'state' });
    assert.throws(() => detached.value(0), { name: 'MargoError', code: 'state' });
    const other = await scene();
    try {
      e.use(detached);
      assert.throws(() => detached.setExternalControl(other), { name: 'MargoError', code: 'attached' });
    } finally {
      other.dispose();
    }
  } finally {
    e.dispose();
  }
});

test('surface: a belt carries a part along its velocity, and misuse throws coded errors', async () => {
  const e = await scene();
  try {
    const belt = e.createMesh(),
      part = e.createMesh(),
      surface = await SurfacePhysics.create(
        [{ node: part, carrier: 0, lane: 0, axis: [1, 0, 0], halfLength: 0.2, friction: 0.5 }],
        [{ node: belt, velocity: [1, 0, 0] }],
      );
    assert.throws(() => surface.onPreUpdate(0.1), { name: 'MargoError', code: 'state' });
    e.use(surface);
    for (let i = 0; i < 10; i++) surface.onPreUpdate(0.1);
    assert.ok(part.position.x > 0, `part moved along the belt: ${part.position.x}`);
    assert.throws(() => surface.setCarrier(0, 5), { name: 'RangeError', message: /exist/ });
    await assert.rejects(SurfacePhysics.create('parts', []), TypeError);
    await assert.rejects(SurfacePhysics.create([], []), RangeError);
    surface.dispose?.();
  } finally {
    e.dispose();
  }
});

test('telemetry: frames drive the kinematics joints, bad frames throw RangeError, an unattached channel throws a coded error', async () => {
  const e = await scene();
  try {
    const node = e.createMesh(),
      k = Kinematics.attach(e, [{ node, axis: 'z', min: -1, max: 1 }]),
      channel = await TelemetryChannel.create(k, { delay: 100 });
    assert.throws(() => channel.push(frame(1000, [[0, 0]]), 0), { name: 'MargoError', code: 'state' });
    e.use(channel);
    assert.ok(channel.push(frame(1000, [[0, 0]]), 100));
    assert.ok(channel.push(frame(1100, [[0, 0.2]]), 200));
    channel.sample(300);
    near(k.value(0), 0.2);
    assert.throws(() => channel.push(new ArrayBuffer(3), 300), { name: 'RangeError', message: /6-byte header/ });
    assert.throws(() => channel.push(frame(1200, [[4, 0]]), 300), {
      name: 'RangeError',
      message: /out of range or repeated/,
    });
    assert.throws(() => channel.push(frame(1200, [[0, 5]]), 300), RangeError);
    assert.throws(() => channel.push(frame(1200, [[0, 0]]), Number.NaN), RangeError);
    channel.dispose();
    await assert.rejects(TelemetryChannel.create(new Kinematics([]), {}), RangeError);
  } finally {
    e.dispose();
  }
});

test('materials: presets build a metal or rubber PBR material and a colour replaces the preset colour', () => {
  assert.deepEqual(Object.keys(industrialMaterials), [
    'machinedSteel',
    'carbonSteel',
    'galvanizedZinc',
    'anodizedAluminum',
    'coloredAnodizedAluminum',
    'neoprene',
    'powderCoat',
  ]);
  const steel = industrialMaterial('machinedSteel'),
    red = industrialMaterial('machinedSteel', '#ff0000'),
    rubber = industrialMaterial('neoprene');
  assert.notDeepEqual(Array.from(steel.data), Array.from(rubber.data), 'presets differ');
  assert.notDeepEqual(Array.from(steel.data), Array.from(red.data), 'colour override changes the material');
  assert.deepEqual(Array.from(industrialMaterial('machinedSteel').data), Array.from(steel.data), 'deterministic');
  assert.throws(() => industrialMaterial('gold'), { name: 'TypeError', message: /choose one of/ });
  assert.throws(() => {
    industrialMaterials.neoprene.roughness = 0;
  }, TypeError);
});

test('metrology: anchors sit on vertices, edge midpoints, face centroids and hole centres; units scale the distance', async () => {
  const e = await scene();
  try {
    // A unit right triangle in the XY plane (the fourth vertex is unused).
    const geometry = new Geometry(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 1, 2],
    );
    const node = e.createMesh().setGeometry(geometry);
    e.render();
    const a = vertexAnchor(node, 0),
      b = vertexAnchor(node, 1);
    assert.deepEqual(a.point, [0, 0, 0]);
    near(measureDistance(a, b, 'm'), 1);
    near(measureDistance(a, b, 'mm'), 1000);
    near(measureDistance(a, b, 'in'), 1 / 0.0254);
    near(measureDistance(a, b, 'm', 0.001), 0.001);
    const mid = edgeAnchor(node, 0, 1);
    assert.deepEqual(mid.point, [0.5, 0, 0]);
    const face = faceAnchor(node, 0);
    near(face.point[0], 1 / 3);
    near(face.point[1], 1 / 3);
    assert.throws(() => vertexAnchor(node, 9), { name: 'RangeError', message: /below the vertex count/ });
    assert.throws(() => edgeAnchor(node, 1, 1), RangeError);
    assert.throws(() => faceAnchor(node, 1), { name: 'RangeError', message: /below the triangle count/ });
    assert.throws(() => holeAnchor(node, [0, 1], 1e-5), { name: 'RangeError', message: /between 3 and 4096/ });
    assert.throws(() => holeAnchor(node, [0, 1, 2], 0), RangeError);
    assert.throws(() => measureDistance(a, b, 'cm'), { name: 'RangeError', message: /'mm', 'in' or 'm'/ });
    assert.throws(() => measureDistance(a, b, 'm', 0), RangeError);
  } finally {
    e.dispose();
  }
});

test('overlays: projectAnnotation maps clip space to pixels, culls behind the camera, and options are validated', () => {
  const identity = { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  assert.deepEqual(projectAnnotation(identity, [0, 0, 0.5], 200, 100), [100, 50]);
  assert.deepEqual(projectAnnotation(identity, [1, 1, 0.5], 200, 100), [200, 0]);
  assert.equal(projectAnnotation(identity, [0, 0, -0.5], 200, 100), null, 'WebGPU clip depth starts at 0');
  assert.deepEqual(
    projectAnnotation(identity, [0, 0, -0.5], 200, 100, false),
    [100, 50],
    'WebGL clip depth starts at -1',
  );
  assert.equal(projectAnnotation(identity, [0, 0, 2], 200, 100), null, 'past the far plane');
  assert.throws(() => new EngineeringAnnotations({ scale: 0 }), { name: 'RangeError', message: /scale above 0/ });
  assert.throws(() => new EngineeringAnnotations({ decimals: 7 }), RangeError);
  assert.equal(new EngineeringAnnotations({ decimals: 3 }).name, 'engineering-annotations');
});
