// `npm run test:gpu:soft-mesh` (WebGPU, then the WebGL2 layer with --compat): a cloth drawn with drawSoftBody from
// @margoengine/gltf/soft-mesh falls under physics, its mesh follows the particles every frame, renders in its material's
// colour, takes a texture through the grid's UVs, and leaves the engine when disposed, with no validation error. A soft
// volume welded from a geometry sphere (SoftBodyDesc.volume) draws its source mesh: every vertex at its particle, and the
// sphere's own UVs choosing the texture's half.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (e) => errors.push(e.message));
    const result = await browser.page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { Physics } = await import('/packages/physics/dist/index.js');
      const { SoftBodies, SoftBodyDesc } = await import('/packages/physics/dist/soft.js');
      const { drawSoftBody } = await import('/packages/gltf/dist/soft-mesh.js');
      const { sphereGeometry } = await import('/packages/geometry/dist/primitives.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      await Physics.load();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 3.2], target: [0, 0, 0], fov: 45, near: 0.1, far: 20 },
      });
      engine.gpu.pushErrorScope('validation');
      const physics = new Physics(engine);
      const soft = await SoftBodies.attach(physics);
      const frame = async () => {
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
      };
      const out = { pictures: [], follow: [], fell: [] };
      try {
        // A curtain of 11 x 11 particles tilted toward the camera, hung by its two top corners, swings down; red, then a 2 x 2 checker of
        // red and blue laid on by its grid UVs.
        const materials = [
          [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.1, 0.1, 1] } }, []],
          [
            { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
            [
              {
                width: 2,
                height: 2,
                data: Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255),
              },
            ],
          ],
        ];
        for (const [material, images] of materials) {
          const cloth = soft.create(
            SoftBodyDesc.cloth([-1, 1, 0], [0.2, 0, 0], [0, -0.17, 0.1], 11, 11).setPinnedParticles([0, 110]),
          );
          const mesh = drawSoftBody(engine, cloth, { material, images });
          const start = cloth.particlePosition(60);
          await waitForPipelines(frame);
          for (let i = 0; i < 40; i++) await frame();
          const p = cloth.particlePositions(),
            v = mesh.model.primitives[0].vertices;
          let off = 0;
          for (let k = 0; k < 121; k++)
            for (let a = 0; a < 3; a++) off = Math.max(off, Math.abs(v[k * 20 + a] - p[k * 3 + a]));
          out.follow.push(off);
          out.fell.push(Math.hypot(...cloth.particlePosition(60).map((x, a) => x - start[a])));
          out.pictures.push(canvas.toDataURL('image/png'));
          mesh.dispose();
          out.gone = !engine.hasPlugin(mesh.name);
          soft.remove(cloth);
        }
        // A ball welded from a UV sphere with its seam and poles, in a texture red for u < 0.5 and blue above.
        const ball = soft.create(SoftBodyDesc.volume(sphereGeometry(0.8, 24, 16)).setGravityScale(0));
        const drawn = drawSoftBody(engine, ball, {
          material: { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
          images: [{ width: 2, height: 1, data: Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255) }],
        });
        ball.applyImpulseAtPoint([0, 0, -40], [0, 0, 0.8], 0.6);
        await waitForPipelines(frame);
        for (let i = 0; i < 10; i++) await frame();
        const { particles, uvs } = ball.sourceMesh,
          p = ball.particlePositions(),
          v = drawn.model.primitives[0].vertices;
        let off = 0,
          front = 0;
        for (let k = 0; k < particles.length; k++) {
          for (let a = 0; a < 3; a++) off = Math.max(off, Math.abs(v[k * 20 + a] - p[particles[k] * 3 + a]));
          if (v[k * 20 + 2] > v[front * 20 + 2]) front = k;
        }
        out.volume = { off, vertices: particles.length, welded: ball.numParticles(), frontU: uvs[front * 2] };
        out.pictures.push(canvas.toDataURL('image/png'));
        drawn.dispose();
        soft.remove(ball);
        await frame();
        out.pictures.push(canvas.toDataURL('image/png'));
        out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
        return out;
      } finally {
        engine.dispose();
        canvas.remove();
      }
    });
    assert.deepEqual(errors, []);
    assert.equal(result.validation, null);
    assert.ok(result.gone, 'a disposed soft mesh leaves the engine');
    for (const off of result.follow) assert.equal(off, 0, 'the drawn vertices are the particles of the frame');
    for (const fell of result.fell) assert.ok(fell > 0.05, `the tilted curtain swung toward hanging (${fell} m)`);
    const [plain, checker, volume, empty] = await Promise.all(
      result.pictures.map((p) => decodePNG(Buffer.from(p.split(',')[1], 'base64'))),
    );
    const at = (image, x, y) => [...image.data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
    const middle = at(plain, 32, 32);
    assert.ok(middle[0] > middle[1] + 40 && middle[0] > middle[2] + 40, `the red cloth draws red: ${middle}`);
    // The checker: the cloth's four quarters alternate, so its upper left and upper right differ in red and blue.
    const left = at(checker, 20, 22),
      right = at(checker, 44, 22);
    assert.ok(
      left[0] > left[2] + 30 && right[2] > right[0] + 30,
      `the texture follows the grid UVs: ${left}, ${right}`,
    );
    // The welded ball: 25 x 17 source vertices on 24 x 15 + 2 particles, each drawn where its particle is.
    assert.equal(result.volume.vertices, 25 * 17);
    assert.equal(result.volume.welded, 24 * 15 + 2);
    assert.equal(result.volume.off, 0, 'every source vertex is drawn at its particle');
    const face = at(volume, 32, 32),
      red = result.volume.frontU < 0.5;
    assert.ok(
      red ? face[0] > face[2] + 30 : face[2] > face[0] + 30,
      `the ball's front (u ${result.volume.frontU}) takes the ${red ? 'red' : 'blue'} half by its own UVs: ${face}`,
    );
    const gone = at(empty, 32, 32);
    assert.ok(!(gone[0] > gone[1] + 40 && gone[0] > gone[2] + 40), `a disposed cloth is no longer drawn: ${gone}`);
    console.log(
      'drawSoftBody: the cloth follows its particles, draws its colour and its grid texture, and disposes; a welded volume draws its source mesh and UVs',
    );
  },
  () => browser.close(),
);
