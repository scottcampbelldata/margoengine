import { Clustered } from '@margoengine/clustered';
import { EnvironmentLighting } from '@margoengine/environment';
import { applyMatrix4, boxGeometry, cylinderGeometry, mergeGeometries, planeGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, Texture, createMesh } from '@margoengine/materials';
import { Bloom } from '@margoengine/post/bloom';
import { SMAA } from '@margoengine/post/smaa';
import { PostStack } from '@margoengine/post/stack';
import { Shadows } from '@margoengine/shadows';
import { createStage } from '@margoengine/stage';
import { Tonemap } from '@margoengine/tonemap';
import { Label, Panel, Ui, UiRenderer } from '@margoengine/ui';

export const clamp = (x) => Math.max(0, Math.min(1, x));
export const mix = (a, b, t) => a + (b - a) * t;
export const blend = (a, b, t) => a.map((x, i) => mix(x, b[i], t));
export const ease = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
export const ramp = (t, a, b) => ease((t - a) / (b - a));

export function rng(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function matrix(position, rotation) {
  const [ax, ay, az] = rotation,
    [x, y, z] = position;
  const sx = Math.sin(ax),
    sy = Math.sin(ay),
    sz = Math.sin(az);
  const cx = Math.cos(ax),
    cy = Math.cos(ay),
    cz = Math.cos(az);
  return [
    cy * cz,
    cy * sz,
    -sy,
    0,
    sx * sy * cz - cx * sz,
    sx * sy * sz + cx * cz,
    sx * cy,
    0,
    cx * sy * cz + sx * sz,
    cx * sy * sz - sx * cz,
    cx * cy,
    0,
    x,
    y,
    z,
    1,
  ];
}

// Repeated hardware is baked into one mesh per moving assembly and material.
export function workshop(engine) {
  const batches = new Map();
  const textures = [];
  function part(g, material, position = [0, 0, 0], rotation = [0, 0, 0], group = null) {
    if (!batches.has(group)) batches.set(group, new Map());
    const palette = batches.get(group);
    if (!palette.has(material)) palette.set(material, []);
    palette.get(material).push(applyMatrix4(g, matrix(position, rotation)));
  }

  return {
    group(name, parent = null, position = [0, 0, 0]) {
      const root = engine.createMesh(parent).setPosition(position);
      root.name = name;
      return root;
    },
    part,
    box(size, mat, pos, rot, parent, bevel = 0) {
      const g = bevel
        ? roundedBoxGeometry(...size, 2, Math.min(bevel, ...size.map((n) => n * 0.48)))
        : boxGeometry(...size);
      part(g, mat, pos, rot, parent);
    },
    ring(size, mat, pos, rot, parent, segments = 40) {
      part(cylinderGeometry(...size, segments), mat, pos, rot, parent);
    },
    beam(a, b, width, mat, parent, circular = false) {
      const d = b.map((v, i) => v - a[i]);
      const length = Math.hypot(...d);
      const tilt = Math.acos(d[1] / length);
      const angle = Math.atan2(d[2], d[0]);
      const c = Math.cos(angle),
        s = Math.sin(angle);
      const end = a.map((v, i) => (v + b[i]) * 0.5);
      const turn = [
        c * Math.cos(tilt),
        -Math.sin(tilt),
        s * Math.cos(tilt),
        0,
        d[0] / length,
        d[1] / length,
        d[2] / length,
        0,
        -s,
        0,
        c,
        0,
        ...end,
        1,
      ];
      const g = circular ? cylinderGeometry(width / 2, width / 2, length, 10) : boxGeometry(width, length, width);
      part(applyMatrix4(g, turn), mat, undefined, undefined, parent);
    },
    sign(lines, size, pos, rot, parent, { background = '#17212a', foreground = '#ece6d7', lit = 0 } = {}) {
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = Math.max(96, Math.round((768 * size[1]) / size[0]));
      const context = canvas.getContext('2d');
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = foreground;
      context.lineWidth = 3;
      context.strokeRect(9, 9, canvas.width - 18, canvas.height - 18);
      context.fillStyle = foreground;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const lineHeight = canvas.height / (lines.length + 0.52);
      lines.forEach((line, i) => {
        context.font = `600 ${Math.min(lineHeight * 0.64, 118)}px "Segoe UI", sans-serif`;
        context.fillText(line, canvas.width / 2, canvas.height / 2 + (i - (lines.length - 1) / 2) * lineHeight, 700);
      });
      const texture = new Texture(canvas, { colorSpace: 'srgb' });
      textures.push(texture);
      const mat = new Material({
        color: '#ffffff',
        map: texture,
        roughness: 0.74,
        emissive: '#ffffff',
        emissiveMap: texture,
        emissiveIntensity: lit,
      });
      part(planeGeometry(...size), mat, pos, rot, parent);
    },
    finish() {
      const models = [];
      for (const [parent, materials] of batches) {
        for (const [material, shapes] of materials) {
          const model = createMesh(engine, shapes.length === 1 ? shapes[0] : mergeGeometries(shapes), material);
          model.root.setParent(parent);
          models.push(model);
        }
      }
      batches.clear();
      return models;
    },
    dispose() {
      for (const texture of textures) texture.dispose();
    },
  };
}

export function finishTexture(seed, { r = 130, grain = 16, streak = false, mottling = 18 } = {}) {
  const random = rng(seed);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(256, 256);
  const rows = Array.from({ length: 256 }, () => random() - 0.5);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const p = (y * 256 + x) * 4;
      const breakup =
        Math.sin(x * 0.147 + Math.sin(y * 0.11)) * Math.sin(y * 0.187 + 0.78) + Math.cos(x * 0.051 + y * 0.062) * 0.61;
      const noise = (random() - 0.5) * grain + (streak ? rows[y] * 62 : 0);
      const value = r + noise + mottling * breakup;
      pixels.data.set([value, value, value, 255], p);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return new Texture(canvas, { colorSpace: 'linear', wrapS: 'repeat', wrapT: 'repeat' });
}

function panorama(night) {
  const width = 512,
    height = 256;
  const data = new Float32Array(width * height * 4);
  const panels = night
    ? [
        [-0.48, 0.16, 0.26, 0.07, [1.9, 1.13, 0.62]],
        [1.5, 0.32, 0.47, 0.21, [0.27, 0.49, 0.84]],
        [-2.2, 0.18, 0.18, 0.15, [0.9, 0.62, 0.28]],
      ]
    : [
        [-0.86, 0.78, 0.62, 0.22, [5.8, 5.13, 4.34]],
        [1.16, 0.66, 0.44, 0.16, [3.0, 4, 5]],
        [-2.4, 0.34, 0.41, 0.13, [1.3, 1.57, 1.92]],
      ];
  for (let y = 0; y < height; y++) {
    const el = Math.PI * (0.5 - (y + 0.5) / height);
    for (let x = 0; x < width; x++) {
      const az = 2 * Math.PI * ((x + 0.5) / width - 0.5);
      const base = night ? 0.035 + 0.08 * Math.exp(-Math.abs(el) * 3) : 0.175 + 0.15 * Math.max(0, Math.sin(el));
      const value = night ? [base * 0.55, base * 0.75, base * 1.2] : [base * 0.94, base, base * 1.06];
      for (const [pa, pe, w, h, rgb] of panels) {
        const d = Math.atan2(Math.sin(pa - az), Math.cos(pa - az));
        const brightness = Math.exp(-2 * ((d / w) ** 4 + ((pe - el) / h) ** 4));
        for (let i = 0; i < 3; i++) value[i] += brightness * rgb[i];
      }
      data.set([...value, 1], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

class FadePanel extends Panel {
  alpha = 1;
  get opacity() {
    return this.alpha;
  }
  fade(alpha) {
    if (this.alpha === alpha) return;
    this.visible = alpha > 0;
    this.alpha = alpha;
    this.invalidate(false);
  }
}

export function shotAt(shots, time) {
  const shot = shots.find(([end]) => end > time) ?? shots.at(-1);
  const i = shots.indexOf(shot);
  const [end, from, to, target, targetEnd, fov] = shot;
  const start = i ? shots[i - 1][0] : 0;
  const t = ramp(time, start, end);
  return { position: blend(from, to, t), target: blend(target, targetEnd, t), fov };
}

export async function openFilm({ title, build, night = false, far = 75, camera, look = {} }) {
  const viewport = document.querySelector('#viewport');
  const status = document.querySelector('#status');
  const seek = document.querySelector('#seek');
  const play = document.querySelector('#play');
  const stamp = document.querySelector('#clock');
  const params = new URLSearchParams(location.search);
  const offline = params.has('capture');
  // ?backend=webgl2 runs the film's WebGPU code on the WebGL2 compatibility layer; WebGPU is the default.
  const layer = params.get('backend') ?? 'webgpu';
  if (layer !== 'webgpu' && layer !== 'webgl2') throw new RangeError(`backend must be webgpu or webgl2: ${layer}`);
  if (layer === 'webgl2') {
    const { install } = await import('@margoengine/webgl2-compat');
    const result = await install({ force: true });
    if (!result.installed) throw new Error(`the WebGL2 compatibility layer did not install: ${result.reason}`);
  }
  const report = (error) => {
    status.hidden = false;
    status.textContent = String(error);
    viewport.dataset.error = String(error);
    console.error(error);
  };
  try {
    const stage = await createStage(viewport, {
      autoStart: false,
      controls: false,
      backend: 'webgpu',
      background: night ? '#101d2b' : '#262d35',
      camera: { position: [3, 2, 3], target: [0, 1, 0], near: 0.045, far, fov: 45, ...camera },
      label: title,
      onError: report,
    });
    const { engine } = stage;
    const workshopScene = workshop(engine);
    const light = await EnvironmentLighting.load(engine, panorama(night), {
      size: 128,
      specularSize: 128,
      intensity: look.environment ?? (night ? 1.17 : 0.81),
    });
    engine.lighting.direction.set(look.direction ?? (night ? [-0.48, 0.62, 0.5, 0.97] : [-0.44, 0.83, 0.32, 2.13]));
    engine.lighting.radiance.set(look.radiance ?? (night ? [0.54, 0.67, 0.9, 0.3] : [1, 0.94, 0.84, 0.33]));
    engine.lighting.ambient.set(look.ambient ?? [0.73, 0.85, 1]);
    const shadows = Shadows.attach(engine, {
      resolution: night ? 1536 : 2048,
      distance: night ? 55 : 9.5,
      normalBias: night ? 0.012 : 0.003,
      lightSize: 0.2,
      ...look.shadows,
    });
    const clustered = Clustered.attach(engine, { maxLights: 24 });
    const film = await build(engine, workshopScene, clustered, shadows);
    for (const model of [...workshopScene.finish(), ...(film.models ?? [])]) {
      light.add(model);
      clustered.add(model);
      shadows.add(model);
      for (const receiver of film.receivers ?? []) receiver.add(model);
    }
    const bloom = new Bloom({ threshold: 1.4, strength: look.bloom ?? (night ? 0.25 : 0.09), radius: 0.59 });
    PostStack.attach(engine, [
      ...(film.effects ?? []),
      bloom,
      new Tonemap({
        curve: look.curve ?? 'agx',
        exposure: look.exposure ?? (night ? 0.47 : 0.03),
        contrast: look.contrast ?? (night ? 1.01 : 1.08),
      }),
      new SMAA({ quality: 'high' }),
    ]);
    const ui = new Ui({ scale: { reference: [1920, 1080], match: 0.5 } });
    const caption = new Label({ text: '', size: 39, outline: true, color: '#faf4e7', wrap: false });
    const subtitle = new FadePanel({
      anchor: 'bottom-left',
      margin: [0, 0, 74, 97],
      padding: [11, 18, 11, 18],
      radius: 7,
      background: '#111a23cf',
      pointerEvents: 'none',
      children: [caption],
    });
    const closing = new FadePanel({
      anchor: 'bottom-left',
      margin: [0, 0, 92, 98],
      padding: 25,
      radius: 8,
      gap: 7,
      background: '#101920e8',
      pointerEvents: 'none',
      children: [
        new Label({ text: 'Made with Margo Engine', size: 36, color: '#edbd84', wrap: false }),
        new Label({ text: title, size: 74, color: '#fff5e8', wrap: false }),
        new Label({ text: 'Please subscribe', size: 41, color: '#e4edf1', wrap: false }),
        ...(film.musicCredit ? [new Label({ text: film.musicCredit, size: 25, color: '#c6cfda', wrap: false })] : []),
      ],
    });
    ui.add(subtitle);
    ui.add(closing);
    if (film.credit)
      ui.add(
        new Panel({
          anchor: 'top-right',
          margin: [35, 44, 0, 0],
          padding: [8, 12, 8, 12],
          background: '#101820c9',
          radius: 6,
          pointerEvents: 'none',
          children: [new Label({ text: film.credit, size: 22, color: '#f5eddf', wrap: false })],
        }),
      );
    UiRenderer.attach(engine, ui);
    const apply = ({ time }, capture) => {
      const view = film.apply(time);
      engine.camera.position = view.position;
      engine.camera.target = view.target;
      engine.camera.fov = view.fov;
      const cue = film.cues.find(([a, b]) => time >= a && time < b);
      if (cue && caption.text !== cue[2]) caption.text = cue[2];
      subtitle.fade(cue ? ramp(time, cue[0], cue[0] + 0.22) * (1 - ramp(time, cue[1] - 0.24, cue[1])) : 0);
      closing.fade(ramp(time, 83, 84));
      if (offline && capture) return film.prepareFrame?.();
    };

    let time = 0,
      frames = 0,
      playing = !offline && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const readout = () => {
      seek.value = String(time);
      stamp.value = `${Math.floor(time / 60)}:${String(Math.floor(time) % 60).padStart(2, '0')} / 1:30`;
      play.textContent = playing ? 'Pause' : time >= 90 ? 'Replay' : 'Play';
    };
    play.onclick = () => {
      if (time >= 90) time = 0;
      playing = !playing;
      readout();
    };
    seek.oninput = () => {
      time = Number(seek.value);
      playing = false;
      apply({ time });
      readout();
    };
    engine.onFrame((_, dt) => {
      if (playing) {
        time = Math.min(90, time + dt);
        playing = time < 90;
        apply({ time });
        readout();
      }
      if (++frames === 5 && !viewport.dataset.error) {
        status.hidden = true;
        document.querySelector('#controls').hidden = offline;
        viewport.dataset.ready = 'true';
      }
    });
    window.addEventListener(
      'pagehide',
      () => {
        stage.dispose();
        workshopScene.dispose();
        film.dispose?.();
      },
      { once: true },
    );
    apply({ time });
    readout();
    window.showcase = { engine, apply, ...film.inspection };
    engine.start();
  } catch (error) {
    report(error);
    throw error;
  }
}
