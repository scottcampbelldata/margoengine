// Boulder: click a hold and the climber works out how to get there. See README.md in this folder.
import { createStage } from 'margoengine';
import { engineRuntime } from '@margoengine/core/extension';
import { OrbitControls } from '@margoengine/controls/orbit';
import { HemisphereLight, ColorBackground } from '@margoengine/environment';
import { LightProbes } from '@margoengine/environment/probes';
import { loadGLTF } from '@margoengine/gltf-pro';
import { PostStack } from '@margoengine/post/stack';
import { Bloom } from '@margoengine/post/bloom';
import { SSAO } from '@margoengine/post/ssao';
import { submitPrincipalScene } from '@margoengine/post/scene-fade';
import { applyQualityTier, paceEngine, redrawAfterRestore, watchQuality } from '@margoengine/quality';
import { Shadows } from '@margoengine/shadows';
import { Tonemap } from '@margoengine/tonemap';
import { VFX } from '@margoengine/vfx';
import { Climb, contactPoint, matFoot, type ClimbEvent } from './climb.ts';
import { Climber } from './climber.ts';
import { buildGym, EGG, PLAQUE, ROOM, SUN } from './gym.ts';
import { CHARACTER } from './rig.ts';
import { TIERS } from './tiers.ts';
import { buildWall, LEFT_FOOT, MAT_TOP, RIGHT_FOOT, pickHold, type Point, type Route, type RouteName, type Vec } from './wall.ts';
import type { GymSound, SoundName } from './sound.ts';

const tier = applyQualityTier() as keyof typeof TIERS,
  settings = TIERS[tier],
  $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T,
  status = $('status'),
  error = $('error'),
  still = matchMedia('(prefers-reduced-motion: reduce)').matches;

const abort = new AbortController();
let dispose = () => abort.abort();
window.addEventListener('pagehide', () => dispose(), { once: true });

