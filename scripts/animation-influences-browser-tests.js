import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { animatedTriangle } from '../tests/support/gltf-pro-fixture.js';

// Margo-made rig written by packages/animation/scripts/make-rig-fixture.js (see its fixtures README).
const fixture = 'packages/animation/tests/fixtures/tentacle-rig.glb',
  source = {
    file: fixture,
    sha256: createHash('sha256')
      .update(await readFile(fixture))
      .digest('hex'),
  };
await mkdir('test-results', { recursive: true });

const f = animatedTriangle(),
  a = f.doc.meshes[0].primitives[0].attributes;
const append = (data, type = 'VEC4', componentType = 5126) => {
  const index = f.doc.accessors.length,
    buffer = f.buffers.length,
    view = f.doc.bufferViews.length;
  f.buffers.push(data);
  f.doc.buffers.push({ byteLength: data.byteLength });
  f.doc.bufferViews.push({ buffer, byteLength: data.byteLength });
  f.doc.accessors.push({ bufferView: view, componentType, count: data.length / 4, type });
  return index;
};
f.doc.nodes = [
  { mesh: 0, skin: 0, children: [1, 2, 3, 4, 5, 6, 7, 8] },
  ...Array.from({ length: 8 }, (_, i) => ({
    translation: [i * 0.02, 0, 0],
    rotation: [0, Math.sin(i * 0.035), 0, Math.cos(i * 0.035)],
    scale: [1 + i * 0.04, 1, 1 + i * 0.02],
  })),
];
f.doc.skins = [{ joints: [1, 2, 3, 4, 5, 6, 7, 8] }];
f.buffers[a.JOINTS_0] = new Uint16Array([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
f.buffers[a.WEIGHTS_0] = new Float32Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
a.JOINTS_1 = append(new Uint16Array([4, 5, 6, 7, 4, 5, 6, 7, 4, 5, 6, 7]), 'VEC4', 5123);
a.WEIGHTS_1 = append(new Float32Array([5, 6, 7, 8, 5, 6, 7, 8, 5, 6, 7, 8]));
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5197 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  const result = await page.evaluate(
    async ({ doc, buffers, url }) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { parseGLTF, loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { Animation } = await import('/packages/animation/dist/index.js');
      const assert = (ok, message) => {
        if (!ok) throw new Error(message);
      };
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:512px;height:512px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 2048,
        camera: { position: [0, 0, 3], target: [0, 0, 0], near: 0.001, far: 100 },
      });
      const device = engine.gpu;
      device.pushErrorScope('validation');
      const read = async (primitive) => {
        const gpu = engine.gpu,
          b = gpu.createBuffer({
            size: primitive.vertices.byteLength,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          encoder = gpu.createCommandEncoder();
        encoder.copyBufferToBuffer(primitive.deformed, primitive.deformedOffset ?? 0, b, 0, b.size);
        gpu.queue.submit([encoder.finish()]);
        await b.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(b.getMappedRange()).slice();
        b.unmap();
        b.destroy();
        return result;
      };
      // Independent CPU reference: full 4x4 skin accumulation, cofactor normal,
      // and linear tangent transform. It never reads Animation's palette buffers.
      const mul = (a, b) => {
        const out = new Float32Array(16);
        for (let column = 0; column < 4; column++)
          for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
            out[column * 4 + row] = sum;
          }
        return out;
      };
      const inverse = (matrix) => {
        const rows = Array.from({ length: 4 }, (_, row) =>
          Array.from({ length: 8 }, (_, column) => (column < 4 ? matrix[column * 4 + row] : +(column - 4 === row))),
        );
        for (let column = 0; column < 4; column++) {
          let pivot = column;
          for (let row = column + 1; row < 4; row++)
            if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
          [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
          const scale = rows[column][column];
          assert(Math.abs(scale) > 1e-20, 'Singular CPU reference mesh');
          for (let k = 0; k < 8; k++) rows[column][k] /= scale;
          for (let row = 0; row < 4; row++)
            if (row !== column) {
              const factor = rows[row][column];
              for (let k = 0; k < 8; k++) rows[row][k] -= factor * rows[column][k];
            }
        }
        return Float32Array.from({ length: 16 }, (_, i) => rows[i % 4][4 + Math.floor(i / 4)]);
      };
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const reference = (model, primitive, limit = 8) => {
        const d = model.asset.doc,
          skin = d.skins[d.nodes[primitive.nodeIndex].skin],
          attrs = primitive.definition.attributes,
          invMesh = inverse(primitive.node.matrix),
          bind = skin.inverseBindMatrices === undefined ? null : model.asset.accessor(skin.inverseBindMatrices, 'MAT4');
        const palette = skin.joints.map((node, index) =>
            mul(invMesh, mul(model.nodes[node].matrix, bind ? bind.subarray(index * 16, index * 16 + 16) : identity)),
          ),
          sets = [0, 1]
            .filter((set) => attrs['JOINTS_' + set] !== undefined && set * 4 < limit)
            .map((set) => ({
              ids: model.asset.accessor(attrs['JOINTS_' + set], 'VEC4'),
              weights: model.asset.accessor(attrs['WEIGHTS_' + set], 'VEC4'),
            }));
        const output = primitive.vertices.slice();
        const deltas = (primitive.definition.targets ?? []).map((target) =>
          Object.fromEntries(Object.entries(target).map(([key, index]) => [key, model.asset.accessor(index, 'VEC3')])),
        );
        for (let vertex = 0; vertex < output.length / 20; vertex++) {
          const offset = vertex * 20,
            p = Array.from(output.subarray(offset, offset + 3)),
            n = Array.from(output.subarray(offset + 4, offset + 7)),
            t = Array.from(output.subarray(offset + 8, offset + 11));
          for (let index = 0; index < deltas.length; index++)
            for (const [name, value] of [
              ['POSITION', p],
              ['NORMAL', n],
              ['TANGENT', t],
            ]) {
              const delta = deltas[index][name];
              if (delta)
                for (let axis = 0; axis < 3; axis++) value[axis] += delta[vertex * 3 + axis] * primitive.weights[index];
            }
          let sum = 0;
          for (const set of sets)
            for (let channel = 0; channel < 4; channel++) sum += set.weights[vertex * 4 + channel];
          const skin = new Float64Array(16);
          for (const set of sets)
            for (let channel = 0; channel < 4; channel++) {
              const matrix = palette[set.ids[vertex * 4 + channel]],
                weight = set.weights[vertex * 4 + channel] / sum;
              for (let element = 0; element < 16; element++) skin[element] += matrix[element] * weight;
            }
          for (let axis = 0; axis < 3; axis++)
            output[offset + axis] = skin[axis] * p[0] + skin[4 + axis] * p[1] + skin[8 + axis] * p[2] + skin[12 + axis];
          output[offset + 3] = skin[3] * p[0] + skin[7] * p[1] + skin[11] * p[2] + skin[15];
          const c0 = [
              skin[5] * skin[10] - skin[6] * skin[9],
              skin[6] * skin[8] - skin[4] * skin[10],
              skin[4] * skin[9] - skin[5] * skin[8],
            ],
            c1 = [
              skin[9] * skin[2] - skin[10] * skin[1],
              skin[10] * skin[0] - skin[8] * skin[2],
              skin[8] * skin[1] - skin[9] * skin[0],
            ],
            c2 = [
              skin[1] * skin[6] - skin[2] * skin[5],
              skin[2] * skin[4] - skin[0] * skin[6],
              skin[0] * skin[5] - skin[1] * skin[4],
            ],
            hand = Math.sign(skin[0] * c0[0] + skin[1] * c0[1] + skin[2] * c0[2]);
          const mapped = [0, 1, 2].map((axis) => (c0[axis] * n[0] + c1[axis] * n[1] + c2[axis] * n[2]) * hand),
            length = Math.hypot(...mapped);
          for (let axis = 0; axis < 3; axis++) {
            output[offset + 4 + axis] = mapped[axis] / length;
            output[offset + 8 + axis] = skin[axis] * t[0] + skin[4 + axis] * t[1] + skin[8 + axis] * t[2];
          }
          output[offset + 11] *= hand;
        }
        return output;
      };
      const compare = (actual, expected, label) => {
        let position = 0,
          normal = 0,
          tangent = 0;
        for (let vertex = 0; vertex < actual.length / 20; vertex++)
          for (let axis = 0; axis < 4; axis++) {
            const offset = vertex * 20;
            position = Math.max(position, Math.abs(actual[offset + axis] - expected[offset + axis]));
            normal = Math.max(normal, Math.abs(actual[offset + 4 + axis] - expected[offset + 4 + axis]));
            tangent = Math.max(tangent, Math.abs(actual[offset + 8 + axis] - expected[offset + 8 + axis]));
            for (let channel = 12; channel < 20; channel++)
              assert(actual[offset + channel] === expected[offset + channel], label + ' changed UV/color');
          }
        assert(
          position < 0.00003 && normal < 0.0003 && tangent < 0.0003,
          label + ' differs from CPU: ' + JSON.stringify({ position, normal, tangent }),
        );
        return { position, normal, tangent };
      };
      const bytes = buffers.map((bytes) => new Uint8Array(bytes));
      const synthetic = parseGLTF(engine, doc, bytes),
        animation = Animation.attach(synthetic);
      animation.seek(0.5);
      animation.playing = false;
      animation.setMorph(0, 0, 0.5);
      engine.render({ culling: false });
      const syntheticError = compare(
        await read(synthetic.primitives[0]),
        reference(synthetic, synthetic.primitives[0]),
        'Eight-bone morph-before-skin',
      );
      synthetic.dispose();
      const four = structuredClone(doc);
      delete four.meshes[0].primitives[0].attributes.JOINTS_1;
      delete four.meshes[0].primitives[0].attributes.WEIGHTS_1;
      const base = parseGLTF(engine, four, bytes),
        baseAnimation = Animation.attach(base);
      baseAnimation.seek(0.5);
      baseAnimation.playing = false;
      engine.render({ culling: false });
      const baseline = await read(base.primitives[0]);
      base.dispose();
      const paddedBytes = bytes.map((bytes) => bytes.slice()),
        weightAccessor = doc.accessors[doc.meshes[0].primitives[0].attributes.WEIGHTS_1];
      paddedBytes[doc.bufferViews[weightAccessor.bufferView].buffer].fill(0);
      const padded = parseGLTF(engine, doc, paddedBytes),
        paddedAnimation = Animation.attach(padded);
      paddedAnimation.seek(0.5);
      paddedAnimation.playing = false;
      engine.render({ culling: false });
      const paddedOutput = await read(padded.primitives[0]);
      assert(
        baseline.every((value, index) => Object.is(value, paddedOutput[index])),
        'Zero extra influences changed four-bone output',
      );
      padded.dispose();
      const large = structuredClone(doc),
        jointCount = 1001;
      large.nodes = [
        { mesh: 0, skin: 0, children: Array.from({ length: jointCount }, (_, i) => i + 1) },
        ...Array.from({ length: jointCount }, (_, i) => (i === 1000 ? { translation: [0.5, 0, 0] } : {})),
      ];
      large.skins = [{ joints: Array.from({ length: jointCount }, (_, i) => i + 1) }];
      const largeBuffers = bytes.map((bytes) => bytes.slice()),
        attributes = large.meshes[0].primitives[0].attributes;
      for (const field of ['WEIGHTS_0', 'WEIGHTS_1']) {
        const accessor = large.accessors[attributes[field]],
          view = large.bufferViews[accessor.bufferView];
        largeBuffers[view.buffer].fill(0);
      }
      const extraWeights = largeBuffers[large.bufferViews[large.accessors[attributes.WEIGHTS_1].bufferView].buffer],
        extraIds = largeBuffers[large.bufferViews[large.accessors[attributes.JOINTS_1].bufferView].buffer];
      for (let vertex = 0; vertex < 3; vertex++) {
        new Float32Array(extraWeights.buffer)[vertex * 4 + 3] = 1;
        new Uint16Array(extraIds.buffer)[vertex * 4 + 3] = 1000;
      }
      const many = parseGLTF(engine, large, largeBuffers),
        manyAnimation = Animation.attach(many);
      manyAnimation.playing = false;
      engine.render({ culling: false });
      const manyOutput = await read(many.primitives[0]);
      assert(Math.abs(manyOutput[0] + 0.1) < 0.00001, 'Secondary influence failed with 1,001-bone palette');
      many.dispose();
      assert(engine.meshes.size === 0, 'Synthetic skin resources leaked');
      const rig = await loadGLTF(engine, url),
        rigAnimation = Animation.attach(rig),
        primitive = rig.primitives[0],
        attrs = primitive.definition.attributes,
        w1 = rig.asset.accessor(attrs.WEIGHTS_1, 'VEC4'),
        j1 = rig.asset.accessor(attrs.JOINTS_1, 'VEC4');
      let secondaryVertices = 0,
        largest = -1,
        best = 0;
      for (let vertex = 0; vertex < w1.length / 4; vertex++) {
        if (w1.subarray(vertex * 4, vertex * 4 + 4).some((value) => value > 0)) secondaryVertices++;
        for (let channel = 0; channel < 4; channel++)
          if (w1[vertex * 4 + channel] > largest) {
            largest = w1[vertex * 4 + channel];
            best = vertex * 4 + channel;
          }
      }
      assert(secondaryVertices === 247, 'Generated rig lost its secondary skin weights; rerun make-rig-fixture.js');
      rigAnimation.seek(0.37);
      rigAnimation.playing = false;
      engine.render({ culling: false });
      const clipOutput = await read(primitive),
        clipError = compare(clipOutput, reference(rig, primitive), 'Generated rig clip');
      const skin = rig.asset.doc.skins[rig.asset.doc.nodes[primitive.nodeIndex].skin],
        joint = rig.nodes[skin.joints[j1[best]]];
      joint.position.x += 0.02;
      engine.render({ culling: false });
      const posed = await read(primitive),
        posedError = compare(posed, reference(rig, primitive), 'Generated rig secondary-joint pose'),
        truncated = reference(rig, primitive, 4);
      let truncationDifference = 0,
        movingVertices = 0;
      for (let vertex = 0; vertex < posed.length / 20; vertex++) {
        const offset = vertex * 20;
        for (let axis = 0; axis < 3; axis++) {
          truncationDifference = Math.max(
            truncationDifference,
            Math.abs(posed[offset + axis] - truncated[offset + axis]),
          );
          if (Math.abs(posed[offset + axis] - clipOutput[offset + axis]) > 0.000001) {
            movingVertices++;
            break;
          }
        }
      }
      assert(truncationDifference > 0.00001, 'Generated rig does not distinguish all eight inputs from truncated four');
      assert(movingVertices > 0, 'Secondary-joint pose did not move rig vertices');
      const bounds = rig.bounds;
      engine.camera.fitToBoundingBox([bounds[0], bounds[1], bounds[2]], [bounds[3], bounds[4], bounds[5]], {
        duration: 0,
      });
      engine.render({ culling: false });
      await device.queue.onSubmittedWorkDone();
      const validation = await device.popErrorScope();
      assert(!validation, validation?.message);
      window.animationInfluencesScene = { engine, rig, rigAnimation, read };
      return {
        syntheticError,
        fourInfluenceParity: true,
        largeSkinJoints: jointCount,
        rig: {
          vertices: primitive.vertices.length / 20,
          joints: skin.joints.length,
          clips: rigAnimation.clips.length,
          secondaryVertices,
          clipError,
          posedError,
          truncationDifference,
          movingVertices,
        },
      };
    },
    {
      doc: f.doc,
      buffers: f.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]),
      url: '/' + fixture,
    },
  );
  await page.locator('canvas').screenshot({ path: 'test-results/animation-rig-eight-influences.png' });
  const restore = await page.evaluate(async () => {
    const { engine, rig, rigAnimation, read } = window.animationInfluencesScene,
      before = rig.primitives[0].deformed,
      original = await read(rig.primitives[0]);
    await engine.rebootDevice();
    engine.gpu.pushErrorScope('validation');
    engine.render({ culling: false });
    await engine.gpu.queue.onSubmittedWorkDone();
    const after = await read(rig.primitives[0]),
      restored = rig.primitives[0].deformed !== before && !!rig.primitives[0].deformed;
    let error = 0;
    for (let index = 0; index < after.length; index++)
      error = Math.max(error, Math.abs(original[index] - after[index]));
    const validation = await engine.gpu.popErrorScope();
    if (validation || error > 0.00001)
      throw new Error('Restored skin differs: ' + JSON.stringify({ validation: validation?.message, error }));
    rig.dispose();
    const cleaned = engine.meshes.size === 0 && !engine.hasPlugin(rigAnimation.name);
    engine.dispose();
    return { restored, cleaned, error };
  });
  assert.equal(restore.restored, true);
  assert.equal(restore.cleaned, true);
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/animation-influences.json',
    JSON.stringify({ hardware, source, ...result, restore }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ hardware, ...result, restore }, null, 2));
} finally {
  await browser.close();
}
