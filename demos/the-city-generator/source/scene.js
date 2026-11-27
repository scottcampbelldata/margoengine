import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { Shadows } from '@margoengine/shadows';

const ground = {
  road: 1, markings: 1, 'centre-lines': 1, kerb: 1, pavement: 1, paving: 1, lawn: 1,
};
const palettes = {
  'western-1910': {
    road: '#a99579', pavement: '#cdb599', paving: '#bf9e79', kerb: '#ae9374',
    lawn: '#a69e64', leaves: '#75845b', 'lamp-post': '#47493b', frames: '#675340',
    glass: '#4b5652', roof: '#8e775e', trim: '#bc9a6b', base: '#a08869', chimney: '#a4785c',
  },
  modern: {
    road: '#747a7d', pavement: '#bbb4a3', paving: '#9d9b8d', kerb: '#b5b2a5',
    lawn: '#8d9c70', leaves: '#5e845d', 'lamp-post': '#41474a', frames: '#9aa08d',
    glass: '#50676e', roof: '#72777b', trim: '#aea99a', base: '#909086', chimney: '#7d7470',
  },
};

function bevel(width, depth, y, levels) {
  const p = [], n = [], i = [];
  const corners = (offset, height) => [
    [-width / 2 + offset, height, -depth / 2 + offset],
    [-width / 2 + offset, height, depth / 2 - offset],
    [width / 2 - offset, height, depth / 2 - offset],
    [width / 2 - offset, height, -depth / 2 + offset],
  ];
  const faces = levels.map(([offset, level]) => corners(offset, y + level));
  function quad(a, b, c, d) {
    const first = p.length / 3;
    const u = a.map((v, index) => b[index] - v);
    const v = a.map((v, index) => c[index] - v);
    const cross = [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
    const span = Math.hypot(...cross);
    const normal = cross.map(component => component / span);
    p.push(...a, ...b, ...c, ...d);
    for (let vertex = 0; vertex < 4; vertex++) n.push(...normal);
    i.push(first, first+1, first+2, first, first+2, first+3);
  }
  for (let section = 1; section < faces.length; section++) {
    const previous = faces[section - 1], next = faces[section];
    for (let edge = 0; edge < 4; edge++) {
      const following = (edge + 1) % 4;
      quad(previous[edge], previous[following], next[following], next[edge]);
    }
  }
  quad(...faces.at(-1));
  quad(...[...faces[0]].reverse());
  return new Geometry(p, n, i);
}

function exhibition(engine, shadows) {
  const material = (color, roughness = .66, metalness = 0) => new PbrMaterial({color, roughness, metalness, doubleSided: false});
  const plank = (geometry, paint, position = [0,0,0], caster = false) => {
    const mesh = engine.createMesh().setGeometry(geometry).setMaterial(paint).setPosition(position);
    if (caster) shadows.add(mesh, {static: true});
    return mesh;
  };
  plank(box(1400, 1, 1400), material('#bfb19a', .95), [0, -12, 0]);
  plank(bevel(184, 171, -9, [[1,0],[0,1],[0,6.1],[1.15,7.05]]),
    material('#5a4537', .34), [0,0,0], true);
  plank(bevel(182.15, 169.15, -2.06, [[.1,0],[0,.3],[0,.61],[.25,.82]]),
    material('#b08b58', .36, .2), [0,0,0], true);
  plank(bevel(181.6, 168.6, -1.3, [[.2,0],[0,.36],[.45,1.22]]),
    material('#d1ba93', .76), [0,0,0], true);
  const ink = material('#77614c', .82);
  const longTick = box(.22,.06,1.65), shortTick = box(.18,.06,.83);
  for (let tick = 0; tick <= 10; tick++) plank(tick % 5 === 0 ? longTick : shortTick, ink, [-68 + tick*4, -.049, 82.1]);
  plank(box(40.25, .062, .19), ink, [-48, -.048, 82.65]);
  // The two-tone inlaid north arrow sits on the wood apron outside the city grid.
  const arrow = (x, z, wing, paint) => plank(
    new Geometry([x, .01, z-3, x+wing, .01, z+2, x, .01, z+1], [0,1,0,0,1,0,0,1,0],
      wing > 0 ? [0,2,1] : [0,1,2]), paint);
  arrow(86.8, 68, -1.38, ink);
  arrow(86.8, 68, 1.38, material('#a47c50', .52, .2));
}

export async function openCity(canvas, first, force, signal) {
  let engine, shadows, current = [], closed = false, error;
  const close = () => {
    if (closed) return;
    closed = true;
    engine?.dispose();
  };
  signal.addEventListener('abort', close, {once: true});
  const legacy = force || !navigator.gpu;
  const install = async () => (await import('./compatibility.js')).installCompatibility(force, signal);
  let planView = false;
  const ortho = (out, aspect, webgpu) => {
    const camera = engine.camera;
    const span = planView ? Math.max(180, 200 / aspect) : Math.max(168, 267 / aspect);
    out[0] = 2 / (span * aspect);
    out[5] = 2 / span;
    const range = camera.far - camera.near;
    out[10] = webgpu ? 1 / range : -2 / range;
    out[14] = webgpu ? camera.far / range : -(camera.far + camera.near) / range;
    out[15] = 1;
  };
  async function draw(overhead = planView) {
    signal.throwIfAborted();
    planView = overhead;
    const ratio = Math.min(devicePixelRatio, 2, 1450 / Math.max(1, canvas.clientWidth));
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    engine.camera.position = overhead ? [0,310,0] : [190,172,225];
    engine.camera.target = overhead ? [0,0,0] : [0,-2,0];
    engine.camera.up = overhead ? [0,0,-1] : [0,1,0];
    engine.render({delta: 0});
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
    if (error) throw error;
  }
  async function replace(plan) {
    signal.throwIfAborted();
    const next = [];
    try {
      const paints = palettes[plan.era];
      for (const part of plan.parts) {
        const {name, material, positions, normals, indices} = part;
        const paint = new PbrMaterial({...material, color: paints[name] ?? material.color, doubleSided: false});
        const mesh = engine.createMesh().setGeometry(new Geometry(positions, normals, indices)).setMaterial(paint);
        const dropShadow = ground[name] || name === 'glass' ? undefined : shadows.add(mesh, {static: true});
        next.push({mesh, dropShadow});
      }
    } catch (cause) {
      for (const {mesh, dropShadow} of next) {
        dropShadow?.();
        mesh.dispose();
      }
      throw cause;
    }
    for (const {mesh, dropShadow} of current) {
      dropShadow?.();
      mesh.dispose();
    }
    current = next;
    await draw();
  }

  if (legacy) await install();
  try {
    engine = await autoEngine(canvas, async target => {
      if (!target.gpu) {
        const unsupported = new Error('The model requires WebGPU or the full Margo WebGL2 compatibility layer.');
        unsupported.code = 'unsupported';
        throw unsupported;
      }
      engine = target;
      canvas = target.canvas;
      error = undefined;
      current = [];
      engine.onError = cause => {error = cause;};
      engine.scene.background = '#bfb19a';
      engine.camera.project = ortho;
      engine.lighting.direction.set([-.56,.76,.42,2.20]);
      engine.lighting.radiance.set([1,.91,.81,.52]);
      engine.lighting.ambient.set([.62,.68,.73]);
      shadows = Shadows.attach(engine, {resolution: 1024, filter: 'pcf',
        bounds: {min: [-136,-13,-136], max: [136,34,136]}, normalBias: .07,
      });
      exhibition(engine, shadows);
      performance.mark('margo-device-open');
      await replace(await first);
    }, {
      backend: legacy ? 'webgpu' : undefined, loadCompat: async () => ({install}),
      signal, exactSize: true, antialias: true, startupTimeout: 11000, capacity: 512,
      camera: {near: 2, far: 740},
    });
  } catch (cause) {
    close();
    throw cause;
  }
  return {replace, draw, close, backend: engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu'};
}
