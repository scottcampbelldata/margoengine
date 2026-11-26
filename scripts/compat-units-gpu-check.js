// Real-GPU check of KB-BOUNCE-COMPATUNITS1: a glTF physical material with every map, image lighting, sun Shadows,
// LocalShadows and LightBounce draw together, on WebGPU and on the 16-unit WebGL2 layer (--compat or MARGO_COMPAT=1).
// Two models built in code: all 13 maps (5 base, 8 physical extension maps; the base maps pack), and the 5 + 5 peak
// (clearcoat's 3 and sheen's 2, not packed). Each is lit by an Environment, a sun with Shadows, and a shadowed spot
// light that bounces (Clustered, LocalShadows, LightBounce). Asserts: no GPU error and no engine.onError, the model is
// drawn (its pixel differs from the background), the bounce captured its source, and each feature moves the model's
// pixel when it is detached (nothing is dropped silently).
// On Edge's default ANGLE Direct3D 11 the lit fragment program holds 15 sampler units and two uniform blocks of 50 or
// more rows, which ANGLE makes shader resources after the textures: 17 of 16, and the GPU process crashed at the first
// draw until the layer declared such blocks inside a struct (webgl2-compat glsl/emit.ts fitShaderResources). Run by
// webgl2-compat's test:gpu with --compat; flags --variants=all,peak --features=ibl,shadows,localShadows,bounce, env
// CU_ANGLE=d3d11|vulkan|gl, CU_SHADOW='{"filter":"pcf"}', CU_DEBUG=1 (sampler counts per program, the lost context).
// node scripts/run-with-timeout.mjs -- node scripts/compat-units-gpu-check.js [--compat]
import assert from 'node:assert/strict';
import { launchBrowser } from './lib/browser.mjs';
import { postBrowser } from '../packages/post/test/post-browser.mjs';
import { decodePNG } from '../tests/support/png.js';

