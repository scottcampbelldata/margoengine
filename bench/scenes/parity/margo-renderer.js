// Margo implementation of the parity renderer scenes (../parity.js, area 'renderer').
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { CLEAR, LIGHT, PALETTE } from '../catalog.js';
import { app, composer, engineFor, floor, meshes, palette, single } from '../margo.js';

const camera = (c) => ({ fov: c.fov, near: c.near, far: c.far, position: c.at(0), target: c.target });
const lit = (engine) => {
  const { lighting } = engineRuntime(engine);
  lighting.direction.set([...LIGHT.direction, LIGHT.intensity]);
  lighting.radiance.set([1, 1, 1, LIGHT.ambient]);
  return engine;
};
/** engineFor with extra Engine.create options (backend, fallback, exactSize). */
async function engineWith(canvas, c, capacity, marks, options) {
  const s = performance.now(),
    engine = await Engine.create(canvas, { backend: 'webgpu', capacity, camera: camera(c), ...options });
  marks.createMs = +(performance.now() - s).toFixed(1);
  return lit(engine);
}
const done = (marks, s) => (marks.buildMs = +(performance.now() - s).toFixed(1));
const lightDir = (() => {
  const [x, y, z] = LIGHT.direction,
    l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
})();
/** WebGL2: resolves when the GPU has finished the submitted commands (fence). */
function glIdle(gl) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  return new Promise((resolve) => {
    const poll = () => {
      if (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) return setTimeout(poll, 0);
      gl.deleteSync(sync);
      resolve();
    };
    poll();
  });
}
// A full-screen triangle from the vertex index (no attributes), sampling `map`.
const quadVertex = `
struct Out { @builtin(position) clip:vec4f, @location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Out(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}`;

