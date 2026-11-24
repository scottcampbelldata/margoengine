// The Fauld bomb store page (@margoengine/scenes/fauld-tunnels): one shot of the Fauld film, by row of the recut shot
// list. Query: shot (a row id, frNNN: the camera track of tools/shot/shots/fauld-frNNN.json), t (seconds into the
// shot; default its still probe), state (the store's lighting state), focal and stop (the lens), w and h (pixels),
// library (URL root of the asset library, default /asset-library/). window.fauld drives it for tools/shot and stills.
import { Engine } from '/packages/core/dist/index.js';
import { attach } from '/packages/scenes/dist/fauld-tunnels.js';

const q = new URLSearchParams(location.search),
  viewport = document.querySelector('#viewport'),
  status = document.querySelector('#status'),
  canvas = viewport.querySelector('canvas'),
  w = Number(q.get('w') ?? 1920),
  h = Number(q.get('h') ?? 1080),
  errors = [];
canvas.width = w;
canvas.height = h;
canvas.style.width = `${w}px`;
canvas.style.height = `${h}px`;
const fail = (e) => {
  const text = String(e?.message ?? e);
  errors.push(text);
  status.textContent = text;
  viewport.dataset.error = text;
};
try {
  const shotId = q.get('shot') ?? 'fr003',
    file = await (await fetch(`/tools/shot/shots/fauld-${shotId}.json`)).json(),
    keys = file.tracks.find((t) => t.type === 'camera').keys,
    focal = Number(q.get('focal') ?? file.shot.page.query.focal),
    stop = Number(q.get('stop') ?? file.shot.page.query.stop),
    state = q.get('state') ?? file.shot.page.query.state;
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 1.6, 0], target: [10, 1.6, 0], fov: 40, near: 0.03, far: 600 },
  });
  engine.stop();
  engine.gpu.addEventListener('uncapturederror', (e) => fail(e.error.message));
  const scene = await attach(engine, { state, library: q.get('library') ?? '/asset-library/' });
  // The camera of the shot at time t: the track's keys, linear between keys, smoothstep where the key says so.
  const camera = (t) => {
    let i = keys.findIndex((k) => k.time >= t);
    if (i <= 0) i = i === 0 ? 1 : keys.length - 1;
    const a = keys[i - 1],
      b = keys[i],
      u = Math.min(1, Math.max(0, (t - a.time) / (b.time - a.time || 1))),
      e = b.ease === 'smoothstep' ? u * u * (3 - 2 * u) : u,
      lerp = (p, r) => p.map((v, j) => v + (r[j] - v) * e);
    return { position: lerp(a.position, b.position), target: lerp(a.target, b.target) };
  };
  let now = 0;
  const apply = ({ time }) => {
    const c = camera(time);
    scene.frame(c.position, c.target, focal, stop);
    if (time > now) scene.advanceTime(time - now);
    now = time;
  };
  apply({ time: Number(q.get('t') ?? file.shot.probes.still ?? 0) });
  window.fauld = {
    engine,
    scene,
    apply,
    errors,
    // Renders `frames` frames (shadow maps, fog and occlusion history settle), then resolves.
    async still(frames = 24) {
      for (let i = 0; i < frames; i++) {
        engine.render({ delta: 1 / 24 });
        if (i % 6 === 5) await engine.gpu.queue.onSubmittedWorkDone();
      }
      await engine.gpu.queue.onSubmittedWorkDone();
      return { errors, counts: scene.counts, ev100: scene.ev100 };
    },
  };
  status.hidden = true;
  viewport.dataset.ready = 'true';
} catch (e) {
  fail(e);
  throw e;
}
