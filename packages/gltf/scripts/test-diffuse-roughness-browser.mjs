// Real-GPU check of KHR_materials_diffuse_roughness against the CPU oracle (test/support/eon-reference.js), on WebGPU
// and, with --compat or MARGO_COMPAT=1, on the WebGL2 compatibility layer:
// 1. the shipped direct-light WGSL (reflected and diffusely transmitted lobes) and ambient albedo, case by case;
// 2. pictures through the engine: a rough quad equals a near-Lambert quad whose base colour is the oracle's value,
//    under the sun, the hemisphere ambient and image-based lighting; the R texture and a materials mesh draw the same.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
import { direct as specReference, vec } from '../../../tests/support/khr-brdf.js';
import { eonAlbedo, eonBRDF, direction } from '../test/support/eon-reference.js';

let seed = 4711;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const unit = () => direction(Math.acos(0.05 + random() * 0.95), random() * 2 * Math.PI);
const cases = Array.from({ length: 64 }, (_, k) => {
  const v = unit(),
    l = k % 4 === 3 ? vec.scale(unit(), -1) : unit();
  return {
    base: [random(), random(), random()],
    roughness: 0.2 + random() * 0.8,
    diffuse: k % 7 === 0 ? 1 : random(),
    transmission: k % 5 === 0 ? random() : 0,
    dt: { factor: k % 4 >= 2 ? random() : 0, color: [random(), random(), random()] },
    v,
    l,
  };
});
/** margoDirect as the specs define it: gltf/pbr's specular plus the weighted EON lobes. */
function expectedDirect(c) {
  const { v, l } = c,
    specular = specReference(
      {
        base: [0, 0, 0],
        metal: 0,
        roughness: c.roughness,
        f0: [0.04, 0.04, 0.04],
        specular: 1,
        transmission: c.transmission,
        n: [0, 0, 1],
        t: [1, 0, 0],
        anisotropy: 0,
        iridescence: { factor: 0, fresnel: [0, 0, 0] },
        diffuseTransmission: { factor: c.dt.factor, color: [0, 0, 0] },
      },
      v,
      l,
    ),
    h = vec.normalize(vec.add(v, l)),
    vh = Math.min(Math.max(vec.dot(v, h), 0), 1),
    kd = 1 - (0.04 + 0.96 * (1 - vh) ** 5),
    nl = Math.max(l[2], 0),
    back = Math.max(-l[2], 0);
  return c.base.map((rho, i) => {
    const front = nl ? eonBRDF(rho, c.diffuse, l, v) * (1 - c.dt.factor) * nl : 0,
      through = back ? eonBRDF(c.dt.color[i], c.diffuse, [l[0], l[1], -l[2]], v) * c.dt.factor * back : 0;
    return specular[i] + kd * (1 - c.transmission) * (front + through);
  });
}

// Pictures: the camera and sun directions at the quad's centre, whose normal is +z.
const rho = [0.7, 0.45, 0.2],
  roughness = 0.9,
  head = direction(0),
  grazing = direction(1.2),
  sun = direction(0.9, 2.5);
const lambertBase = (v) => rho.map((c) => eonBRDF(c, roughness, sun, v) * Math.PI);
const views = [head, grazing].map((v) => ({
  v,
  direct: lambertBase(v),
  ambient: rho.map((c) => eonAlbedo(c, roughness, v[2])),
}));