try {
  const { holds, routes } = buildWall(),
    climb = new Climb(holds),
    portrait = () => innerHeight > innerWidth,
    views = {
      hero: { position: [-1.25, 1.05, 3.35] as Point, target: [0.6, 1.95, 0.5] as Point },
      phone: { position: [-0.9, 0.7, 4.6] as Point, target: [0.85, 1.35, 0.45] as Point },
    },
    home = portrait() ? views.phone : views.hero;
  const stage = await createStage('#viewport', {
    backend: 'webgpu',
    controls: false,
    autoStart: false,
    label: 'A robot climbing an indoor bouldering wall. Choose a hold to send it there.',
    camera: { fov: 42, position: home.position, target: home.target, near: 0.05, far: 40 },
    onError: (reason) => {
      error.textContent = String(reason);
    },
  });
  const engine = stage.engine,
    runtime = engineRuntime(engine);
  let disposed = false;
  dispose = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    sound?.dispose();
    stage.dispose();
  };
  paceEngine(engine);

  // The room's light: the sun through the skylight, and a soft fill from above and off the floor.
  const length = Math.hypot(...SUN);
  runtime.lighting.direction.set([SUN[0] / length, SUN[1] / length, SUN[2] / length, 5.2]);
  runtime.lighting.radiance.set([1, 0.93, 0.8, 0.0]);
  ColorBackground.attach(engine, { color: '#a9c6e2', bottom: '#d7e3ea' });

  const shadows = Shadows.attach(engine, {
    resolution: settings.shadow.resolution,
    filter: settings.shadow.filter,
    bounds: { min: [-ROOM.x, 0, ROOM.back], max: [ROOM.x, ROOM.y + 0.3, ROOM.front] },
    casterMargin: 1,
    lightSize: 0.012,
    normalBias: 0.012,
    bias: 0.0002,
  });
  for (const part of buildGym(holds)) {
    const mesh = stage.mesh(part.geometry, {
      name: part.name,
      color: part.color,
      roughness: part.roughness,
      metalness: part.metalness ?? 0,
    });
    if (part.casts) shadows.add(mesh, { static: true });
  }

  const model = await loadGLTF(engine, CHARACTER.asset(), { signal: abort.signal });
  abort.signal.throwIfAborted();
  shadows.add(model);
  const climber = new Climber(engine, model, climb);

  const fill = HemisphereLight.attach(engine, { sky: '#dfe7ee', ground: '#a08d70', intensity: 0.85 });
  fill.add(model);
  const probes = LightProbes.attach(engine, {
    resolution: settings.probeResolution,
    near: 0.05,
    far: 16,
    reflections: [
      {
        position: [0.9, 1.9, 1.2],
        min: [-ROOM.x, 0, -0.1],
        max: [ROOM.x, ROOM.y, ROOM.front],
        blend: 0,
      },
    ],
  });
  probes.add(model);

  const effects = [];
  if (settings.ssao) {
    const contact = new SSAO({ radius: 0.12, bias: 0.002, samples: 16 });
    contact.add(model);
    effects.push(contact);
  }
  if (settings.bloom) effects.push(new Bloom({ strength: 0.08, threshold: 1.1 }));
  effects.push(new Tonemap({ curve: 'neutral' }));
  PostStack.attach(engine, effects);

  const chalk = VFX.attach(engine, {
    capacity: settings.chalkCapacity,
    rate: 0,
    size: 0.035,
    lifetime: [0.5, 1.3],
    velocity: [0, 0.18, 0.2],
    spread: 0.32,
    gravity: [0, -0.12, 0],
    ground: 0,
    color: [1, 0.98, 0.93, 0.5],
  });

  const puff = (point: ArrayLike<number>, count: number) => {
    chalk.options.position = [point[0], point[1], point[2]];
    chalk.burst(count);
  };

  // Without live capture the reflection is baked once a climb stops; never from inside a frame.
  let baking = false;
  const rebake = () => {
    if (settings.probeLive || baking) return;
    baking = true;
    setTimeout(() => {
      probes.setReflectionPosition(0, [
        climb.pelvis[0],
        Math.max(0.3, climb.pelvis[1]),
        Math.max(0.2, climb.pelvis[2] + 0.25),
      ]);
      probes.bake().finally(() => {
        baking = false;
      });
    }, 0);
  };

  let sound: GymSound | undefined;
  const play = (name: SoundName, point: ArrayLike<number>) => sound?.play(name, [point[0], point[1], point[2]]);

  // Stances.
  const positions = (route: Route, moves: number): { on: number[]; at: Point[] } => {
    const on = [route.start[0], route.start[1], -1, -1],
      at: Point[] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
    contactPoint(0, holds[on[0]], at[0]);
    contactPoint(1, holds[on[1]], at[1]);
    const x = (at[0][0] + at[1][0]) / 2;
    matFoot(LEFT_FOOT, x, MAT_TOP, at[LEFT_FOOT]);
    matFoot(RIGHT_FOOT, x, MAT_TOP, at[RIGHT_FOOT]);
    for (let i = 0; i < moves; i++) {
      const m = route.moves[i];
      on[m.limb] = m.hold;
      contactPoint(m.limb, holds[m.hold], at[m.limb]);
    }
    return { on, at };
  };
  const route = (name: RouteName) => routes.find((r) => r.name === name) as Route;
  const heroMoves = 18;
  const hero = positions(route('red'), heroMoves);
  climb.teleport(hero.on, hero.at);
  climber.breathing = !still;
  climber.snap();
  // The opening pose reaches for the next hold.
  climb.lookAt(...holds[route('red').moves[heroMoves].hold].position);

  // Moments.
  type Moment = 'reach' | 'step' | 'route';
  let moment: Moment = 'reach',
    playing: Route | null = null,
    // The route a phone's view follows. It outlasts the climb, so the view also comes back down with a fall.
    following: Route | null = null,
    playIndex = 0,
    pause = 0,
    afterLanding: (() => void) | null = null;
  const momentButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-moment]')];
  const draw = () => engine.render({ delta: 0 });
  const say = (text: string) => {
    status.textContent = text;
  };
  const setMoment = (next: Moment) => {
    moment = next;
    for (const b of momentButtons) b.setAttribute('aria-pressed', String(b.dataset.moment === next));
    $('routes').hidden = next !== 'route';
    say(
      next === 'reach'
        ? 'Choose a hold. The nearer hand goes for it.'
        : next === 'step'
          ? 'Choose a hold. The nearer foot steps onto it.'
          : 'Choose a route colour.',
    );
  };

  const nearestLimb = (first: number, hold: number) => {
    const p = holds[hold].position,
      score = (limb: number) => {
        const c = climb.contacts[limb];
        return (climb.bound[limb] ? 0 : -1) + Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      };
    return score(first) <= score(first + 1) ? first : first + 1;
  };
  const applyInstant = (limb: number, hold: number): boolean => {
    // Reduced motion: no travel, the stance simply changes when the new one is reachable.
    const next = climb.contacts.map((c) => [...c]) as Point[],
      on = [...climb.on];
    contactPoint(limb, holds[hold], next[limb]);
    on[limb] = hold;
    climb.teleport(on, next);
    climber.snap();
    if (still) draw();
    return true;
  };
  const sendTo = (hold: number) => {
    const limb = moment === 'step' ? nearestLimb(LEFT_FOOT, hold) : nearestLimb(0, hold);
    stopRoute();
    if (still) applyInstant(limb, hold);
    else climb.move(limb, hold);
  };
  const stopRoute = () => {
    playing = null;
  };

  const startRoute = (name: RouteName) => {
    const r = route(name),
      begin = () => {
        const start = positions(r, 0);
        if (still) {
          const end = positions(r, r.moves.length);
          climb.teleport(end.on, end.at);
          climber.snap();
          if (still) draw();
          say(`The ${name} route, top hold.`);
          return;
        }
        climb.settle(start.at);
        playing = r;
        following = r;
        // The two hands take their first holds as moves of their own, so they arc to the wall round the body.
        playIndex = -2;
        pause = 0.9;
        say(`Climbing the ${name} route.`);
      };
    if (still || climb.on.every((h) => h === -1)) begin();
    else {
      afterLanding = begin;
      climb.fall(MAT_TOP);
    }
  };

  climb.onEvent = (event: ClimbEvent, limb: number, point: Vec) => {
    if (event === 'contact') {
      if (limb < 2) {
        puff(point, 60);
        play('chalk', point);
      }
      play('grip', point);
      if (!playing) rebake();
    } else if (event === 'short') {
      say('Too far from this stance. Move a foot up first.');
    } else if (event === 'landed') {
      puff([climb.pelvis[0], MAT_TOP + 0.02, climb.pelvis[2]], 220);
      play('land', [climb.pelvis[0], MAT_TOP, climb.pelvis[2]]);
      if (afterLanding) {
        const next = afterLanding;
        afterLanding = null;
        next();
      } else say('Back on the mat. Choose a hold.');
    }
  };

  // The route player runs just before the climber reads its state.
  stage.use({
    name: 'boulder:route',
    setup() {},
    onPreUpdate(delta: number) {
      // A phone sees a narrow strip of the wall, so the view slides across to the route being climbed.
      if (portrait() && following) {
        const follow = Math.min(1, delta * 2),
          shift = (holds[following.start[0]].position[0] + 0.28 - camera.target[0]) * follow,
          // Up as well, keeping the climber above the panel that covers the bottom of a phone screen.
          rise = (Math.max(views.phone.target[1], climb.pelvis[1] - 0.2) - camera.target[1]) * follow;
        camera.position = [camera.position[0] + shift, camera.position[1] + rise, camera.position[2]];
        const target = [camera.target[0] + shift, camera.target[1] + rise, camera.target[2]];
        camera.target = target as never;
        orbit.target = target as never;
      }
      if (!playing || climb.moving >= 0 || climb.falling) return;
      pause -= delta;
      if (pause > 0) return;
      if (playIndex >= playing.moves.length) {
        say(`Top of the ${playing.name} route. Fall to come back down.`);
        playing = null;
        rebake();
        return;
      }
      const move =
        playIndex < 0 ? { limb: playIndex + 2, hold: playing.start[playIndex + 2] } : playing.moves[playIndex];
      playIndex++;
      climb.move(move.limb, move.hold);
      pause = 0.16;
    },
  });
  // Above runs after the climber in plugin order, so a move starts next frame. That is one frame, and nobody sees it.

  // Input.
  const canvas = stage.canvas,
    camera = engine.camera;
  canvas.tabIndex = 0;
  const orbit = new OrbitControls(camera, canvas);
  // Whoever turns the view has taken it over.
  orbit.addEventListener('start', () => {
    following = null;
  });
  orbit.target = home.target as never;
  orbit.enableDamping = true;
  orbit.minDistance = 1.2;
  orbit.maxDistance = 7.5;
  orbit.maxPolarAngle = Math.PI * 0.53;
  orbit.minPolarAngle = 0.5;
  orbit.saveState();
  stage.use({
    name: 'boulder:orbit',
    setup() {},
    dispose: () => orbit.dispose(),
  });

  const ray = (clientX: number, clientY: number): [number, number, number, number, number, number] => {
    const rect = canvas.getBoundingClientRect(),
      nx = ((clientX - rect.left) / rect.width) * 2 - 1,
      ny = 1 - ((clientY - rect.top) / rect.height) * 2,
      [px, py, pz] = camera.position,
      [tx, ty, tz] = camera.target;
    let fx = tx - px,
      fy = ty - py,
      fz = tz - pz;
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl;
    fy /= fl;
    fz /= fl;
    const rl = Math.hypot(fz, fx),
      rx = -fz / rl,
      rz = fx / rl,
      ux = -rz * fy,
      uy = rz * fx - rx * fz,
      uz = rx * fy,
      h = Math.tan((camera.fov * Math.PI) / 360),
      w = h * (rect.width / rect.height);
    let dx = fx + rx * nx * w + ux * ny * h,
      dy = fy + uy * ny * h,
      dz = fz + rz * nx * w + uz * ny * h;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl;
    dy /= dl;
    dz /= dl;
    return [px, py, pz, dx, dy, dz];
  };

  // A hold is easier to hit with a finger than with a mouse; the slack grows with distance.
  const slack = (coarse: boolean) => (coarse ? 0.09 : 0.04);
  const hitPlaque = (r: readonly number[]): boolean => {
    if (r[5] >= 0) return false;
    const t = -r[2] / r[5],
      x = r[0] + r[3] * t,
      y = r[1] + r[4] * t;
    return Math.abs(x - PLAQUE.x) < PLAQUE.width / 2 + 0.04 && Math.abs(y - PLAQUE.y) < PLAQUE.height / 2 + 0.04;
  };
  let downX = 0,
    downY = 0,
    downAt = 0;
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      downX = e.clientX;
      downY = e.clientY;
      downAt = e.timeStamp;
    },
    { signal: abort.signal },
  );
  const choose = (x: number, y: number, coarse: boolean) => {
    const r = ray(x, y);
    if (hitPlaque(r)) {
      say(EGG);
      return true;
    }
    const hold = pickHold(holds, r[0], r[1], r[2], r[3], r[4], r[5], slack(coarse));
    if (hold < 0) return false;
    if (moment === 'route') setMoment('reach');
    sendTo(hold);
    return true;
  };
  canvas.addEventListener(
    'pointerup',
    (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 7 || e.timeStamp - downAt > 500) return;
      choose(e.clientX, e.clientY, e.pointerType !== 'mouse');
    },
    { signal: abort.signal },
  );
  // The climber looks where the mouse points, on the wall, while it waits. Touch has no hover, so nothing depends on it.
  canvas.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse' || e.buttons || still) return;
      const r = ray(e.clientX, e.clientY),
        t = r[5] < -0.05 ? Math.min(4, (0.6 - r[2]) / r[5]) : 3;
      climb.lookAt(r[0] + r[3] * t, r[1] + r[4] * t, r[2] + r[5] * t);
    },
    { signal: abort.signal },
  );

  for (const b of momentButtons)
    b.addEventListener('click', () => setMoment(b.dataset.moment as Moment), { signal: abort.signal });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-route]'))
    b.addEventListener(
      'click',
      () => {
        setMoment('route');
        startRoute(b.dataset.route as RouteName);
      },
      { signal: abort.signal },
    );
  $('climb').addEventListener(
    'click',
    () => {
      setMoment('route');
      startRoute('red');
    },
    { signal: abort.signal },
  );
  $('fall').addEventListener(
    'click',
    () => {
      stopRoute();
      afterLanding = null;
      if (still) {
        const start = positions(route('blue'), 0);
        climb.teleport(start.on, start.at);
        climber.snap();
        if (still) draw();
      } else climb.fall(MAT_TOP);
    },
    { signal: abort.signal },
  );
  $('reset').addEventListener(
    'click',
    () => {
      stopRoute();
      following = null;
      afterLanding = null;
      climb.teleport(hero.on, hero.at);
      climber.snap();
      if (still) draw();
      orbit.reset();
      setMoment('reach');
    },
    { signal: abort.signal },
  );
  const soundButton = $<HTMLButtonElement>('sound');
  soundButton.addEventListener(
    'click',
    async () => {
      const on = soundButton.getAttribute('aria-pressed') !== 'true';
      soundButton.setAttribute('aria-pressed', String(on));
      if (on && !sound) {
        const { createSound } = await import('./sound.ts');
        sound = createSound(engine as never);
      }
      sound?.setEnabled(on);
    },
    { signal: abort.signal },
  );
  addEventListener(
    'keydown',
    (e) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '1') setMoment('reach');
      else if (e.key === '2') setMoment('step');
      else if (e.key === '3') setMoment('route');
    },
    { signal: abort.signal },
  );
  setMoment('reach');

  if (settings.probeLive) probes.setLive({ facesPerFrame: 1 });
  await probes.bake();
  abort.signal.throwIfAborted();

  const readiness = await submitPrincipalScene(() => engine.render({ delta: 0 }), runtime.gpu!.queue, {
    signal: abort.signal,
  });
  watchQuality();
  // Reduced motion holds the scene at delta 0 and draws on demand: after an instant move, an orbit or a resize, and when a
  // restored GPU device starts empty.
  if (still) {
    orbit.addEventListener('change', draw);
    addEventListener('resize', () => requestAnimationFrame(draw), { signal: abort.signal });
    redrawAfterRestore(engine, draw);
  } else engine.start(settings.probeLive ? { culling: false } : undefined);
  (globalThis as { boulder?: unknown }).boulder = {
    readiness,
    engine,
    climb,
    climber,
    holds,
    routes,
    tier,
    egg: EGG,
    probes,
    views: { home, ray },
    startRoute,
    sendTo,
    choose,
    setMoment,
    get moment() {
      return moment;
    },
    get playing() {
      return playing !== null;
    },
    dispose: () => dispose(),
  };
} catch (reason) {
  if (!abort.signal.aborted) {
    error.textContent = String((reason as Error)?.message ?? reason);
    throw reason;
  }
}
