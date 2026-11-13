// Orrery: a brass clockwork orrery under a glass dome in a dim study. The model is built by blender/build_orrery.py;
// this page turns its wheels and arms to the date on the dial. Planets sit at their heliocentric longitudes from
// ephemeris.ts; every wheel turns at the rate its tooth counts give (gears.ts).
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { loadGLTF } from '@margoengine/gltf-pro';
import { Shadows } from '@margoengine/shadows';
import { Clustered } from '@margoengine/clustered';
import { AreaLights } from '@margoengine/clustered/area';
import { LightProbes } from '@margoengine/environment/probes';
import { OIT } from '@margoengine/oit';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { ContactShadows } from '@margoengine/post/contact-shadows';
import { DOF } from '@margoengine/dof';
import { Autofocus } from '@margoengine/dof/autofocus';
import { Tonemap } from '@margoengine/tonemap';
import { TAAUpscale } from '@margoengine/taa/upscale';
import { OrbitControls } from '@margoengine/controls/transitions';
import { XRaySelection } from '@margoengine/selection/xray';
import { Picking } from '@margoengine/selection';
import { LabelRenderer } from '@margoengine/labels';
import { applyQualityTier, paceEngine } from '@margoengine/quality';
import {
  FITTED_SPAN,
  PLANETS,
  dateOfJulianDay,
  julianDay,
  moonLongitude,
  planetPosition,
  wrap360,
  type PlanetName,
} from './ephemeris.ts';
import { designTrains, driveAngle, wheelAngles } from './gears.ts';
import { PLANET_Z, planetLayouts } from './layout.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status'),
  errorLine = $('error');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(location.search);
// ?ui=0 hides the controls (for a still), ?date=YYYY-MM-DD opens on that date.
if (params.get('ui') === '0') document.body.classList.add('clean');
const NAMES: Record<PlanetName, string> = {
  mercury: 'Mercury',
  venus: 'Venus',
  earth: 'Earth',
  mars: 'Mars',
  jupiter: 'Jupiter',
  saturn: 'Saturn',
  uranus: 'Uranus',
  neptune: 'Neptune',
};
// The opening view: from the right, against the window, so the brass and the dome catch its light.
const HOME = {
  position: [1.38, 0.98, 0.82] as [number, number, number],
  target: [-0.02, 0.2, 0.02] as [number, number, number],
};

// Where the opening shot is focused: the inner planets, in front of the Sun.
const FRONT: [number, number, number] = [0.05, 0.3, 0.05];
const unsupported = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'unsupported';
/** Attaches an effect, or leaves it out where this device refuses it by name (the WebGL2 layer refuses some). */
function optional<T>(attach: () => T): T | undefined {
  try {
    return attach();
  } catch (error) {
    if (!unsupported(error)) throw error;
    console.info('Left out on this device:', (error as Error).message);
    return undefined;
  }
}