const compat = process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1';
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (error) => errors.push(error.message));
    const out = await browser.page.evaluate(
      async ({ cases, views, sun, rho, roughness }) => {
        const { Engine } = await import('/packages/core/dist/index.js'),
          { parseGLTF } = await import('/packages/gltf/dist/pbr.js'),
          { extendedMaterials } = await import('/packages/gltf/dist/extended.js'),
          shader = await import('/packages/gltf/src/shader.ts'),
          { dielectricFresnelWGSL } = await import('/packages/shared/pbr-fresnel.js'),
          environmentPackage = await import('/packages/environment/dist/index.js'),
          { Material, Texture, createMesh } = await import('/packages/materials/dist/index.js'),
          { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 65;
        canvas.style.cssText = 'width:65px;height:65px';
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 0, 4], target: [0, 0, 0] },
          }),
          device = engine.gpu,
          validation = [];
        engine.stop();
        device.addEventListener('uncapturederror', (e) => validation.push(e.error.message));
        device.pushErrorScope('validation');

        // 1. The shipped WGSL, one fragment per case: row 0 direct light, row 1 ambient albedo.
        const features = {
            iridescence: false,
            anisotropy: false,
            diffuseTransmission: true,
            diffuseRoughness: true,
          },
          surface = shader.extendedShader(shader.extendedPlan([], features)).match(/struct Surface \{[^}]*\}/)[0],
          module = device.createShaderModule({
            code: `@group(0) @binding(0) var<uniform> input:array<vec4f,${cases.length * 5}>;
${surface}
${dielectricFresnelWGSL}${shader.eonWgsl}${shader.directWgsl(false, false, true)}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
@fragment fn main(@builtin(position) p:vec4f)->@location(0) vec4f {
  let k=u32(p.x)*5u; let a=input[k]; let b=input[k+1u]; let c=input[k+2u]; let v=input[k+3u].xyz; let l=input[k+4u].xyz;
  var s:Surface; s.base=vec4f(a.rgb,1); s.roughness=a.w; s.metal=0; s.f0=vec3f(0.04); s.sw=1; s.tr=b.y; s.n=vec3f(0,0,1);
  s.dt=c; s.ir=vec4f(0); s.dr=vec2f(b.x,max(v.z,0.0001));
  if(p.y<1.0){return vec4f(margoDirect(s,v,l),1);}
  return vec4f(margoEONAlbedo(s.base.rgb,s.dr.x,s.dr.y),1);
}`,
          }),
          pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: { module, entryPoint: 'main', targets: [{ format: 'rgba32float' }] },
          }),
          packed = new Float32Array(
            cases.flatMap((c) => [
              ...c.base,
              c.roughness,
              c.diffuse,
              c.transmission,
              0,
              0,
              ...c.dt.color,
              c.dt.factor,
              ...c.v,
              0,
              ...c.l,
              0,
            ]),
          ),
          uniform = device.createBuffer({
            size: packed.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          }),
          target = device.createTexture({
            size: [cases.length, 2],
            format: 'rgba32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          }),
          stride = Math.ceil((cases.length * 16) / 256) * 256,
          read = device.createBuffer({ size: stride * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        device.queue.writeBuffer(uniform, 0, packed);
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginRenderPass({
            colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
          });
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniform } }],
          }),
        );
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: stride }, [cases.length, 2]);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(read.getMappedRange().slice(0)),
          rows = [0, 1].map((y) => Array.from(values.subarray((y * stride) / 4, (y * stride) / 4 + cases.length * 4)));
        read.unmap();

        // 2. Pictures.
        const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
          normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
          indices = new Uint32Array([0, 1, 2, 0, 2, 3]),
          // A model closes its images on dispose, so each takes its own.
          bitmap = () =>
            createImageBitmap(new ImageData(new Uint8ClampedArray([128, 0, 0, 255]), 1, 1), {
              premultiplyAlpha: 'none',
              colorSpaceConversion: 'none',
            });
        const gltf = async (base, factor, textured) => {
          const buffers = [quad, normals, uvs, indices],
            doc = {
              asset: { version: '2.0' },
              buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
              bufferViews: buffers.map((b, buffer) => ({ buffer, byteLength: b.byteLength })),
              accessors: ['VEC3', 'VEC3', 'VEC2', 'SCALAR'].map((type, bufferView) => ({
                bufferView,
                type,
                componentType: bufferView === 3 ? 5125 : 5126,
                count: bufferView === 3 ? 6 : 4,
                ...(bufferView ? {} : { min: [-1, -1, 0], max: [1, 1, 0] }),
              })),
              images: [{}],
              textures: [{ source: 0 }],
              materials: [
                {
                  pbrMetallicRoughness: { baseColorFactor: [...base, 1], metallicFactor: 0 },
                  extensions: {
                    KHR_materials_diffuse_roughness: {
                      diffuseRoughnessFactor: factor,
                      ...(textured ? { diffuseRoughnessTexture: { index: 0 } } : {}),
                    },
                  },
                },
              ],
              meshes: [
                { primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] },
              ],
              nodes: [{ mesh: 0 }],
              scenes: [{ nodes: [0] }],
            };
          return parseGLTF(engine, doc, buffers, [await bitmap()], { materials: extendedMaterials });
        };
        const shot = async (made, lighting) => {
          const model = await made;
          lighting?.add(model);
          try {
            await waitForPipelines(async () => {
              engine.render({ delta: 0 });
              await device.queue.onSubmittedWorkDone();
            });
            return canvas.toDataURL('image/png');
          } finally {
            model.dispose();
          }
        };
        // A sky brighter above than below, so the image-based term depends on the lookup direction too.
        const sky = { width: 16, height: 8, data: new Float32Array(16 * 8 * 4) };
        for (let i = 0; i < 16 * 8; i++) sky.data.set(i < 64 ? [1.2, 1.1, 1, 1] : [0.3, 0.25, 0.2, 1], i * 4);
        const environment = await environmentPackage.Environment.attach(engine, sky),
          ibl = new environmentPackage.EnvironmentLighting(environment);
        const pictures = [];
        const none = 1e-6;
        for (const { v, direct, ambient } of views) {
          engine.camera.position = v.map((c) => c * 4);
          for (const [mode, replacement] of [
            ['direct', direct],
            ['hemisphere', ambient],
            ['ibl', ambient],
          ]) {
            engine.lighting.direction.set([...sun, mode === 'direct' ? 3 : 0]);
            engine.lighting.radiance.set([1, 1, 1, mode === 'direct' ? 0 : 1]);
            const light = mode === 'ibl' ? ibl : undefined;
            pictures.push({
              name: `${mode} nv ${v[2].toFixed(2)}`,
              rough: await shot(gltf(rho, roughness), light),
              oracle: await shot(gltf(replacement, none), light),
              lambert: await shot(gltf(rho, none), light),
            });
          }
        }
        engine.camera.position = [0, 0, 4];
        engine.lighting.direction.set([...sun, 3]);
        engine.lighting.radiance.set([1, 1, 1, 0.5]);
        const textured = await shot(gltf(rho, 1, true)),
          factor = await shot(gltf(rho, 128 / 255));
        const geometry = {
            positions: Array.from(quad),
            normals: Array.from(normals),
            uvs: Array.from(uvs),
            indices: Array.from(indices),
          },
          map = new Texture(await bitmap(), { colorSpace: 'linear' }),
          material = new Material({ color: [...rho, 1], roughness: 1, diffuseRoughness: 128 / 255 }),
          plainMesh = await shot(createMesh(engine, geometry, material));
        material.diffuseRoughness = 1;
        material.diffuseRoughnessMap = map;
        const mappedMesh = await shot(createMesh(engine, geometry, material));
        const scope = await device.popErrorScope();
        if (scope) validation.push(scope.message);
        engine.dispose();
        return { rows, pictures, textured, factor, plainMesh, mappedMesh, validation };
      },
      { cases, views, sun, rho, roughness },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(out.validation, []);
    // f32 against doubles and the polynomial albedo (0.1%): relative to max(|value|, 0.05).
    const worst = (gpu, cpu) =>
      cpu.reduce((m, v, i) => Math.max(m, Math.abs(gpu[i] - v) / Math.max(Math.abs(v), 0.05)), 0);
    const rgb = (row) => row.filter((_, i) => i % 4 < 3),
      directError = worst(rgb(out.rows[0]), cases.flatMap(expectedDirect)),
      albedoError = worst(
        rgb(out.rows[1]),
        cases.flatMap((c) => c.base.map((b) => eonAlbedo(b, c.diffuse, Math.max(c.v[2], 0.0001)))),
      );
    assert.ok(directError < 3e-3, `direct light differs from the oracle by ${directError}`);
    assert.ok(albedoError < 3e-3, `ambient albedo differs from the oracle by ${albedoError}`);
    const centre = async (url) => {
        const png = await decodePNG(Buffer.from(url.split(',')[1], 'base64')),
          at = (32 * 65 + 32) * 4;
        return Array.from(png.data.subarray(at, at + 3));
      },
      apart = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const pictures = [];
    for (const p of out.pictures) {
      const [rough, oracle, lambert] = await Promise.all([p.rough, p.oracle, p.lambert].map(centre));
      pictures.push({ name: p.name, rough, oracle, lambert });
    }
    const [textured, factor, plainMesh, mappedMesh] = await Promise.all(
      [out.textured, out.factor, out.plainMesh, out.mappedMesh].map(centre),
    );
    const report = {
      backend: compat ? 'webgl2-compat' : 'webgpu',
      worstRelativeError: { direct: directError, albedo: albedoError },
      pictures,
      texture: { textured, factor },
      materialsMesh: { plainMesh, mappedMesh },
    };
    console.log(JSON.stringify(report));
    writeFileSync(
      `test-results/gltf-diffuse-roughness${compat ? '-compat' : ''}.json`,
      JSON.stringify({ hardware: browser.hardware, ...report }, null, 2) + '\n',
    );
    for (const p of pictures) {
      assert.ok(Math.max(...p.rough) > 20, `${p.name}: lit`);
      assert.ok(apart(p.rough, p.oracle) <= 2, `${p.name}: ${p.rough} vs oracle ${p.oracle}`);
      assert.ok(apart(p.rough, p.lambert) > 3, `${p.name}: roughness shows, ${p.rough} vs ${p.lambert}`);
    }
    assert.ok(apart(textured, factor) <= 1, `R texture ${textured} vs factor ${factor}`);
    assert.ok(apart(plainMesh, factor) <= 2, `materials mesh ${plainMesh} vs glTF ${factor}`);
    assert.ok(apart(mappedMesh, plainMesh) <= 1, `materials map ${mappedMesh} vs factor ${plainMesh}`);
    console.log(`diffuse roughness: real-GPU check passed (${report.backend})`);
  },
  () => browser.close(),
);
