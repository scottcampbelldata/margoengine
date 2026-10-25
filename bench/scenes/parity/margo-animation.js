// Margo implementation of the parity animation scenes (../parity.js, area 'animation').
import { engineFor, sceneSamples } from '../margo.js';

/** RobotExpressive's clips are 'Walking', 'Running', 'Wave'...: the spec's 'Walk' is 'Walking' (same on the three side). */
export function clipName(clips, name) {
  const names = clips.map((c) => c.name);
  if (names.includes(name)) return name;
  if (names.includes(`${name}ing`)) return `${name}ing`;
  throw new Error(`RobotExpressive has no clip ${name} (clips: ${names.join(', ')})`);
}
/** Start-time offset of crowd instance i, seconds (the three side uses the same). */
export const offsetOf = (i) => (i * 0.37) % 10;
/** Grid position of crowd instance i: side x side, `spacing` apart, centred on the origin. */
export function gridAt(i, n, spacing) {
  const side = Math.ceil(Math.sqrt(n)),
    half = (side - 1) / 2;
  return [((i % side) - half) * spacing, 0, (Math.floor(i / side) - half) * spacing];
}

/** One RobotExpressive load and n - 1 `cloneModel` copies, each placed on the grid with its own `Animation`. */
export async function robotCrowd(engine, data) {
  const [{ loadGLTF }, { Animation }, { cloneModel }] = await Promise.all([
    import('@margoengine/gltf-pro'),
    import('@margoengine/animation'),
    import('@margoengine/animation/skeleton-utils'),
  ]);
  const first = await loadGLTF(engine, data.url),
    models = [first];
  for (let i = 1; i < data.n; i++) models.push(await cloneModel(first));
  const animations = models.map((model, i) => {
    model.root.setPosition(gridAt(i, data.n, data.spacing));
    return Animation.attach(model);
  });
  return { models, animations, Animation };
}

/** A frame app whose engine.render gets the frame's delta (t - previous t); `rewind` runs when t goes back. */
function timedApp(engine, camera, update, { rewind, note } = {}) {
  let last = 0;
  return {
    samples: sceneSamples(),
    render(t) {
      let delta = t - last;
      if (delta < 0) {
        rewind?.(t);
        delta = 0;
      }
      last = t;
      update(t, delta);
      engine.camera.position = camera.at(t);
      engine.render({ delta });
    },
    idle: () => engine.gpu.queue.onSubmittedWorkDone(),
    info: () => ({ drawCalls: engine.stats.drawCalls, note: note ?? 'engine.stats.drawCalls' }),
  };
}