export const builders = {
  async 'p-webgl2'(canvas, data, marks) {
    const { webglRenderer } = await import('@margoengine/webgl2-compat/preview'),
      engine = await engineWith(canvas, data.camera, data.items.length + 8, marks, {
        backend: 'webgl2',
        fallback: webglRenderer,
      }),
      s = performance.now();
    meshes(engine, data, palette(data));
    done(marks, s);
    const gl = canvas.getContext('webgl2');
    return {
      ...app(engine, () => {}, { camera: data.camera, note: `core meshes on ${engine.backend} (@margoengine/webgl2-compat/preview)` }),
      gl,
      idle: () => glIdle(gl),
    };
  },

  async 'p-msaa'(canvas, data, marks, { samples }) {
    if (samples !== 1 && samples !== 4) throw new RangeError(`p-msaa samples=${samples}: 1 or 4`);
    // 4x is core's desktop default; exactSize keeps the 1280 x 720 backbuffer and renders single-sampled.
    const engine =
        samples === 4
          ? await engineFor(canvas, data.camera, data.items.length + 8, marks)
          : await engineWith(canvas, data.camera, data.items.length + 8, marks, {
              exactSize: [canvas.width, canvas.height],
            }),
      s = performance.now();
    meshes(engine, data, palette(data));
    done(marks, s);
    return { ...app(engine, () => {}, { camera: data.camera }), samples };
  },

  async 'p-depth-range'(canvas, data, marks) {
    // Core's reversed-Z float depth is its default; one unit box scaled per item.
    const { box } = await import('@margoengine/core'),
      engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      materials = palette(data),
      geometry = box(1, 1, 1);
    for (const b of data.items)
      engine
        .createMesh()
        .setGeometry(geometry)
        .setMaterial(materials[b.color])
        .setPosition(b.position)
        .setRotation(b.rotation)
        .setScale([b.size, b.size, b.size]);
    done(marks, s);
    return app(engine, () => {}, { camera: data.camera, note: 'core reversed-Z depth32float' });
  },

  async 'p-custom-shader'(canvas, data, marks) {
    // @margoengine/shader/raw: one RawShaderMaterial (WGSL), one RawMesh per box.
    const engine = await engineFor(canvas, data.camera, 64, marks),
      s = performance.now(),
      [{ RawShaders, RawShaderMaterial, RawMesh }, { boxGeometry }] = await Promise.all([
        import('@margoengine/shader/raw'),
        import('@margoengine/geometry'),
      ]),
      at = await composer(),
      raw = RawShaders.attach(engine),
      g = boxGeometry(data.size, data.size, data.size),
      st = data.stripes;
    const material = new RawShaderMaterial({
      vertexShader: `
struct Out { @builtin(position) clip:vec4f, @location(0) world:vec3f, @location(1) normal:vec3f }
@vertex fn vertex(a:Attributes)->Out {
  let w = mesh.world * vec4f(a.position, 1.0);
  return Out(camera.viewProjection * w, w.xyz, mesh.normal * a.normal);
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let stripe = fract(dot(i.world, uniforms.axis) * uniforms.scale) > 0.5;
  let c = select(uniforms.b, uniforms.a, stripe);
  let lambert = max(dot(normalize(i.normal), uniforms.light), 0.0) * uniforms.intensity / 3.141592653589793;
  return margoDisplay(vec4f(c * lambert, 1.0));
}`,
      uniforms: {
        a: { value: st.a, type: 'vec3f' },
        b: { value: st.b, type: 'vec3f' },
        axis: { value: st.axis, type: 'vec3f' },
        scale: { value: st.scale, type: 'f32' },
        light: { value: lightDir, type: 'vec3f' },
        intensity: { value: LIGHT.intensity, type: 'f32' },
      },
    });
    const attributes = { position: { data: g.positions, type: 'vec3f' }, normal: { data: g.normals, type: 'vec3f' } };
    for (const b of data.items)
      raw.add(new RawMesh({ material, attributes, index: g.indices, matrix: at(b.position, b.rotation).elements }));
    done(marks, s);
    engine.render();
    await raw.ready();
    return {
      ...app(engine, () => {}, { camera: data.camera }),
      info: () => ({
        drawCalls: engine.stats.drawCalls + raw.stats.drawCalls,
        note: 'RawMesh per box (raw meshes are not frustum culled)',
      }),
    };
  },

  async 'p-node-material'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      [{ NodeMaterial, uniform, color, mix, smoothstep, sin, positionWorld }, { createMesh }, { boxGeometry }] =
        await Promise.all([
          import('@margoengine/shader'),
          import('@margoengine/materials'),
          import('@margoengine/geometry'),
        ]),
      m = data.mix,
      time = uniform(0, { name: 'time' }),
      k = smoothstep(m.edge0, m.edge1, sin(positionWorld.x.mul(m.frequency).add(time)).mul(0.5).add(0.5)),
      material = new NodeMaterial({
        roughness: 0.5,
        metalness: 0,
        ...single,
        colorNode: mix(color(m.a), color(m.b), k),
      }),
      geometry = boxGeometry(data.size, data.size, data.size);
    for (const b of data.items)
      createMesh(engine, geometry, material).root.setPosition(b.position).setRotation(b.rotation);
    done(marks, s);
    return app(engine, (t) => (time.value = t), { camera: data.camera, note: 'materials meshes, one NodeMaterial' });
  },

  async 'p-compute'() {
    // ComputePass integrates a storage buffer, but no Margo drawable reads one per point: @margoengine/points keeps its
    // own position buffer, and NodeMaterial / RawMesh have no instance index or storage input.
    throw new Error(
      'unsupported: drawing a ComputePass storage buffer as points (points owns its positions; no per-instance storage read in NodeMaterial or RawMesh)',
    );
  },

  async 'p-render-target'(canvas, data, marks) {
    // A view into a 1024 x 1024 rgba8unorm texture, then a second scene holding a full-screen raw triangle that samples
    // it. View targets follow the scene's sampling, so exactSize renders the engine single-sampled (the target has no MSAA).
    const engine = await engineWith(canvas, data.camera, data.items.length + 8, marks, {
        exactSize: [canvas.width, canvas.height],
      }),
      s = performance.now(),
      { RawShaders, RawShaderMaterial, RawMesh } = await import('@margoengine/shader/raw');
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    const color = engine.gpu.createTexture({
        label: 'parity:target',
        size: [data.target, data.target],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
      screen = engine.createScene('screen'),
      raw = new RawShaders();
    screen.use(raw);
    raw.add(
      new RawMesh({
        material: new RawShaderMaterial({
          vertexShader: `${quadVertex}
@fragment fn fragment(i:Out)->@location(0) vec4f { return textureSample(map, mapSampler, i.uv); }`,
          textures: { map: color },
          depthTest: false,
          depthWrite: false,
          cull: 'none',
        }),
        vertexCount: 3,
      }),
    );
    const views = [
      { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color } },
      { camera: engine.camera, viewport: [0, 0, 1, 1], scene: screen },
    ];
    done(marks, s);
    engine.render({ views });
    await raw.ready();
    return {
      ...app(engine, () => {}, { camera: data.camera }),
      samples: 1,
      render(t) {
        engine.camera.position = data.camera.at(t);
        engine.render({ views });
      },
      info: () => ({ drawCalls: engine.stats.drawCalls, note: 'view target 1024^2 rgba8unorm + raw quad; 1x MSAA' }),
    };
  },

  async 'p-mrt'(canvas, data, marks) {
    // SceneTargets writes albedo (rgba8unorm), world normal (rgba16float) and camera distance (r32float) in one pass;
    // a full-screen raw triangle drawn after the scene shows the albedo target.
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      [{ SceneTargets }, { RawShaders, RawShaderMaterial, RawMesh }] = await Promise.all([
        import('@margoengine/post/mrt'),
        import('@margoengine/shader/raw'),
      ]);
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    const [r, g, b] = CLEAR.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)),
      targets = SceneTargets.attach(engine, {
        outputs: {
          color: { value: 'albedo', format: 'rgba8unorm', clear: { r, g, b, a: 1 } },
          normal: { value: 'normal', format: 'rgba16float' },
          depth: { value: 'distance', format: 'r32float' },
        },
      }),
      raw = RawShaders.attach(engine),
      material = new RawShaderMaterial({
        vertexShader: `${quadVertex}
@fragment fn fragment(i:Out)->@location(0) vec4f { return margoEncode(vec4f(textureSample(map, mapSampler, i.uv).rgb, 1.0)); }`,
        textures: { map: { texture: null } },
        depthTest: false,
        depthWrite: false,
        cull: 'none',
      });
    raw.add(new RawMesh({ material, vertexCount: 3 }));
    const bind = () => (material.textures.map.texture = targets.texture('color'));
    targets.onResize(bind);
    done(marks, s);
    engine.render();
    bind();
    await raw.ready();
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'SceneTargets pass + core main pass (hidden under the quad) + raw quad',
    });
  },

  async 'p-clipping'(canvas, data, marks) {
    // materials clippingPlanes (union, the default), one materials mesh per box.
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      [{ Material, createMesh }, { boxGeometry }] = await Promise.all([
        import('@margoengine/materials'),
        import('@margoengine/geometry'),
      ]),
      paints = PALETTE.map(
        (color) => new Material({ color, ...data.material, ...single, clippingPlanes: data.planes }),
      ),
      geometry = boxGeometry(data.size, data.size, data.size);
    for (const b of data.items)
      createMesh(engine, geometry, paints[b.color]).root.setPosition(b.position).setRotation(b.rotation);
    done(marks, s);
    return app(engine, () => {}, { camera: data.camera, note: 'materials meshes with clippingPlanes' });
  },
};