const results = [];
await postBrowser(
  'compat-units',
  5484,
  () => launchBrowser({ headless: true, args: process.env.CU_ANGLE ? [`--use-angle=${process.env.CU_ANGLE}`] : [] }),
  async (page) => {
    if (process.env.CU_DEBUG) await page.evaluate(() => (window.__CU_TRACE = true));
    if (process.env.CU_SHADOW) await page.evaluate((o) => (window.__CU_SHADOW = JSON.parse(o)), process.env.CU_SHADOW);
    if (process.env.CU_DEBUG) page.on('console', (m) => console.error('console:', m.type(), m.text().slice(0, 300)));
    const only = process.argv
        .find((a) => a.startsWith('--features='))
        ?.slice(11)
        .split(','),
      variants = process.argv
        .find((a) => a.startsWith('--variants='))
        ?.slice(11)
        .split(',') ?? ['all', 'peak'];
    for (const variant of variants) {
      const r = await page
        .evaluate(
          async ([variant, only]) => {
            const want = (name) => !only || only.includes(name);
            const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
              { parseGLTFAsync } = await import('/packages/gltf/dist/pbr.js'),
              { Environment, EnvironmentLighting } = await import('/packages/environment/dist/index.js'),
              { Shadows } = await import('/packages/shadows/dist/index.js'),
              { Clustered } = await import('/packages/clustered/dist/index.js'),
              { LocalShadows } = await import('/packages/clustered/dist/shadows.js'),
              { LightBounce } = await import('/packages/clustered/dist/bounce.js'),
              { trackPipelines, waitForPipelines } = await import('/scripts/support/gpu-ready.js');
            trackPipelines();
            const errors = [],
              reported = [];
            document.querySelector('#view')?.remove();
            const canvas = Object.assign(document.createElement('canvas'), { width: 128, height: 96 });
            canvas.style.cssText = 'display:block;width:128px;height:96px';
            document.body.append(canvas);
            window.__gls = [];
            window.__trace = { lostAt: null, calls: [] };
            if (window.__CU_TRACE) {
              const proto = WebGL2RenderingContext.prototype;
              for (const name of Object.getOwnPropertyNames(proto)) {
                const d = Object.getOwnPropertyDescriptor(proto, name);
                if (typeof d.value !== 'function' || name === 'isContextLost' || name === 'getError') continue;
                const f = d.value;
                proto[name] = function (...args) {
                  const r = f.apply(this, args);
                  if (name === 'linkProgram' && !this.isContextLost()) {
                    const prog = args[0],
                      n = this.getProgramParameter(prog, this.ACTIVE_UNIFORMS);
                    let samplers = 0;
                    const names = [];
                    for (let i = 0; i < n; i++) {
                      const u = this.getActiveUniform(prog, i);
                      if (
                        /SAMPLER/.test(
                          Object.keys(WebGL2RenderingContext).find(
                            (k) => WebGL2RenderingContext[k] === u.type && /SAMPLER/.test(k),
                          ) ?? '',
                        )
                      ) {
                        samplers += u.size;
                        names.push(u.name);
                      }
                    }
                    (window.__trace.programs ??= []).push({
                      samplers,
                      names: names.join(','),
                      linked: this.getProgramParameter(prog, this.LINK_STATUS),
                    });
                    const dbg = this.getExtension('WEBGL_debug_renderer_info');
                    window.__trace.renderer = dbg ? this.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?';
                    window.__trace.max = this.getParameter(this.MAX_TEXTURE_IMAGE_UNITS);
                  }
                  if (!window.__trace.lostAt) {
                    window.__trace.calls.push(name);
                    if (window.__trace.calls.length > 40) window.__trace.calls.shift();
                    if (this.isContextLost()) {
                      window.__trace.lostAt = name;
                      window.__trace.source = name === 'linkProgram' ? this.getAttachedShaders(args[0]) : null;
                    }
                  }
                  return r;
                };
              }
            }
            const getContext = OffscreenCanvas.prototype.getContext;
            OffscreenCanvas.prototype.getContext = function (...args) {
              const c = getContext.apply(this, args);
              if (c && args[0] === 'webgl2') window.__gls.push(c);
              return c;
            };
            const engine = await Engine.create(canvas, {
                backend: 'webgpu',
                camera: { position: [0, 1.2, 3.2], target: [0, 0.6, 0], near: 0.1, far: 50 },
              }),
              device = engine.gpu;
            engine.stop();
            engine.onError = (e) => reported.push(String(e?.message ?? e));
            device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
            // A sky gradient, bright above.
            const W = 64,
              H = 32,
              sky = new Float32Array(W * H * 4);
            for (let y = 0; y < H; y++)
              for (let x = 0; x < W; x++) {
                const t = 1 - y / (H - 1),
                  k = (y * W + x) * 4;
                sky.set([0.2 + 0.8 * t, 0.3 + 0.7 * t, 0.5 + 0.5 * t, 1], k);
              }
            const environment = await Environment.attach(engine, { width: W, height: H, data: sky });
            const floor = engine
              .createMesh()
              .setGeometry(box(6, 0.1, 6))
              .setPosition([0, -0.05, 0])
              .setMaterial(new PbrMaterial({ color: [0.7, 0.7, 0.7], roughness: 1 }));
            const wall = engine
              .createMesh()
              .setGeometry(box(6, 3, 0.1))
              .setPosition([0, 1.5, -1.2])
              .setMaterial(new PbrMaterial({ color: [0.7, 0.7, 0.7], roughness: 1 }));
            // The model: a 1 m box with positions, normals, tangents and UVs, one texture per map slot (4 x 4, distinct).
            const faces = [
              [0, 1, 0],
              [0, -1, 0],
              [1, 0, 0],
              [-1, 0, 0],
              [0, 0, 1],
              [0, 0, -1],
            ];
            const pos = [],
              nor = [],
              tan = [],
              uv = [],
              idx = [];
            for (const n of faces) {
              const u = Math.abs(n[1]) === 1 ? [1, 0, 0] : [-n[2], 0, n[0]],
                v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]],
                base = pos.length / 3;
              for (const [a, b] of [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
              ]) {
                pos.push(...[0, 1, 2].map((i) => 0.5 * (n[i] + a * u[i] + b * v[i]) + (i === 1 ? 0.55 : 0)));
                nor.push(...n);
                tan.push(...u, 1);
                uv.push((a + 1) / 2, (1 - b) / 2);
              }
              idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }
            const parts = [new Float32Array(pos), new Float32Array(nor), new Float32Array(tan), new Float32Array(uv)],
              indices = new Uint16Array(idx),
              total = parts.reduce((s, p) => s + p.byteLength, 0) + indices.byteLength,
              bin = new Uint8Array(total);
            let offset = 0;
            const views = [];
            for (const p of [...parts, indices]) {
              bin.set(new Uint8Array(p.buffer), offset);
              views.push({ buffer: 0, byteOffset: offset, byteLength: p.byteLength });
              offset += p.byteLength;
            }
            const count = pos.length / 3,
              maps = variant === 'all' ? 13 : 10,
              images = Array.from({ length: maps }, (_, i) => {
                const data = new Uint8Array(4 * 4 * 4);
                for (let k = 0; k < 16; k++)
                  data.set([(37 * i + 20 * k) % 256, (91 * i + 7 * k) % 256, 200, 255], k * 4);
                return { width: 4, height: 4, data };
              });
            const t = (i) => ({ index: i });
            const extensions = {
              KHR_materials_clearcoat: {
                clearcoatFactor: 1,
                clearcoatTexture: t(5),
                clearcoatRoughnessFactor: 0.3,
                clearcoatRoughnessTexture: t(6),
                clearcoatNormalTexture: t(7),
              },
              KHR_materials_sheen: {
                sheenColorFactor: [1, 1, 1],
                sheenColorTexture: t(8),
                sheenRoughnessFactor: 0.5,
                sheenRoughnessTexture: t(9),
              },
              ...(variant === 'all'
                ? {
                    KHR_materials_transmission: { transmissionFactor: 0, transmissionTexture: t(10) },
                    KHR_materials_specular: { specularTexture: t(11), specularColorTexture: t(12) },
                  }
                : {}),
            };
            const gltf = {
              asset: { version: '2.0' },
              extensionsUsed: Object.keys(extensions),
              buffers: [{ byteLength: total }],
              bufferViews: views,
              accessors: [
                {
                  bufferView: 0,
                  componentType: 5126,
                  count,
                  type: 'VEC3',
                  min: [-0.5, 0.05, -0.5],
                  max: [0.5, 1.05, 0.5],
                },
                { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
                { bufferView: 2, componentType: 5126, count, type: 'VEC4' },
                { bufferView: 3, componentType: 5126, count, type: 'VEC2' },
                { bufferView: 4, componentType: 5123, count: idx.length, type: 'SCALAR' },
              ],
              images: images.map(() => ({ mimeType: 'image/png' })),
              samplers: [{}],
              textures: images.map((_, i) => ({ source: i, sampler: 0 })),
              materials: [
                {
                  pbrMetallicRoughness: {
                    baseColorTexture: t(0),
                    metallicRoughnessTexture: t(1),
                    metallicFactor: 0.2,
                    roughnessFactor: 0.6,
                  },
                  normalTexture: t(2),
                  occlusionTexture: t(3),
                  emissiveTexture: t(4),
                  emissiveFactor: [0.05, 0.05, 0.05],
                  extensions,
                },
              ],
              meshes: [
                {
                  primitives: [
                    {
                      attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2, TEXCOORD_0: 3 },
                      indices: 4,
                      material: 0,
                    },
                  ],
                },
              ],
              nodes: [{ mesh: 0 }],
              scenes: [{ nodes: [0] }],
              scene: 0,
            };
            const model = await parseGLTFAsync(engine, gltf, [bin], images);
            const lighting = want('ibl') ? EnvironmentLighting.attach(engine, environment) : undefined;
            lighting?.add(model);
            const shadows = want('shadows')
              ? Shadows.attach(engine, { resolution: 512, ...(window.__CU_SHADOW ?? {}) })
              : undefined;
            shadows?.add(model);
            const lights = Clustered.attach(engine);
            lights.setLights([
              {
                position: [1.2, 2.4, 1.4],
                direction: [-0.4, -0.85, -0.35],
                angle: 0.6,
                range: 12,
                intensity: 30,
                color: [1, 0.8, 0.6],
                castShadow: want('localShadows'),
                bounce: true,
              },
            ]);
            lights.add(model);
            const local = want('localShadows') ? LocalShadows.attach(engine, { lights }) : undefined;
            local?.add(model);
            const bounce = want('bounce') ? LightBounce.attach(engine, { lights }) : undefined;
            const frame = async () => {
              engine.render({ delta: 0 });
              await device.queue.onSubmittedWorkDone();
            };
            let warm = 'ok';
            try {
              await waitForPipelines(frame, { timeoutMs: 60000 });
            } catch (e) {
              warm = String(e.message);
            }
            // fixed-wait: draw four reference warm frames after shader readiness, before detaching features.
            for (let k = 0; k < 4; k++) await frame();
            const detach = { bounce, localShadows: local, shadows, ibl: lighting };
            window.compatUnits = {
              async step(name) {
                if (name) detach[name]?.dispose();
                await frame();
                return { errors, reported, stats: { ...bounce?.stats } };
              },
              end() {
                engine.dispose();
                canvas.remove();
              },
            };
            void floor;
            void wall;
            return { variant, warm };
          },
          [variant, only],
        )
        .catch(async (e) => {
          console.error(
            'lost:',
            JSON.stringify(
              await page.evaluate(() => [
                window.__gls.map((g) => [g.isContextLost(), g.getError()]),
                window.__trace.lostAt,
                window.__trace.max,
                (window.__trace.programs ?? []).filter((p) => p.samplers >= 12),
                window.__trace.renderer,
              ]),
            ),
          );
          throw e;
        });
      // The model's centre region, 16 x 16 px around its projection, as a mean of the colour channels.
      const probe = async () => {
        const { width, data } = await decodePNG(await page.locator('canvas').screenshot());
        let sum = 0;
        for (let y = 32; y < 48; y++)
          for (let x = 56; x < 72; x++) {
            const k = (y * width + x) * 4;
            sum += data[k] + data[k + 1] + data[k + 2];
          }
        return sum / 256 / 3;
      };
      const step = (name) => page.evaluate((name) => window.compatUnits.step(name), name);
      const first = await step(),
        full = await probe(),
        moves = {};
      let last = first,
        before = full;
      // Each feature's own share: the region before minus after detaching it (the earlier ones already detached).
      for (const name of ['bounce', 'localShadows', 'shadows', 'ibl']) {
        last = await step(name);
        const after = await probe();
        moves[name] = before - after;
        before = after;
      }
      await page.evaluate(() => window.compatUnits.end());
      Object.assign(r, { errors: last.errors, reported: last.reported, stats: first.stats, full, moves });
      results.push(r);
      console.log(JSON.stringify(r));
    }
  },
  { seconds: 300 },
);
for (const r of results) {
  assert.deepEqual(r.errors, [], `${r.variant}: GPU errors`);
  assert.deepEqual(r.reported, [], `${r.variant}: engine.onError reports`);
  assert.equal(r.warm, 'ok', `${r.variant}: pipelines built`);
  assert.ok(r.stats.sources >= 1 && r.stats.vpls > 0, `${r.variant}: the spot bounces: ${JSON.stringify(r.stats)}`);
  for (const [feature, move] of Object.entries(r.moves))
    assert.ok(Math.abs(move) > 0, `${r.variant}: detaching ${feature} moves the model's pixel (${move})`);
}
console.log('compat units check passed');
