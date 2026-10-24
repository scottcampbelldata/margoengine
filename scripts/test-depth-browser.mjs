// The real-GPU check of @margoengine/post/depth (DepthTexture): every case at 1x and 4x MSAA, reading pixels back.
//   npm run check:depth   (takes the GPU lock itself; under `gpu-lock.mjs run` it nests)
// Cases: (a) reversed-Z depth of a box against camera.matrix, 0 where empty; (b) the distance target against the
// analytic distance to the box face; (c) an orthographic camera (@margoengine/cameras): depth linear in distance,
// distance still exact; (d) a WgslMaterial plane reading depth.distance with textureLoad shows a colour made from it;
// (e) a FramePass after the main pass samples depth.texture as texture_depth_2d; (f) 4x matches 1x (compared in node);
// (g) two views with their own cameras keep their own halves; (h) a materials mesh added with depth.add draws, one not
// added does not; (i) a canvas view and a smaller target view each frame create no textures after the first frame.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

const release = await acquire({ owner: 'depth-browser' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5297 });
  const { page, hardware } = browser,
    pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const runs = {};
  for (const samples of [1, 4])
    runs[samples] = await page.evaluate(async (samples) => {
      if (samples === 1) globalThis.margoLow = 1;
      else delete globalThis.margoLow;
      const { EngineKernel, box } = await import('/packages/core/dist/index.js');
      const { Camera, engineRuntime } = await import('/packages/core/dist/extension.js');
      const { DepthTexture } = await import('/packages/post/dist/depth.js');
      const { CameraProjection } = await import('/packages/cameras/dist/index.js');
      const { Texture, WgslMaterial, Material, createMesh } = await import('/packages/materials/dist/index.js');
      const W = 128,
        H = 96,
        near = 0.1,
        far = 100,
        out = {};

      // ---- helpers ----
      const create = async (camera = { position: [0, 0, 6], target: [0, 0, 0], near, far }) => {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        canvas.style.cssText = `width:${W}px;height:${H}px`;
        document.body.append(canvas);
        const engine = await EngineKernel.create(canvas, { backend: 'webgpu', capacity: 16, camera }),
          runtime = engineRuntime(engine),
          device = runtime.gpu,
          errors = [];
        device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        return {
          engine,
          runtime,
          device,
          errors,
          canvas,
          close() {
            engine.dispose();
            canvas.remove();
          },
        };
      };
      // A flat box whose front face (normal +z) is at z = face, centred on (x, y).
      const slab = (engine, [x, y, face], [w, h] = [3, 2], color = '#ffffff') => {
        const mesh = engine
          .createMesh()
          .setGeometry(box(w, h, 0.5))
          .setPosition([x, y, face - 0.25]);
        mesh.material.set({ color });
        return mesh;
      };
      // Every texel of a texture: float32 per texel for r32float and depth32float, bytes for rgba8unorm.
      const read = async (device, texture) => {
        const bytes = 4,
          row = Math.ceil((texture.width * bytes) / 256) * 256,
          buffer = device.createBuffer({
            size: row * texture.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture, aspect: texture.format === 'depth32float' ? 'depth-only' : 'all' },
          { buffer, bytesPerRow: row },
          [texture.width, texture.height],
        );
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const copy = buffer.getMappedRange().slice(0);
        buffer.destroy();
        const float = new Float32Array(copy),
          u8 = new Uint8Array(copy);
        return {
          at: (x, y) => float[(y * row) / 4 + x],
          rgba: (x, y) => Array.from(u8.subarray(y * row + x * 4, y * row + x * 4 + 4)),
        };
      };
      const vec = {
        sub: (a, b) => a.map((v, i) => v - b[i]),
        norm: (a) => {
          const l = Math.hypot(...a);
          return a.map((v) => v / l);
        },
        cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
      };
      // Camera basis as core builds it: z back from the target, x = up × z, y = z × x.
      const basis = (camera) => {
        const z = vec.norm(vec.sub(camera.position, camera.target)),
          x = vec.norm(vec.cross(camera.up ?? [0, 1, 0], z));
        return { x, y: vec.cross(z, x), z };
      };
      const clipOf = (m, p) => [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
      // The pixel a world point falls in, within viewport [vx, vy, vw, vh].
      const pixelOf = (camera, p, [vx, vy, vw, vh]) => {
        const c = clipOf(camera.matrix, p);
        return [Math.floor(vx + ((c[0] / c[3] + 1) / 2) * vw), Math.floor(vy + ((1 - c[1] / c[3]) / 2) * vh)];
      };
      // The analytic hit of pixel (px, py)'s centre on the plane z = face: its world point, camera distance and the
      // reversed-Z depth camera.matrix gives that point. `ortho`: the half height of an orthographic view.
      const hit = (camera, [px, py], [vx, vy, vw, vh], face, ortho) => {
        const nx = (2 * (px + 0.5 - vx)) / vw - 1,
          ny = 1 - (2 * (py + 0.5 - vy)) / vh,
          { x, y, z } = basis(camera),
          aspect = vw / vh,
          e = camera.position;
        let origin, dir;
        if (ortho) {
          origin = e.map((v, i) => v + x[i] * nx * ortho * aspect + y[i] * ny * ortho);
          dir = z.map((v) => -v);
        } else {
          const t = Math.tan((camera.fov * Math.PI) / 360);
          origin = e;
          dir = [0, 1, 2].map((i) => x[i] * nx * t * aspect + y[i] * ny * t - z[i]);
        }
        const s = (face - origin[2]) / dir[2],
          point = origin.map((v, i) => v + dir[i] * s),
          clip = clipOf(camera.matrix, point);
        return {
          point,
          distance: Math.hypot(...vec.sub(point, e)),
          depth: clip[2] / clip[3],
          viewDepth: -[0, 1, 2].reduce((sum, i) => sum + (point[i] - e[i]) * z[i], 0),
        };
      };
      const relative = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
      const check = (failures, label, value, expected, tolerance) => {
        if (!(Math.abs(value - expected) <= tolerance))
          failures.push(`${label}: ${value} != ${expected} (tolerance ${tolerance})`);
      };
      const finish = async (fixture, failures) => {
        await fixture.device.queue.onSubmittedWorkDone();
        const validation = await fixture.device.popErrorScope();
        if (validation) failures.push('validation: ' + validation.message);
        failures.push(...fixture.errors);
      };
      const full = [0, 0, W, H];
      // Two slabs: A (3 x 2) with its face at z = 0.25 in the middle, B (1.5 x 1.5) at z = -1.75 on the left.
      const faceA = 0.25,
        faceB = -1.75;
      const scene = (engine) => {
        slab(engine, [0, 0, faceA]);
        slab(engine, [-3.2, 0, faceB], [1.5, 1.5]);
      };
      const samplePoints = (camera, rect = full) => ({
        a: pixelOf(camera, [0.3, 0.2, faceA], rect),
        b: pixelOf(camera, [-3.2, 0.1, faceB], rect),
        empty: [rect[0] + 2, rect[1] + 2],
      });

      // ---- (a, b, e) perspective: depth, distance, and a post pass reading depth.texture ----
      {
        const f = await create(),
          failures = [];
        try {
          f.device.pushErrorScope('validation');
          scene(f.engine);
          const depth = DepthTexture.attach(f.engine);
          // (e) A pass after the main pass loads depth.texture as texture_depth_2d into an r32float storage texture.
          const copied = f.device.createTexture({
            size: [W, H],
            format: 'r32float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
          });
          const module = f.device.createShaderModule({
            code: `@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var output:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=textureDimensions(output))){return;}
  textureStore(output,vec2i(id.xy),vec4f(textureLoad(depth,vec2i(id.xy),0)));
}`,
          });
          const pipeline = f.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
          let ranAfter = false,
            sceneSamples = 0;
          f.runtime.frameGraph.add({
            name: 'depth-check:post',
            order: 50,
            execute(c) {
              const group = f.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: depth.texture.createView({ aspect: 'depth-only' }) },
                  { binding: 1, resource: copied.createView() },
                ],
              });
              const pass = c.encoder.beginComputePass();
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, group);
              pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
              pass.end();
              ranAfter = true;
              sceneSamples = c.descriptor.multisample?.count ?? 1;
            },
          });
          f.engine.render({ culling: false });
          const camera = f.engine.camera,
            points = samplePoints(camera),
            z = await read(f.device, depth.texture),
            d = await read(f.device, depth.distance),
            post = await read(f.device, copied);
          const report = { samples: depth.texture.sampleCount, sizes: [depth.texture.width, depth.texture.height] };
          for (const [key, face] of [
            ['a', faceA],
            ['b', faceB],
          ]) {
            const [px, py] = points[key],
              want = hit(camera, [px, py], full, face),
              // The same depth from core's projection formula: n (f - D) / ((f - n) D) for view depth D.
              formula = (near * (far - want.viewDepth)) / ((far - near) * want.viewDepth);
            report[key] = {
              pixel: [px, py],
              depth: z.at(px, py),
              expectedDepth: want.depth,
              formulaDepth: formula,
              distance: d.at(px, py),
              expectedDistance: want.distance,
              postDepth: post.at(px, py),
            };
            check(failures, `(a) depth ${key}`, z.at(px, py), want.depth, 1e-6);
            check(failures, `(a) depth ${key} vs formula`, want.depth, formula, 1e-6);
            check(failures, `(b) distance ${key}`, relative(d.at(px, py), want.distance), 0, 1e-5);
            check(failures, `(e) post-pass depth ${key}`, post.at(px, py), z.at(px, py), 0);
          }
          const [ex, ey] = points.empty;
          report.empty = { depth: z.at(ex, ey), distance: d.at(ex, ey), postDepth: post.at(ex, ey) };
          check(failures, '(a) empty depth', z.at(ex, ey), 0, 0);
          check(failures, '(b) empty distance', d.at(ex, ey), 0, 0);
          check(failures, '(e) empty post-pass depth', post.at(ex, ey), 0, 0);
          if (!ranAfter) failures.push('(e) post pass did not run');
          if (report.a.depth <= report.b.depth) failures.push('(a) nearer must be greater (reversed Z)');
          // Every texel of the post pass equals depth.texture: the pass reads the depth this frame drew.
          let mismatched = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (post.at(x, y) !== z.at(x, y)) mismatched++;
          report.postMismatchedTexels = mismatched;
          if (mismatched) failures.push(`(e) ${mismatched} post-pass texels differ from depth.texture`);
          report.sceneSamples = sceneSamples;
          if (sceneSamples !== samples) failures.push(`(f) the scene drew at ${sceneSamples}x, not ${samples}x`);
          if (report.samples !== 1) failures.push('(f) DepthTexture is not single-sample');
          // The full grids for the 1x/4x comparison (f): texels whose 3x3 neighbourhood is all one surface.
          report.grid = { depth: [], distance: [] };
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              report.grid.depth.push(z.at(x, y));
              report.grid.distance.push(d.at(x, y));
            }
          await finish(f, failures);
          copied.destroy();
          out.perspective = { ...report, failures };
        } finally {
          f.close();
        }
      }

      // ---- (c) orthographic camera ----
      {
        const f = await create(),
          failures = [];
        try {
          f.device.pushErrorScope('validation');
          scene(f.engine);
          const half = 4,
            projection = CameraProjection.attach(f.engine, { height: 2 * half }),
            depth = DepthTexture.attach(f.engine);
          f.engine.render({ culling: false });
          const camera = f.engine.camera,
            points = samplePoints(camera),
            z = await read(f.device, depth.texture),
            d = await read(f.device, depth.distance),
            report = {};
          // CameraProjection's default clip range: camera.far deep, centred on the target (distance 6).
          const n = 6 - far / 2,
            fr = 6 + far / 2;
          for (const [key, face] of [
            ['a', faceA],
            ['b', faceB],
          ]) {
            const [px, py] = points[key],
              want = hit(camera, [px, py], full, face, half),
              linear = (fr - want.viewDepth) / (fr - n);
            report[key] = {
              pixel: [px, py],
              depth: z.at(px, py),
              expectedDepth: want.depth,
              linearDepth: linear,
              viewDepth: want.viewDepth,
              distance: d.at(px, py),
              expectedDistance: want.distance,
            };
            check(failures, `(c) depth ${key}`, z.at(px, py), want.depth, 1e-6);
            check(failures, `(c) depth ${key} linear`, z.at(px, py), linear, 1e-6);
            check(failures, `(c) distance ${key}`, relative(d.at(px, py), want.distance), 0, 1e-5);
          }
          // Linear: the depth step between the faces is their view-depth step over the clip range.
          report.slope = (report.a.depth - report.b.depth) / (report.b.viewDepth - report.a.viewDepth);
          check(failures, '(c) slope', report.slope, 1 / (fr - n), 1e-5);
          const [ex, ey] = points.empty;
          report.empty = { depth: z.at(ex, ey), distance: d.at(ex, ey) };
          check(failures, '(c) empty depth', z.at(ex, ey), 0, 0);
          check(failures, '(c) empty distance', d.at(ex, ey), 0, 0);
          projection.dispose();
          await finish(f, failures);
          out.orthographic = { ...report, failures };
        } finally {
          f.close();
        }
      }

      // ---- (d) a WgslMaterial plane reading depth.distance with textureLoad ----
      {
        const f = await create(),
          failures = [];
        try {
          f.device.pushErrorScope('validation');
          slab(f.engine, [0, 0, faceA]);
          const depth = DepthTexture.attach(f.engine),
            scale = 10;
          // Red: the scene's distance / scale; green 1 where nothing is behind. Unlit, so only sRGB encoding applies.
          const material = new WgslMaterial({
            shading: 'basic',
            wgsl: `fn shade(i:Out,s:Surface)->Surface {var o=s;
  let behind=textureLoad(sceneDistance,vec2i(i.clip.xy),0).r;
  o.base=vec4f(behind/uniforms.scale,select(0.0,1.0,behind<=0.0),0.0,1.0);o.emissive=vec3f(0);return o;}`,
            uniforms: { scale },
            textures: {
              sceneDistance: new Texture({ data: new Float32Array(4), width: 1, height: 1, format: 'r32float' }),
            },
          });
          depth.onResize(() => (material.textures.sceneDistance = new Texture(depth.distance)));
          // A plane at z = 1, in front of slab A and not added to the depth, covering the whole view.
          const plane = createMesh(
            f.engine,
            {
              positions: [-8, -6, 0, 8, -6, 0, -8, 6, 0, 8, 6, 0],
              normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
              uvs: [0, 1, 1, 1, 0, 0, 1, 0],
              indices: [0, 1, 2, 2, 1, 3],
            },
            material,
          );
          plane.root.setPosition([0, 0, 1]);
          const color = f.device.createTexture({
            size: [W, H],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
          const views = [{ camera: f.engine.camera, viewport: [0, 0, 1, 1], target: { color } }];
          f.engine.render({ culling: false, views });
          f.engine.render({ culling: false, views });
          const camera = f.engine.camera,
            points = samplePoints(camera),
            image = await read(f.device, color),
            d = await read(f.device, depth.distance);
          const encode = (v) => {
            const x = Math.min(Math.max(v, 0), 1);
            return Math.round(255 * (x < 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
          };
          const [ax, ay] = points.a,
            want = hit(camera, [ax, ay], full, faceA),
            [ex, ey] = points.empty;
          const report = {
            pixel: [ax, ay],
            rgba: image.rgba(ax, ay),
            distance: d.at(ax, ay),
            expectedDistance: want.distance,
            expectedRed: encode(want.distance / scale),
            emptyRgba: image.rgba(ex, ey),
          };
          check(failures, '(d) material red', report.rgba[0], report.expectedRed, 1);
          check(failures, '(d) material green over the slab', report.rgba[1], 0, 1);
          check(failures, '(d) empty red', report.emptyRgba[0], 0, 1);
          check(failures, '(d) empty green', report.emptyRgba[1], 255, 1);
          check(failures, '(d) the plane is not in the depth', relative(report.distance, want.distance), 0, 1e-5);
          await finish(f, failures);
          color.destroy();
          plane.destroy?.();
          out.material = { ...report, failures };
        } finally {
          f.close();
        }
      }

      // ---- (g) two views with their own cameras ----
      {
        const f = await create(),
          failures = [];
        try {
          f.device.pushErrorScope('validation');
          scene(f.engine);
          const depth = DepthTexture.attach(f.engine),
            other = new Camera({ position: [0.5, 0.2, 9], target: [0.5, 0.2, 0], near, far });
          const rects = [
            [0, 0, W / 2, H],
            [W / 2, 0, W / 2, H],
          ];
          f.engine.render({
            culling: false,
            views: [
              { camera: f.engine.camera, viewport: rects[0], pixels: true },
              { camera: other, viewport: rects[1], pixels: true },
            ],
          });
          // Each view's camera.matrix is of its own (half-width) aspect after the frame.
          const z = await read(f.device, depth.texture),
            d = await read(f.device, depth.distance),
            report = [];
          [f.engine.camera, other].forEach((camera, i) => {
            const rect = rects[i],
              [px, py] = pixelOf(camera, [0.3, 0.2, faceA], rect),
              want = hit(camera, [px, py], rect, faceA),
              [ex, ey] = [rect[0] + 2, 2];
            report.push({
              view: i,
              pixel: [px, py],
              depth: z.at(px, py),
              expectedDepth: want.depth,
              distance: d.at(px, py),
              expectedDistance: want.distance,
              emptyDistance: d.at(ex, ey),
            });
            check(failures, `(g) view ${i} depth`, z.at(px, py), want.depth, 1e-6);
            check(failures, `(g) view ${i} distance`, relative(d.at(px, py), want.distance), 0, 1e-5);
            check(failures, `(g) view ${i} empty`, d.at(ex, ey), 0, 0);
          });
          if (Math.abs(report[0].distance - report[1].distance) < 1)
            failures.push('(g) the two cameras should see different distances');
          await finish(f, failures);
          out.views = { report, failures };
        } finally {
          f.close();
        }
      }

      // ---- (h) materials meshes: added draws into the depth, not added does not ----
      {
        const f = await create(),
          failures = [];
        try {
          f.device.pushErrorScope('validation');
          const depth = DepthTexture.attach(f.engine),
            quad = {
              positions: [-0.75, -0.75, 0, 0.75, -0.75, 0, -0.75, 0.75, 0, 0.75, 0.75, 0],
              normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
              uvs: [0, 1, 1, 1, 0, 0, 1, 0],
              indices: [0, 1, 2, 2, 1, 3],
            };
          const face = 0.5,
            added = createMesh(f.engine, quad, new Material({ color: '#ffffff', doubleSided: true })),
            left = createMesh(f.engine, quad, new Material({ color: '#ffffff', doubleSided: true }));
          added.root.setPosition([-1.5, 0, face]);
          left.root.setPosition([1.5, 0, face]);
          const remove = depth.add(added);
          f.engine.render({ culling: false });
          const camera = f.engine.camera,
            pa = pixelOf(camera, [-1.4, 0.1, face], full),
            pb = pixelOf(camera, [1.6, 0.1, face], full),
            want = hit(camera, pa, full, face);
          let z = await read(f.device, depth.texture),
            d = await read(f.device, depth.distance);
          const report = {
            added: { pixel: pa, depth: z.at(...pa), expectedDepth: want.depth, distance: d.at(...pa) },
            expectedDistance: want.distance,
            notAdded: { pixel: pb, depth: z.at(...pb), distance: d.at(...pb) },
          };
          check(failures, '(h) added depth', report.added.depth, want.depth, 1e-6);
          check(failures, '(h) added distance', relative(report.added.distance, want.distance), 0, 1e-5);
          check(failures, '(h) not-added depth', report.notAdded.depth, 0, 0);
          check(failures, '(h) not-added distance', report.notAdded.distance, 0, 0);
          // Removed: the next frame leaves it out too.
          remove();
          f.engine.render({ culling: false });
          z = await read(f.device, depth.texture);
          d = await read(f.device, depth.distance);
          report.removed = { depth: z.at(...pa), distance: d.at(...pa) };
          check(failures, '(h) removed depth', report.removed.depth, 0, 0);
          await finish(f, failures);
          out.models = { ...report, failures };
        } finally {
          f.close();
        }
      }

      // ---- (i) a canvas view and a smaller target view every frame ----
      {
        const f = await create(),
          failures = [];
        try {
          f.device.pushErrorScope('validation');
          scene(f.engine);
          const depth = DepthTexture.attach(f.engine),
            create = f.device.createTexture.bind(f.device);
          let made = 0;
          f.device.createTexture = (descriptor) => {
            if (descriptor.format === 'r32float' || descriptor.format === 'depth32float') made++;
            return create(descriptor);
          };
          const color = create({
            size: [48, 32],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
          const views = [
            { camera: f.engine.camera, viewport: [0, 0, 1, 1] },
            { camera: f.engine.camera, viewport: [0, 0, 1, 1], target: { color } },
          ];
          const counts = [];
          for (let frame = 0; frame < 4; frame++) {
            made = 0;
            f.engine.render({ culling: false, views });
            await f.device.queue.onSubmittedWorkDone();
            counts.push(made);
          }
          const last = [depth.texture.width, depth.texture.height];
          if (counts.slice(1).some((n) => n)) failures.push(`(i) steady frames created textures: ${counts}`);
          if (last[0] !== 48) failures.push('(i) the last view drawn sets the current size');
          f.device.createTexture = create;
          await finish(f, failures);
          color.destroy();
          out.destinations = { texturesPerFrame: counts, lastSize: last, failures };
        } finally {
          f.close();
        }
      }
      delete globalThis.margoLow;
      return out;
    }, samples);

  // ---- (f) 4x equals 1x away from edges ----
  const one = runs[1].perspective.grid,
    four = runs[4].perspective.grid,
    W = 128,
    H = 96;
  let compared = 0,
    maxDepth = 0,
    maxDistance = 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      // Only texels whose 3 x 3 neighbourhood is one surface at 1x (no silhouette edge nearby).
      const i = y * W + x,
        around = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1].map((o) => one.distance[i + o]);
      if (around.some((v) => Math.abs(v - one.distance[i]) > 0.05)) continue;
      compared++;
      maxDepth = Math.max(maxDepth, Math.abs(one.depth[i] - four.depth[i]));
      maxDistance = Math.max(maxDistance, Math.abs(one.distance[i] - four.distance[i]));
    }
  const msaa = { comparedTexels: compared, maxDepthDifference: maxDepth, maxDistanceDifference: maxDistance };
  for (const samples of [1, 4]) {
    delete runs[samples].perspective.grid;
    for (const [name, result] of Object.entries(runs[samples]))
      assert.deepEqual(result.failures, [], `${samples}x ${name}`);
  }
  assert.ok(compared > 4000, `(f) too few interior texels compared: ${compared}`);
  assert.ok(maxDepth <= 1e-6 && maxDistance <= 1e-4, `(f) 4x differs from 1x: ${JSON.stringify(msaa)}`);
  assert.deepEqual(pageErrors, []);
  const report = { hardware, runs, msaa };
  await writeFile('test-results/depth-browser.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  release();
}