async function start() {
  // Desktops start on the light tier (one sample a pixel, TAA smooths edges) unless this browser measured headroom.
  const tier = applyQualityTier();
  const viewport = $('viewport');
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%';
  viewport.append(canvas);
  const engine = await Engine.create(canvas, {
    camera: { fov: 30, near: 0.02, far: 30, position: HOME.position, target: HOME.target },
  });
  paceEngine(engine);
  engine.onError = (error) => {
    if (unsupported(error)) return console.info('An effect detached: this device cannot keep HDR.', error);
    errorLine.textContent = String(error);
  };
  const runtime = engineRuntime(engine);
  engine.scene.background = '#0d0b09';

  const model = await loadGLTF(engine, new URL('./orrery.glb', import.meta.url).href);
  const node = (name: string) => {
    const found = model.nodes.find((n) => n.name === name);
    if (!found) throw new Error(`orrery.glb has no node ${name}; rebuild it with blender/build_orrery.py`);
    return found;
  };

  // Light: low afternoon sun through the window behind the orrery, the desk lamp off to the right.
  const sunDirection = [-2.3, 1.15, 0.35];
  runtime.lighting.direction.set([...sunDirection, 3.2]);
  runtime.lighting.radiance.set([1.0, 0.86, 0.68, 0.0]);
  optional(() => Shadows.attach(engine, { distance: 6, lightSize: 0.012 }))?.add(model);
  const lights = optional(() => Clustered.attach(engine));
  const lampColor: [number, number, number] = [1.0, 0.72, 0.45];
  // The desk lamp shines through the opal-lined mouth of its shade (29 by 14 cm): an area light, so the smooth dome
  // shows a soft patch of it, not the pinpoint a point light leaves on glass. Where area lights are refused, a point
  // light at the bulb stands in.
  const area = lights && optional(() => AreaLights.attach(engine, { lights, maxLights: 1 }));
  const mouth = { width: 0.29, height: 0.14 };
  area?.setLights([
    {
      position: [1.25, 0.415, -0.82],
      direction: [0, -1, 0],
      up: [0, 0, 1],
      ...mouth,
      color: lampColor,
      intensity: 1.2 / (mouth.width * mouth.height),
    },
  ]);
  // The Sun holds a lamp, as old lamp orreries did: the planets show their lit half to it.
  lights?.setLights([
    ...(area
      ? []
      : [{ position: [1.25, 0.43, -0.82] as [number, number, number], range: 4, color: lampColor, intensity: 1.2 }]),
    { position: [0, PLANET_Z, 0], range: 0.68, decay: 1, color: [1.0, 0.62, 0.3], intensity: 0.2 },
  ]);
  lights?.add(model);

  // Reflections and bounce light baked from the study itself: no image file.
  const probes = optional(() =>
    LightProbes.attach(engine, {
      resolution: 256,
      volume: { min: [-2.2, -0.75, -1.7], max: [2.5, 2.2, 3.1], counts: [6, 3, 6] },
      reflections: [
        // The mechanism inside the dome: small enough that the dome's outside reflects the room.
        { position: [0.05, 0.27, 0.09], min: [-0.2, 0.075, -0.2], max: [0.2, 0.37, 0.2] },
        // The study, seen from above the dome.
        { position: [0, 0.9, 0.35], min: [-2.3, -0.76, -1.75], max: [2.6, 2.24, 3.2] },
      ],
    }),
  );
  probes?.add(model);
  optional(() => OIT.attach(engine, { blending: true }))?.add(model);

  // Post: contact shadows, depth of field that racks to what you click, bloom on the lamp, AgX, then TAA.
  const dof = new DOF({ focalDistance: 1.4, focalLength: 0.085, aperture: 4, maxRadius: 24 });
  const bloom = new Bloom({ strength: 0.4, threshold: 2.2, radius: 0.6 });
  // Exposure 0.85 with the extra bounces below lifts the shadows enough for the gear train under the frame and the
  // dial's engraving to read, while the window and the lamp keep the room dim.
  const tonemap = new Tonemap({ curve: 'neutral', exposure: 0.85 });
  const stack = optional(() =>
    PostStack.attach(engine, [
      new ContactShadows({ distance: 0.04, thickness: 0.02, strength: 0.6 }),
      dof,
      bloom,
      tonemap,
    ]),
  );
  const focus = stack && optional(() => Autofocus.attach(engine, dof, { smoothing: 0.25 }));
  if (focus) focus.options.target = FRONT;

  const controls = OrbitControls.attach(engine);
  controls.enableDamping = true;
  controls.minDistance = 0.12;
  controls.maxDistance = 3.4;
  controls.maxPolarAngle = Math.PI * 0.49;

  // ------------------------------------------------------------------------------------------------- the mechanism
  const trains = designTrains();
  const layouts = planetLayouts(trains);
  const drive = node('drive');
  const parts = layouts.map((p) => ({
    layout: p,
    sleeve: node(`sleeve_${p.name}`),
    tube: node(`tube_${p.name}`),
    arm: node(`arm_${p.name}`),
    planet: node(`planet_${p.name}`),
    moons: p.moons.map((m, i) => ({ moon: m, carrier: node(`moons_${p.name}_${m.name}`), phase: 137.5 * (i + 1) })),
  }));
  const spin = (mesh: { setQuaternion(q: readonly number[]): unknown }, radians: number) => {
    const half = (radians % (2 * Math.PI)) / 2;
    mesh.setQuaternion([0, Math.sin(half), 0, Math.cos(half)]);
  };
  const RAD = Math.PI / 180;
  // Axis tilts are fixed in space: the planet turns back by its arm's angle, then leans toward its longitude.
  const tilt = (degrees: number, toward: number, arm: number) => {
    const t = (degrees * RAD) / 2,
      l = toward * RAD;
    // q_tilt about (-sin l, 0, -cos l), then the inverse of the arm's turn about y applied first.
    const ax = -Math.sin(l) * Math.sin(t),
      az = -Math.cos(l) * Math.sin(t),
      aw = Math.cos(t);
    const h = (-arm * RAD) / 2,
      by = Math.sin(h),
      bw = Math.cos(h);
    // (0, by, 0, bw) * (ax, 0, az, aw)
    return [bw * ax + by * az, by * aw, bw * az - by * ax, bw * aw];
  };

  const opening = Date.parse(params.get('date') ?? '');
  let jd = julianDay(Number.isFinite(opening) ? opening : Date.now());
  const pose = () => {
    const driveTurn = driveAngle(jd);
    spin(drive, driveTurn);
    for (const part of parts) {
      const wheels = wheelAngles(part.layout.train, driveTurn);
      spin(part.sleeve, wheels.b);
      spin(part.tube, wheels.d);
      const longitude = planetPosition(part.layout.name, jd).longitude;
      spin(part.arm, longitude * RAD);
      part.planet.setQuaternion(tilt(part.layout.tilt, part.layout.tiltToward, longitude));
      for (const { moon, carrier, phase } of part.moons) {
        const angle = moon.name === 'moon' ? moonLongitude(jd) : wrap360(phase + (360 * (jd - 2451545)) / moon.period);
        spin(carrier, (angle - longitude) * RAD);
      }
    }
  };
  pose();

  // ------------------------------------------------------------------------------------------------------ labels
  const labels = LabelRenderer.attach(engine);
  const tags = new Map<PlanetName, HTMLElement>();
  for (const part of parts) {
    const tag = document.createElement('div');
    tag.className = 'planet-label';
    tag.textContent = NAMES[part.layout.name];
    tag.hidden = true;
    tags.set(part.layout.name, tag);
    labels.add(tag, { mesh: part.planet, offset: [0, part.layout.radius + 0.012, 0], anchor: [0.5, 1] });
  }
  let names = false;
  const showTags = () => {
    for (const [name, tag] of tags) tag.hidden = !(names || name === selected);
  };

  // ------------------------------------------------------------------------------------------- selection, x-ray
  const outline = optional(() =>
    XRaySelection.attach(engine, {
      color: [1.0, 0.72, 0.3],
      width: 2,
      xray: { color: [0.45, 0.75, 1.0], dash: 0, opacity: 0.9, width: 1 },
      pulse: false,
    }),
  );
  optional(() => Picking.attach(engine, { capture: false }));
  const trainNodes = (name: PlanetName) => [
    ...['a', 'b', 'c', 'd'].map((w) => node(`wheel_${name}_${w}`)),
    node(`tube_${name}_pipe`),
  ];
  let selected: PlanetName | null = null;
  let xray = false;
  // The x-ray shows a planet's whole train (or every train) through the frame, outlined where hidden.
  const refreshOutline = () => {
    const chosen = xray ? (selected ? [selected] : PLANETS) : selected ? [selected] : [];
    outline?.set(chosen.flatMap((name) => [node(`planet_${name}`), ...(xray ? trainNodes(name) : [])]));
    showTags();
  };

  // ----------------------------------------------------------------------------------------------- probes bake
  engine.render();
  // Three bounces: each capture sees the probe light of the one before, so the brass inside the dome reflects a room
  // lit by its own bounce light, not the black of a single pass.
  await probes?.bake({ bounces: 3 });
  // Temporal upscaling, attached after the bake so the probes see an unjittered room: the light tier draws 72 percent
  // of the pixels and rebuilds the full frame from jittered frames.
  const taa = stack && optional(() => TAAUpscale.attach(engine, { scale: tier === 'high' ? 1 : 0.72, sharpen: 0.25 }));

  // ------------------------------------------------------------------------------------------------------- UI
  const dateInput = $<HTMLInputElement>('date'),
    scrub = $<HTMLInputElement>('scrub'),
    playButton = $<HTMLButtonElement>('play'),
    speed = $<HTMLSelectElement>('speed'),
    readout = $('readout'),
    domeButton = $('dome');
  const [first, last] = FITTED_SPAN;
  let playing = false;
  const showDate = () => {
    const date = dateOfJulianDay(jd);
    dateInput.value = date.toISOString().slice(0, 10);
    scrub.value = String((jd - first) / (last - first));
    const name = selected ?? 'earth';
    const p = planetPosition(name, jd);
    const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    readout.textContent = `${day}. ${NAMES[name]} at ${p.longitude.toFixed(1)} degrees heliocentric longitude, ${p.radius.toFixed(3)} au from the Sun.`;
  };
  const setDay = (value: number) => {
    jd = Math.min(Math.max(value, first), last);
    pose();
    showDate();
  };
  setDay(jd);
  dateInput.addEventListener('change', () => {
    const t = Date.parse(dateInput.value);
    if (Number.isFinite(t)) setDay(julianDay(t) + 0.5);
  });
  scrub.addEventListener('input', () => setDay(first + Number(scrub.value) * (last - first)));
  $('today').addEventListener('click', () => setDay(julianDay(Date.now())));
  const setPlaying = (on: boolean) => {
    playing = on;
    playButton.setAttribute('aria-pressed', String(on));
    playButton.textContent = on ? 'Pause' : 'Play';
  };
  playButton.addEventListener('click', () => setPlaying(!playing));

  const domeNode = node('dome');
  const dome = { now: 0, goal: 0 };
  const liftDome = (up: boolean) => {
    dome.goal = up ? 0.42 : 0;
    domeButton.setAttribute('aria-pressed', String(up));
    domeButton.textContent = up ? 'Lower the dome' : 'Lift the dome';
  };
  domeButton.addEventListener('click', () => liftDome(!dome.goal));
  $('xray').addEventListener('click', (event) => {
    xray = !xray;
    (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(xray));
    refreshOutline();
  });
  const duration = (seconds: number) => (reducedMotion.matches ? 0 : seconds);
  const flyHome = () => {
    selected = null;
    refreshOutline();
    showDate();
    if (focus) focus.options.target = FRONT;
    return controls.transitions.setLookAt(HOME.position, HOME.target, { duration: duration(1.4) });
  };
  $('reset').addEventListener('click', () => void flyHome());
  $('names').addEventListener('click', (event) => {
    names = !names;
    (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(names));
    showTags();
  });

  /** Flies to a planet: lifts the dome, outlines it and pulls focus to it. */
  const select = (name: PlanetName) => {
    const part = parts.find((p) => p.layout.name === name)!;
    selected = name;
    refreshOutline();
    showDate();
    liftDome(true);
    const m = part.planet.matrix;
    const at: [number, number, number] = [m[12], m[13], m[14]];
    // From outside its orbit, a little above, turned toward the side the camera is on now.
    // The offset below is 1.194 d long; keep it a tenth past the controls' nearest distance, or the transition is
    // refused (Mercury's own d once fell just inside it).
    const out = Math.hypot(at[0], at[2]) || 1,
      d = Math.max(
        0.07 + part.layout.radius * 4 + (part.layout.ring?.outer ?? 0) * 2,
        (controls.minDistance * 1.1) / Math.hypot(1, 0.5, 0.42),
      ),
      cam = engine.camera.position,
      side = Math.sign(cam[0] * -at[2] + cam[2] * at[0]) || 1;
    const from: [number, number, number] = [
      at[0] + (at[0] / out) * d - (at[2] / out) * d * 0.5 * side,
      at[1] + d * 0.42,
      at[2] + (at[2] / out) * d + (at[0] / out) * d * 0.5 * side,
    ];
    if (focus) focus.options.target = at;
    return controls.transitions.setLookAt(from, at, { duration: duration(1.6) });
  };

  // Click a planet (or its moons or ring): fly to it. Click anywhere else: rack focus to that point. A drag is no click.
  let down: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (event) => {
    down = [event.clientX, event.clientY];
  });
  canvas.addEventListener('click', async (event) => {
    if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return;
    const hit = await engine.pick(event.offsetX, event.offsetY);
    // The model's node names say whose a part is: planet_saturn, ring_saturn, moon_earth_moon, moonarm_jupiter_io.
    const owner = /^(?:planet|ring|moon|moonarm)_([a-z]+)/.exec((hit as { name?: string } | null)?.name ?? '')?.[1];
    const part = parts.find((p) => p.layout.name === owner);
    if (part) void select(part.layout.name);
    else if (focus) focus.options.point = [event.offsetX, event.offsetY];
  });

  let previous = performance.now();
  engine.onFrame(() => {
    const now = performance.now(),
      dt = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    if (playing && !reducedMotion.matches) {
      const next = jd + Number(speed.value) * dt;
      if (next >= last) setPlaying(false);
      setDay(next);
    }
    if (dome.now !== dome.goal) {
      const step = Math.sign(dome.goal - dome.now) * dt * 0.5;
      dome.now = Math.abs(dome.goal - dome.now) <= Math.abs(step) ? dome.goal : dome.now + step;
      domeNode.setPosition([0, dome.now, 0]);
    }
    // While time runs, the focus follows the chosen planet round its orbit.
    if (selected && playing && focus) {
      const m = node(`planet_${selected}`).matrix;
      focus.options.target = [m[12], m[13], m[14]];
    }
  });
  engine.start();
  status.textContent = '';
  viewport.dataset.ready = 'true';

  const api = {
    engine,
    model,
    controls,
    dof,
    focus,
    taa,
    outline,
    probes,
    lights,
    setDay,
    select,
    flyHome,
    liftDome,
    get jd() {
      return jd;
    },
    get selected() {
      return selected;
    },
    get dome() {
      return dome.now;
    },
    ready: true,
  };
  Object.assign(window, { orrery: api });
}

start().catch((error) => {
  status.textContent = 'Unable to wind the orrery';
  errorLine.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
});
