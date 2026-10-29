// Browser side of the 1d''/1e.f measurements (driven by toggle.mjs). The section-plane toggle and the feature-edge
// background left with the CAD package (2026-10-29): what stays is the fog toggle and the shader override timings.
import { Engine, box } from '/packages/core/dist/extension.js';
import { loadGLTF } from '/packages/gltf-pro/dist/index.js';
import { Fog } from '/packages/environment/dist/index.js';
import { Stats } from '/packages/stats/dist/index.js';

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return +s[s.length >> 1].toFixed(3);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let engine, model, stats;
async function scene({ profiling = false, close = false } = {}) {
  const canvas = document.getElementById('view');
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    capacity: 4096,
    features: profiling ? ['timestamp-query'] : [],
    camera: close
      ? { position: [0, 0, 2.1], target: [0, 0, 0], fov: 45 }
      : { position: [0, 1.4, 5.5], target: [0, 0.2, 0], fov: 45 },
  });
  const errors = [];
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  window.gpuErrors = errors;
  if (!close)
    for (let x = -20; x < 20; x++)
      for (let z = -20; z < 20; z++)
        engine
          .createMesh()
          .setGeometry(box())
          .setPosition([x * 0.45, -1.2, z * 0.45])
          .setScale([0.35, 0.35, 0.35]);
  model = await loadGLTF(engine, '/examples/assets/scifi-helmet.glb');
  if (profiling) {
    stats = new Stats({ profiling: true });
    engine.use(stats);
  }
}
async function frame() {
  const t = performance.now();
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  return performance.now() - t;
}
async function frames(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await frame());
  return out;
}
const fogOptions = { color: '#9ab', near: 2, far: 12 };

window.measure = {
  // Toggle stall: 'add' = today's way (create the plugin when wanted), 'toggle' = created switched off at load, then `enabled = true`.
  async stall(mode) {
    await scene();
    await frames(60);
    let fog;
    if (mode === 'toggle') {
      fog = new Fog(fogOptions);
      fog.enabled = false;
      engine.use(fog);
      fog.applyTo(model);
      await frames(30);
      await sleep(1500);
      await frames(30);
    }
    const between = median(await frames(40));
    if (mode === 'add') {
      fog = new Fog(fogOptions);
      engine.use(fog);
      fog.applyTo(model);
    } else fog.enabled = true;
    const fogFrame = await frame();
    const after = median(await frames(30));
    return {
      mode,
      between,
      fogFrame: +fogFrame.toFixed(2),
      fogSpike: +(fogFrame - between).toFixed(2),
      after,
      errors: window.gpuErrors,
    };
  },
  async pixels(step) {
    if (step === 0) {
      await scene();
      await frames(20);
      return;
    }
    if (step === 1) {
      window.fog = new Fog(fogOptions);
      window.fog.enabled = false;
      engine.use(window.fog);
      window.fog.applyTo(model);
      await frames(20);
      await sleep(1000);
      await frames(20);
      return;
    }
    if (step === 2) {
      window.fog.enabled = true;
      await sleep(500);
      await frames(20);
      return window.gpuErrors;
    }
  },
  // GPU time (timestamp queries) of the same view with fog absent, present but off, and on.
  async gpu(rounds) {
    await scene({ profiling: true });
    await frames(30);
    let fog;
    const set = async (state) => {
      const present = engine.hasPlugin('fog');
      if (state === 'absent' && present) {
        engine.removePlugin('fog');
        fog.dispose();
      }
      if (state !== 'absent' && !present) {
        fog = new Fog(fogOptions);
        engine.use(fog);
        fog.applyTo(model);
      }
      if (fog) fog.enabled = state === 'on';
      await sleep(300);
      await frames(20);
    };
    const out = { absent: [], off: [], on: [] };
    for (let r = 0; r < rounds; r++)
      for (const state of ['absent', 'off', 'on']) {
        await set(state);
        let last = stats.gpuTime;
        for (let i = 0; i < 60; i++) {
          await frame();
          if (stats.gpuTime !== null && stats.gpuTime !== last) {
            out[state].push(stats.gpuTime);
            last = stats.gpuTime;
          }
        }
      }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { n: v.length, median: median(v) }]));
  },
  // 1e.f: the helmet full screen, gltf-pro's standard shader vs the same shader specialized by constants for its uniform
  // toggles (unlit, alpha mask, double-sided discard, HDR output, blend alpha), which is what `override` constants would compile.
  async override(rounds) {
    await scene({ profiling: true, close: true });
    await frames(30);
    const plain = { shader: (s) => s, bindings: () => [] };
    const special = {
      shader: (s) =>
        s
          .replaceAll('f.ext.x>0.5', 'false')
          .replace('f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y', 'false')
          .replace('!facing&&f.settings.z<0.5', 'false')
          .replaceAll('f.settings.w<0.5', 'true')
          .replaceAll('select(1.0,s.base.a,f.settings.x>1.5)', '1.0'),
      bindings: () => [],
    };
    const out = { uniform: [], constants: [] };
    let remove = model.addLighting(plain);
    for (let r = 0; r < rounds; r++)
      for (const kind of r % 2 ? ['constants', 'uniform'] : ['uniform', 'constants']) {
        remove();
        remove = model.addLighting(kind === 'uniform' ? plain : special);
        await frames(20);
        let last = stats.gpuTime;
        for (let i = 0; i < 80; i++) {
          await frame();
          if (stats.gpuTime !== null && stats.gpuTime !== last) {
            out[kind].push(stats.gpuTime);
            last = stats.gpuTime;
          }
        }
      }
    return {
      ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { n: v.length, median: median(v) }])),
      errors: window.gpuErrors,
    };
  },
};
// Which specialization pays: the two discards alone, or the other uniform toggles alone.
const variants = {
  uniform: (s) => s,
  noDiscard: (s) =>
    s
      .replace('if(!facing&&f.settings.z<0.5){discard;}', '')
      .replace('if(f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y){discard;}', ''),
  rest: (s) =>
    s
      .replaceAll('f.ext.x>0.5', 'false')
      .replaceAll('f.settings.w<0.5', 'true')
      .replaceAll('select(1.0,s.base.a,f.settings.x>1.5)', '1.0'),
};
window.measure.override2 = async (rounds) => {
  await scene({ profiling: true, close: true });
  await frames(30);
  const effect = (name) => ({ shader: variants[name], bindings: () => [] }),
    out = { uniform: [], noDiscard: [], rest: [] };
  let remove = model.addLighting(effect('uniform'));
  for (let r = 0; r < rounds; r++)
    for (const kind of r % 2 ? ['rest', 'noDiscard', 'uniform'] : ['uniform', 'noDiscard', 'rest']) {
      remove();
      remove = model.addLighting(effect(kind));
      await frames(20);
      let last = stats.gpuTime;
      for (let i = 0; i < 80; i++) {
        await frame();
        if (stats.gpuTime !== null && stats.gpuTime !== last) {
          out[kind].push(stats.gpuTime);
          last = stats.gpuTime;
        }
      }
    }
  return {
    ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { n: v.length, median: median(v) }])),
    errors: window.gpuErrors,
  };
};
window.measure.shotVariant = async (name) => {
  if (!engine) {
    await scene({ close: true });
    window.removeVariant = model.addLighting({ shader: variants.uniform, bindings: () => [] });
  }
  window.removeVariant();
  window.removeVariant = model.addLighting({ shader: variants[name], bindings: () => [] });
  await frames(10);
  return window.gpuErrors;
};
window.ready = true;