export const builders = {
  async 'p-mixer'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 16384, marks),
      s = performance.now(),
      { animations } = await robotCrowd(engine, data),
      clip = clipName(animations[0].clips, data.clip);
    for (const a of animations) {
      a.play(clip);
      a.playing = false; // seeked from frame time below, so both engines show the same pose per frame
    }
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return timedApp(
      engine,
      data.camera,
      (t) => {
        for (let i = 0; i < animations.length; i++) animations[i].seek(t + offsetOf(i));
      },
      { note: `${data.n} robots (1 load + cloneModel), Walking clip (the spec's Walk), each seeked to t + offset` },
    );
  },

  async 'p-crossfade'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 16384, marks),
      s = performance.now(),
      { animations, models } = await robotCrowd(engine, data),
      { Animator } = await import('@margoengine/animator'),
      walk = clipName(animations[0].clips, 'Walk'),
      run = clipName(animations[0].clips, 'Running'),
      wave = clipName(animations[0].clips, 'Wave');
    const every = models[0].nodes.map((_, k) => k);
    const animators = animations.map((a) => {
      const animator = Animator.attach(a, { initial: 'walk', states: { walk, run } });
      animator.addLayer({ clip: wave, weight: 0.5, mask: every });
      return animator;
    });
    const start = () =>
      animators.forEach((a, i) => {
        a.transition('run', 0).transition('walk', 0);
        a.time = offsetOf(i);
      });
    start();
    let phase = 0;
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return timedApp(
      engine,
      data.camera,
      (t) => {
        const p = Math.floor(t / 2);
        if (p !== phase) {
          phase = p;
          for (const a of animators) a.transition(p % 2 ? 'run' : 'walk', 0.5);
        }
      },
      {
        rewind: () => {
          phase = 0;
          start();
        },
        note: 'Animator: walk/run states, transition(0.5 s) every 2 s, additive Wave layer at 0.5 (whole body). Margo fades from a captured pose and restarts the destination clip, and its layer runs on the state clock; three cross-fades two playing actions. The additive Wave changes the pose differently in the two engines (measured on Margo: the layer moves bones up to 0.32 in quaternion components), so the images differ',
      },
    );
  },

  async 'p-morph'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 4096, marks),
      s = performance.now(),
      [{ loadGLTF }, { Animation }, { cloneModel }] = await Promise.all([
        import('@margoengine/gltf-pro'),
        import('@margoengine/animation'),
        import('@margoengine/animation/skeleton-utils'),
      ]);
    const first = await loadGLTF(engine, data.url),
      models = [first];
    for (let i = 1; i < data.n; i++) models.push(await cloneModel(first));
    const node = first.primitives[0].nodeIndex,
      targets = first.primitives[0].weights.length;
    const animations = models.map((m, i) => {
      m.root.setPosition(morphAt(i));
      const a = Animation.attach(m);
      a.playing = false; // weights are set by hand
      return a;
    });
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return timedApp(
      engine,
      data.camera,
      (t) => {
        for (let i = 0; i < animations.length; i++)
          for (let k = 0; k < targets; k++) animations[i].setMorph(node, k, Math.sin(t + i + k) * 0.5 + 0.5);
      },
      {
        note: '100 MorphStressTest (1 load + cloneModel), 5 x 20 grid 4.5 x 1.2 m (spec gives no layout); compute morphs',
      },
    );
  },

  async 'p-keyframes'(canvas, data, marks) {
    // One track per node: kind i % 3 (position vec3 linear, rotation quaternion slerp, scale step), 120 keys each.
    const s = performance.now(),
      { Skeleton, createKeyframeClip, applyKeyframeClip } = await import('@margoengine/animation');
    marks.createMs = 0;
    const nodes = data.tracks,
      skeleton = new Skeleton(Array.from({ length: nodes }, (_, i) => ({ name: `n${i}`, parent: i ? 0 : -1 }))),
      tracks = Array.from({ length: nodes }, (_, i) => {
        const kind = i % 3,
          keys = keyValues(i, data.keys, kind).map((value, k) => ({
            time: k / 10,
            value,
            interpolation: kind === 2 ? 'discrete' : 'linear',
          }));
        return { target: `n${i}`, path: ['translation', 'rotation', 'scale'][kind], keys };
      }),
      clip = createKeyframeClip({ name: 'authored', tracks }),
      duration = (data.keys - 1) / 10;
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return {
      task() {
        for (let k = 0; k < data.times; k++) applyKeyframeClip(clip, skeleton, (k / data.times) * duration);
      },
      output() {
        let sum = 0;
        for (let i = 0; i < nodes; i++) {
          const p = skeleton.getPose(i);
          sum += p.translation[0] + p.rotation[3] + p.scale[1];
        }
        return { tracks: nodes, keys: data.keys, times: data.times, checksum: +sum.toFixed(3) };
      },
      info: () => ({
        note: 'Skeleton of 1,000 bones posed by applyKeyframeClip at 600 times; one track per node (kind i % 3)',
      }),
    };
  },

  async 'p-skeleton-clone'(canvas, data, marks) {
    const engine = await engineFor(
        canvas,
        { fov: 45, near: 0.1, far: 100, at: () => [0, 3, 12], target: [0, 2, 0] },
        16384,
        marks,
      ),
      s = performance.now(),
      [{ loadGLTF }, { cloneModel }] = await Promise.all([
        import('@margoengine/gltf-pro'),
        import('@margoengine/animation/skeleton-utils'),
      ]);
    const source = await loadGLTF(engine, data.url);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let clones = [];
    return {
      async task() {
        for (const c of clones) c.destroy(); // the previous call's copies (GPU buffers would pile up)
        clones = [];
        for (let i = 0; i < data.copies; i++) clones.push(await cloneModel(source));
      },
      output: () => ({
        copies: clones.length,
        meshes: clones.reduce((n, c) => n + c.primitives.length, 0), // primitives (three: Mesh objects)
        nodes: clones.reduce((n, c) => n + c.nodes.length, 0),
      }),
      info: () => ({
        note: "cloneModel uploads each copy's vertex buffers and textures to the GPU (three's SkeletonUtils.clone is CPU only until drawn); each call also destroys the previous call's 50 copies",
      }),
    };
  },

  async 'p-ik'(canvas, data, marks) {
    const s = performance.now(),
      { CCDSolver } = await import('@margoengine/animator');
    marks.createMs = 0;
    const offsets = Array.from({ length: data.bones }, (_, i) => (i ? [0, data.length, 0] : [0, 0, 0])),
      solver = new CCDSolver(offsets, [0, data.length, 0]);
    solver.iterations = data.iterations;
    const target = [0, 0, 0];
    let result = null,
      step = 0;
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return {
      task() {
        for (let k = 0; k < data.solves; k++, step++) {
          ikTarget(step, target);
          result = solver.solve(target);
        }
      },
      output: () => ({ solves: step, lastDistance: result ? +result.distance.toFixed(4) : null }),
      info: () => ({
        note: 'CCDSolver (defaults, reach step on), 10 joints 0.3 m, 10 iterations; target on a circle r = 2 m at y = 1.5',
      }),
    };
  },
};

/** MorphStressTest instance i: 5 columns 4.5 m apart, 20 rows 1.2 m apart (the model is 4 x 1 m). */
export const morphAt = (i) => [((i % 5) - 2) * 4.5, 0, (Math.floor(i / 5) - 9.5) * 1.2];
/** IK target for solve number k: a circle of radius 2 at y = 1.5, one turn per 500 solves. */
export function ikTarget(k, out) {
  const a = (k / 500) * Math.PI * 2;
  out[0] = Math.cos(a) * 2;
  out[1] = 1.5;
  out[2] = Math.sin(a) * 2;
  return out;
}
/** Key values of node i's track (kind 0 position, 1 rotation quaternion, 2 scale), deterministic. */
export function keyValues(i, keys, kind) {
  return Array.from({ length: keys }, (_, k) => {
    const a = i * 0.01 + k * 0.1;
    if (kind === 0) return [Math.sin(a), Math.cos(a * 0.7), Math.sin(a * 1.3)];
    if (kind === 1) {
      const h = a * 0.5,
        n = Math.hypot(1, 0.5, 0.25);
      return [(Math.sin(h) * 1) / n, (Math.sin(h) * 0.5) / n, (Math.sin(h) * 0.25) / n, Math.cos(h)];
    }
    return [1 + 0.5 * Math.sin(a), 1 + 0.5 * Math.cos(a), 1];
  });
}
