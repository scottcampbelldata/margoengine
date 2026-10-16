import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Camera } from '../packages/core/dist/camera.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { mapArmControl } from '../examples/skinning-ik/arm-controls.ts';

function asset(name) {
  const bytes = readFileSync(new URL(`../examples/assets/${name}.glb`, import.meta.url)),
    jsonLength = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  return new GLTFAsset(doc, [bytes.subarray(28 + jsonLength)]);
}

test('Workshop camera contains the full held orb on every arm track and the authored robot across viewport shapes', () => {
  // Read the camera actually used by initial load, Workshop, and Reset. Importing
  // main would start the scene; this deliberately reads only its literal settings.
  const source = readFileSync(new URL('../examples/skinning-ik/main.ts', import.meta.url), 'utf8'),
    settings = source.match(/const homeEye:\s*Point\s*=\s*(\[[^\]]+\]),\s*homeLook:\s*Point\s*=\s*(\[[^\]]+\])/),
    fieldOfView = source.match(/camera:\s*\{\s*fov:\s*([\d.]+)/),
    fitAspect = source.match(/const frameScale\s*=\s*\(\)\s*=>\s*Math\.max\(1,\s*([\d.]+)\s*\//);
  assert.ok(settings && fieldOfView && fitAspect, 'Keep the checked camera settings discoverable');
  const eye = JSON.parse(settings[1]),
    target = JSON.parse(settings[2]),
    robot = asset('skinning-ik'),
    orb = asset('skinning-ik-orb'),
    points = [],
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let radius = 0;
  for (const mesh of orb.doc.meshes)
    for (const primitive of mesh.primitives) {
      const p = orb.accessor(primitive.attributes.POSITION, 'VEC3');
      for (let i = 0; i < p.length; i += 3) radius = Math.max(radius, Math.hypot(p[i], p[i + 1], p[i + 2]));
    }
  for (const control of ['side', 'height', 'nearFar'])
    for (let step = 0; step <= 1000; step++)
      points.push({ label: `${control} ${step / 1000}`, center: mapArmControl(control, step / 1000), radius });
  // Skin POSITION values are the authored model-local bind positions. Their
  // conservative box checks feet and the resting silhouette as well as the orb.
  for (const node of robot.doc.nodes)
    if (node.skin !== undefined)
      for (const primitive of robot.doc.meshes[node.mesh].primitives) {
        const p = robot.accessor(primitive.attributes.POSITION, 'VEC3');
        for (let i = 0; i < p.length; i++) {
          const axis = i % 3;
          min[axis] = Math.min(min[axis], p[i]);
          max[axis] = Math.max(max[axis], p[i]);
        }
      }
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) points.push({ label: 'robot bind bounds', center: [x, y, z], radius: 0 });
  for (const aspect of [998 / 720, 2.8, 2, 1.4, 1.2, 1, 0.8, 0.6, 390 / 660, 320 / 510, 0.35]) {
    const scale = Math.max(1, Number(fitAspect[1]) / aspect),
      camera = new Camera({
        fov: Number(fieldOfView[1]),
        position: target.map((value, axis) => value + (eye[axis] - value) * scale),
        target,
        near: 0.03,
        far: 40,
      });
    camera.update(aspect, true);
    for (const point of points)
      for (let plane = 0; plane < 6; plane++) {
        const offset = plane * 4,
          p = camera.planes,
          clearance =
            p[offset] * point.center[0] +
            p[offset + 1] * point.center[1] +
            p[offset + 2] * point.center[2] +
            p[offset + 3] -
            point.radius;
        assert.ok(clearance > 0.05, `${point.label} is cropped or too near plane ${plane} at aspect ${aspect}`);
      }
  }
});
