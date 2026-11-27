// Real-GPU check of dual quaternion skinning (packages/animation/src/dqs.ts). A tube twists about its axis under bones
// blended by smooth weights, four and eight influences, with a morph target under the skin and a scaled bone. Every
// vertex read back from the GPU must match skinDualQuaternion, the double-precision CPU twin of the shader; the twisted
// radius must hold where a linear Animation of the same model, deformed in the same frame, pinches. Animation's CPU pose
// (the mode's `blend`, which synchronous raycasts test, KB-BVH-SYNCPOSE-DQS1) must match the same read-back vertices,
// for both modes; a Blend skin on a node without shares must be all dual quaternion.
// Runs as `npm run test:gpu:dqs -w @margoengine/animation` (check:gpu-packages).
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5196 }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { parseGLTF } = await import('/packages/gltf/dist/pbr.js'),
      { Animation } = await import('/packages/animation/dist/index.js'),
      { cloneModel } = await import('/packages/animation/dist/skeleton-utils.js'),
      { Raycaster } = await import('/packages/bvh/dist/index.js'),
      { posedVertices } = await import('/packages/shared/pose-source.js'),
      { blendSkinning, dualQuaternionSkinning, skinDualQuaternion } = await import('/packages/animation/dist/dqs.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:64px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 1024,
        camera: { position: [0, 0, 8], target: [0, 0, 0], near: 0.01, far: 50 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');

    // A tube along +X, x from 0 to 4, ring radius 1. Six joints in a chain, one each unit plus the end. Each ring
    // weighs on its neighbouring joints; `eight` spreads a ring over more than four joints.
    const RINGS = 33,
      SIDES = 12,
      JOINTS = 6;
    const tube = (eight) => {
      const buffers = [],
        bufferViews = [],
        accessors = [],
        add = (data, type, componentType = 5126) => {
          const id = buffers.length,
            width = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
          buffers.push(new Uint8Array(data.buffer));
          bufferViews.push({ buffer: id, byteLength: data.byteLength });
          accessors.push({
            bufferView: id,
            componentType,
            count: data.length / width,
            type,
            ...(id === 0 ? { min: [-1, -2, -2], max: [5, 2, 2] } : {}),
          });
          return id;
        };
      const positions = [],
        normals = [],
        deltas = [],
        sets = [[], []],
        indices = [];
      for (let r = 0; r < RINGS; r++) {
        const x = (r / (RINGS - 1)) * 4;
        // Weights over joints by distance to each joint's x: a wide, smooth falloff.
        const reach = eight ? 2.6 : 1,
          raw = Array.from({ length: JOINTS }, (_, j) => Math.max(0, 1 - Math.abs(x - j) / reach)),
          used = raw
            .map((w, j) => [w, j])
            .filter(([w]) => w > 0)
            .sort((a, b) => b[0] - a[0])
            .slice(0, 8);
        for (let s = 0; s < SIDES; s++) {
          const a = (s / SIDES) * Math.PI * 2;
          positions.push(x, Math.cos(a), Math.sin(a));
          normals.push(0, Math.cos(a), Math.sin(a));
          deltas.push(0, Math.cos(a) * 0.1, Math.sin(a) * 0.1);
          for (let k = 0; k < 8; k++) sets[k >> 2].push(used[k]?.[1] ?? 0, used[k]?.[0] ?? 0);
        }
      }
      for (let r = 0; r + 1 < RINGS; r++)
        for (let s = 0; s < SIDES; s++) {
          const a = r * SIDES + s,
            b = r * SIDES + ((s + 1) % SIDES),
            c = a + SIDES,
            d = b + SIDES;
          indices.push(a, b, c, b, d, c);
        }
      const influence = (set, pick) => set.filter((_, i) => i % 2 === pick),
        attributes = {
          POSITION: add(new Float32Array(positions), 'VEC3'),
          NORMAL: add(new Float32Array(normals), 'VEC3'),
          JOINTS_0: add(new Uint16Array(influence(sets[0], 0)), 'VEC4', 5123),
          WEIGHTS_0: add(new Float32Array(influence(sets[0], 1)), 'VEC4'),
        };
      if (eight) {
        attributes.JOINTS_1 = add(new Uint16Array(influence(sets[1], 0)), 'VEC4', 5123);
        attributes.WEIGHTS_1 = add(new Float32Array(influence(sets[1], 1)), 'VEC4');
      }
      const inverseBind = new Float32Array(JOINTS * 16);
      for (let j = 0; j < JOINTS; j++) {
        inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -j, 0, 0, 1], j * 16);
      }
      const target = add(new Float32Array(deltas), 'VEC3'),
        index = add(new Uint32Array(indices), 'SCALAR', 5125),
        matrices = add(inverseBind, 'MAT4'),
        doc = {
          asset: { version: '2.0' },
          buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
          bufferViews,
          accessors,
          scene: 0,
          scenes: [{ nodes: [0, 1] }],
          nodes: [
            { mesh: 0, skin: 0 },
            { children: [2] },
            ...Array.from({ length: JOINTS - 1 }, (_, j) => ({
              translation: [1, 0, 0],
              ...(j + 1 < JOINTS - 1 ? { children: [j + 3] } : {}),
            })),
          ],
          meshes: [{ primitives: [{ attributes, indices: index, targets: [{ POSITION: target }] }], weights: [0] }],
          skins: [{ joints: Array.from({ length: JOINTS }, (_, j) => j + 1), inverseBindMatrices: matrices }],
        };
      return { doc, buffers };
    };

    const read = async (primitive) => {
      const size = (primitive.vertices.length / 20) * 80,
        out = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(primitive.deformed, primitive.deformedOffset ?? 0, out, 0, size);
      device.queue.submit([encoder.finish()]);
      await out.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(out.getMappedRange()).slice();
      out.unmap();
      out.destroy();
      return values;
    };
    const q = (axis, degrees) => {
      const h = (degrees * Math.PI) / 360,
        s = Math.sin(h);
      return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
    };

    const report = {
      checks: 0,
      worstPosition: 0,
      worstNormal: 0,
      dqRadius: Infinity,
      linearRadius: Infinity,
      failure: null,
      cpuChecks: 0,
      worstCpu: 0,
    };
    // Animation's CPU pose (posedVertices, what a synchronous ray tests) against the vertices read back from the GPU.
    const cpuAgainst = (cpu, gpu) => {
      for (let i = 0; i < gpu.length; i += 20)
        for (const c of [0, 1, 2, 4, 5, 6]) {
          report.worstCpu = Math.max(report.worstCpu, Math.abs(cpu[i + c] - gpu[i + c]));
          report.cpuChecks++;
        }
    };
    for (const eight of [false, true]) {
      const { doc, buffers } = tube(eight),
        dqModel = parseGLTF(engine, doc, buffers);
      if (engine.plugins.get(dqModel.name) !== dqModel) engine.use(dqModel);
      const linearModel = await cloneModel(dqModel),
        dq = Animation.attach(dqModel, { skinning: dualQuaternionSkinning }),
        linear = Animation.attach(linearModel);
      dq.playing = linear.playing = false;
      const poses = [
        { twist: 0, weight: 0 },
        { twist: 60, weight: 0 },
        { twist: 170, weight: 0 },
        { twist: 170, weight: 0.8 },
        { twist: 170, weight: 0, scale: 1.5 },
        { twist: -120, weight: 0.4, bend: 50 },
      ];
      for (const pose of poses) {
        for (const model of [dqModel, linearModel]) {
          model.primitives[0].weights[0] = pose.weight;
          // Joint 2 at x=2 turns the tube; the joints after it follow.
          model.nodes[3].setQuaternion(q([1, 0, 0], pose.twist));
          model.nodes[2].setQuaternion(q([0, 0, 1], pose.bend ?? 0));
          const s = pose.scale ?? 1;
          model.nodes[4].setScale([s, s, s]);
        }
        engine.render({ culling: false });
        const r = dq.resources[0],
          p = dqModel.primitives[0],
          actual = await read(p),
          hit = new Raycaster([1.5, 0, 8], [0, 0, -1]).intersectObjects(engine, [dqModel]),
          straight = await read(linearModel.primitives[0]),
          count = p.vertices.length / 20,
          raw = doc.meshes[0].primitives[0].attributes,
          sets = [[raw.JOINTS_0, raw.WEIGHTS_0]];
        if (eight) sets.push([raw.JOINTS_1, raw.WEIGHTS_1]);
        const data = sets.map(([j, w]) => [dqModel.asset.accessor(j, 'VEC4'), dqModel.asset.accessor(w, 'VEC4')]),
          delta = dqModel.asset.accessor(doc.meshes[0].primitives[0].targets[0].POSITION, 'VEC3');
        for (let i = 0; i < count; i++) {
          const joints = [],
            weights = [];
          let total = 0;
          for (const [j, w] of data) for (let c = 0; c < 4; c++) total += w[i * 4 + c];
          for (const [j, w] of data)
            for (let c = 0; c < 4; c++) {
              joints.push(j[i * 4 + c]);
              weights.push(w[i * 4 + c] / total);
            }
          const v = p.vertices.subarray(i * 20, i * 20 + 8),
            at = [0, 1, 2].map((c) => v[c] + delta[i * 3 + c] * pose.weight),
            expected = skinDualQuaternion(r.palette, joints, weights, at, [v[4], v[5], v[6]]);
          for (let c = 0; c < 3; c++) {
            const dp = Math.abs(actual[i * 20 + c] - expected.position[c]),
              dn = Math.abs(actual[i * 20 + 4 + c] - expected.normal[c]);
            if (!(dp <= 2e-5 && dn <= 2e-5) && !report.failure)
              report.failure = { eight, pose, i, c, position: actual[i * 20 + c], expected: expected.position[c], dn };
            report.worstPosition = Math.max(report.worstPosition, dp);
            report.worstNormal = Math.max(report.worstNormal, dn);
            report.checks += 2;
          }
        }
        cpuAgainst(posedVertices(p).vertices, actual);
        if (!hit.length && !report.failure) report.failure = { eight, pose, missed: 'a synchronous ray at the tube' };
        if (pose.twist === 170 && !pose.weight && !pose.scale && !eight) {
          // The ring halfway through the twist: x=2 is joint 2 itself, so read the rings beside it.
          const radius = (values) => {
            let least = Infinity;
            for (let r2 = 0; r2 < RINGS; r2++) {
              let sum = 0;
              for (let s = 0; s < SIDES; s++) {
                const o = (r2 * SIDES + s) * 20;
                sum += Math.hypot(values[o + 1], values[o + 2]);
              }
              least = Math.min(least, sum / SIDES);
            }
            return least;
          };
          report.dqRadius = radius(actual);
          report.linearRadius = radius(straight);
        }
      }
      for (const a of [dq, linear]) a.dispose();
      linearModel.dispose();
      dqModel.dispose();
    }
    // A Blend skin: each vertex mixes linear and dual quaternion skinning by the share on the node's extras; a node
    // without shares is all dual quaternion (it was all linear: Animation packed share 0).
    report.blendChecks = 0;
    report.worstBlend = 0;
    for (const [eight, given] of [
      [false, true],
      [true, true],
      [false, false],
    ]) {
      const { doc, buffers } = tube(eight),
        shares = Array.from({ length: RINGS * SIDES }, (_, i) => (given ? Math.floor(i / SIDES) / (RINGS - 1) : 1));
      if (given) doc.nodes[0].extras = { fbxSkinning: { type: 'Blend', blendWeights: shares } };
      const blendModel = parseGLTF(engine, doc, buffers);
      if (engine.plugins.get(blendModel.name) !== blendModel) engine.use(blendModel);
      const blend = Animation.attach(blendModel, { skinning: blendSkinning });
      blend.playing = false;
      blendModel.primitives[0].weights[0] = 0;
      blendModel.nodes[3].setQuaternion(q([1, 0, 0], 170));
      blendModel.nodes[2].setQuaternion(q([0, 0, 1], 50));
      engine.render({ culling: false });
      const p = blendModel.primitives[0],
        actual = await read(p),
        hit = new Raycaster([1.5, 0, 8], [0, 0, -1]).intersectObjects(engine, [blendModel]),
        palette = blend.resources[0].palette,
        raw = doc.meshes[0].primitives[0].attributes,
        sets = [[raw.JOINTS_0, raw.WEIGHTS_0]];
      if (eight) sets.push([raw.JOINTS_1, raw.WEIGHTS_1]);
      const data = sets.map(([j, w]) => [blendModel.asset.accessor(j, 'VEC4'), blendModel.asset.accessor(w, 'VEC4')]);
      for (let i = 0; i < p.vertices.length / 20; i++) {
        const joints = [],
          weights = [];
        let total = 0;
        for (const [, w] of data) for (let c = 0; c < 4; c++) total += w[i * 4 + c];
        for (const [j, w] of data)
          for (let c = 0; c < 4; c++) {
            joints.push(j[i * 4 + c]);
            weights.push(w[i * 4 + c] / total);
          }
        const v = p.vertices.subarray(i * 20, i * 20 + 8),
          expected = skinDualQuaternion(palette, joints, weights, [v[0], v[1], v[2]], [v[4], v[5], v[6]], shares[i]);
        for (let c = 0; c < 3; c++) {
          const dp = Math.abs(actual[i * 20 + c] - expected.position[c]),
            dn = Math.abs(actual[i * 20 + 4 + c] - expected.normal[c]);
          report.worstBlend = Math.max(report.worstBlend, dp, dn);
          report.blendChecks += 2;
        }
      }
      cpuAgainst(posedVertices(p).vertices, actual);
      if (!hit.length && !report.failure) report.failure = { eight, given, missed: 'a synchronous ray at the blend tube' };
      blend.dispose();
      blendModel.dispose();
    }
    const error = await device.popErrorScope();
    return { ...report, validation: error?.message ?? null };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.equal(result.failure, null);
  assert.ok(result.checks >= 2 * 5 * 33 * 12 * 6, 'every vertex of every pose checked');
  assert.ok(result.worstPosition <= 2e-5, `GPU positions differ from the CPU twin by ${result.worstPosition}`);
  assert.ok(result.worstNormal <= 2e-5, `GPU normals differ from the CPU twin by ${result.worstNormal}`);
  assert.ok(result.blendChecks >= 2 * 3 * 33 * 12 * 3, 'every vertex of the three blend tubes checked');
  assert.ok(result.cpuChecks >= 6 * 33 * 12 * (2 * 6 + 3), "Animation's CPU pose checked for every tube and pose");
  assert.ok(result.worstCpu <= 2e-5, `Animation's CPU pose differs from the GPU's by ${result.worstCpu}`);
  assert.ok(result.worstBlend <= 2e-5, `GPU blend differs from the CPU twin by ${result.worstBlend}`);
  assert.ok(result.dqRadius > 0.97, `the twisted tube's narrowest ring is ${result.dqRadius}`);
  assert.ok(result.linearRadius < 0.6, `the linear tube should pinch, narrowest ring ${result.linearRadius}`);
} finally {
  await browser.close();
}
