/// <reference lib="esnext.disposable" preserve="true" />
// The Fauld bomb store in one call: the underground RAF bomb store at Fauld, Staffordshire, in the old gypsum mine, on the
// morning of 27 November 1944 and after the explosion at 11:11 (and its portal yard outside). Built from the engine's
// packages: the store's models are asset-library glTF files with their PBR maps (`@margoengine/gltf/pbr`, one load per
// model and GPU instancing for every repeat), the mains bulbs are clustered spot lights shaped as caged bulkhead fittings
// (lower hemisphere only) with soft local shadows shared by importance (`@margoengine/clustered`), dusty air lit by the
// lamps (`@margoengine/environment/volumetric`), fire and smoke (`@margoengine/vfx`), ground-truth ambient occlusion,
// depth of field and bloom (`@margoengine/post`, `@margoengine/dof`), and one metered exposure per lighting state.
// Layout: x from the portal into the hill, y up, z south (plan +Y north is -z), metres; the floor at y = 0.
// Sources: the store's plan (RAF depot photographs: arch ribs, corrugated sheet, whitewashed piers, 2 ft rail, stacks on
// baulks; pillar-and-stall gypsum workings beside it); Waltham, "The Fauld explosion", Mercian Geologist 15(2), 2001
// (white gypsum, the store about 35 m down); lamps: Osram-GEC 60 W 240 V coiled coil, 690 lm, 2700 K (lamptech.co.uk),
// 40 W 400 lm and 100 W 1250 lm; exposure: Lagarde and de Rousiers, "Moving Frostbite to Physically Based Rendering",
// SIGGRAPH 2014 course, section 5.1 (EV100 and metering).
import type { EngineKernel, Vec3 } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { PBRInstances } from '@margoengine/gltf/pbr-instancing';
import { Clustered, type PointLight, type SpotLight } from '@margoengine/clustered';
import { LocalShadows } from '@margoengine/clustered/shadows';
import { LightGroups } from '@margoengine/clustered/groups';
import { LightBounce } from '@margoengine/clustered/bounce';
import { shadowBudget } from '@margoengine/clustered/budget';
import { lumensToCandela, exposureFromEV100 } from '@margoengine/clustered/units';
import { flameEmission } from '@margoengine/clustered/flicker';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { HemisphereLight } from '@margoengine/environment';
import { PostStack } from '@margoengine/post/stack';
import { GTAO } from '@margoengine/post/gtao';
import { Bloom } from '@margoengine/post/bloom';
import { SMAA } from '@margoengine/post/smaa';
import { DOF } from '@margoengine/dof';
import { Tonemap } from '@margoengine/tonemap';
import { Fire } from '@margoengine/vfx/fire';
import { Smoke } from '@margoengine/vfx/smoke';
import { sphereGeometry } from '@margoengine/geometry';
import { UnlitMaterial, createMesh } from '@margoengine/materials';
import { DAY_PRESETS } from '@margoengine/sky/day-presets';
import { PresetScene, SCENE_PRESETS } from '@margoengine/sky/scenes';
import { FAULD_TUNNELS_PLAN as PLAN } from './fauld-tunnels-plan.js';
import { FAULD_TUNNEL_STATES, fauldTunnelsInfo } from './fauld-tunnels-info.js';

export { fauldTunnelsInfo as info, FAULD_TUNNEL_STATES };
/** A lighting state of the store. */
export type FauldTunnelState = (typeof FAULD_TUNNEL_STATES)[number];

/** Settings of {@link attach}. Every one has a default: the store at work on the morning of 27 November 1944. */
export interface FauldTunnelsSettings {
  /** Lighting state. Default `working`. */
  readonly state?: FauldTunnelState;
  /** Seconds of the state when the scene opens (fire, smoke). Default 0. */
  readonly time?: number;
  /** `film` (1,024 texel lamp shadows, fine fog grid) or `preview`. Default `film`. */
  readonly quality?: 'film' | 'preview';
  /** URL root of the asset library holding the `fauld-1944` and `big-burn-1910` subjects. Default `/asset-library/`. */
  readonly library?: string;
  /** Aborts loading. */
  readonly signal?: AbortSignal;
}

/** A named place of the plan: where it is (metres, Margo axes) and how big. */
export interface FauldMark {
  readonly position: Vec3;
  readonly size: number;
}

/** The scene handle from {@link attach}. */
export interface FauldTunnelsScene extends Disposable {
  readonly settings: Readonly<Required<Omit<FauldTunnelsSettings, 'signal'>>>;
  /** Every mark of the plan, in Margo axes. */
  readonly marks: Readonly<Record<string, FauldMark>>;
  /** Plan metres (+X in, +Y north, Z up) to Margo axes. */
  toWorld(x: number, y: number, z: number): Vec3;
  /** Puts the camera at `from` looking at `to` with a lens of `focal` mm on a 36 mm wide 16:9 frame, focus on `to`. */
  frame(from: Vec3, to: Vec3, focal: number, fStop?: number): void;
  /** Moves the scene's own time on (fire, smoke): film frames use this, never the wall clock. */
  advanceTime(seconds: number): void;
  /** The state's exposure, EV100 (one per state, metered on a white card at its key mark). */
  readonly ev100: number;
  /** Models loaded, instances drawn and lamps lit (for checks). */
  readonly counts: {
    readonly models: number;
    readonly instances: number;
    readonly lamps: number;
    readonly shadowed: number;
  };
  readonly parts: {
    readonly lights: Clustered;
    readonly groups: LightGroups;
    readonly shadows: LocalShadows;
    readonly fog: VolumetricFog;
    readonly occlusion: GTAO;
    readonly dof: DOF;
    readonly bloom: Bloom;
    readonly tonemap: Tonemap;
    readonly stack: PostStack;
    readonly fires: readonly Fire[];
    readonly smokes: readonly Smoke[];
  };
  dispose(): void;
}

/**
 * Lamp catalogue (lighting plan): Osram-GEC coiled coil, 2700 K. Lumens per lamp.
 */
export const FAULD_LAMPS = { w40: 400, w60: 690, w100: 1250, handlamp: 40 } as const;
/** Light output ratio of a caged bulkhead fitting (lower hemisphere): judgement, lighting plan. */
export const BULKHEAD_OUTPUT = 0.65;
/**
 * EV100 per state: a white card at the state's key mark reads 1.0 (lighting plan, step 2). Mains about 3, hand lamps
 * 1, fire 5 to 6; daylight overcast November about 12, the portal lamp at night 1.
 */
export const FAULD_STATE_EV: Readonly<Record<FauldTunnelState, number>> = {
  working: 2,
  blast: 9,
  fire: 4,
  after: 1,
  flooded: 1,
  sealed: 1,
  yard_day: 12,
  yard_night: 1.5,
  yard_fire: 11.5,
  yard_sealed: 12,
};
/**
 * 2700 K tungsten in linear sRGB, scaled to luminance 1 so a lamp's candela are its photometric value: the blackbody's
 * sRGB (255, 169, 87) (Charity, "What color is a blackbody?", 2001, D65 white) decoded to linear (1, 0.397, 0.095),
 * over its luminance 0.2126 + 0.7152 x 0.397 + 0.0722 x 0.095 = 0.505.
 */
export const TUNGSTEN_2700: Vec3 = [1.98, 0.786, 0.188];
const TUNGSTEN = TUNGSTEN_2700;
/** The detonation flash of the blast state, candela (see the blast lamps in `attach`). */
export const BLAST_FLASH_CD = 1.9e6;
/** The mains rig by bulb run (lighting plan: main drift and work bay 100 W, aisles 60 W, old roadway 40 W). */
const LAMP_OF_RUN = (name: string): number =>
  /^bulbs_(main|workN)$/.test(name)
    ? FAULD_LAMPS.w100
    : /roadway/.test(name)
      ? FAULD_LAMPS.w40
      : /desklamp/.test(name)
        ? FAULD_LAMPS.w40
        : FAULD_LAMPS.w60;

type Extra = {
  scale?: number;
  pitch?: number;
  roll?: number;
  ground?: boolean;
  dz?: number;
  avoid?: readonly (readonly number[])[];
  aim?: readonly number[];
  cone?: number;
  rgb?: readonly number[];
  fire?: boolean;
};
type PropRow = readonly [string, string, number, number, number, number, Extra?];
type LineRow = readonly [string, string, number, number, number, number, number, Extra?];
type BulbRow = readonly [string, readonly number[], readonly number[], number, Extra?];
type FxRow = readonly [string, string, number, number, number, number];
type StateRow = {
  drop: readonly string[];
  props: readonly PropRow[];
  lines: readonly LineRow[];
  bulbs: readonly BulbRow[];
  fx: readonly FxRow[];
};

/** Plan metres to Margo axes: (x, z, -y). */
export const toWorld = (x: number, y: number, z: number): Vec3 => [x, z, -y];
const D = Math.PI / 180;

/** Column-major matrix of a plan placement: yaw about up, then pitch, then roll (Unreal's rotator order), scale. */
export function placement(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0, s = 1): number[] {
  const cy = Math.cos(yaw * D),
    sy = Math.sin(yaw * D),
    cp = Math.cos(pitch * D),
    sp = Math.sin(pitch * D),
    cr = Math.cos(roll * D),
    sr = Math.sin(roll * D);
  // In Margo axes yaw turns about +y; pitch about the piece's own -z (plan +Y); roll about its x.
  const Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const Rz = [cp, sp, 0, -sp, cp, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cr, sr, 0, -sr, cr];
  const m3 = (a: number[], b: number[]) =>
    Array.from({ length: 9 }, (_, i) => {
      const c = Math.floor(i / 3),
        r = i % 3;
      return a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
    });
  const R = m3(m3(Ry, Rz), Rx),
    p = toWorld(x, y, z);
  return [
    R[0] * s,
    R[1] * s,
    R[2] * s,
    0,
    R[3] * s,
    R[4] * s,
    R[5] * s,
    0,
    R[6] * s,
    R[7] * s,
    R[8] * s,
    0,
    p[0],
    p[1],
    p[2],
    1,
  ];
}

/** Points of a line row: from `from` toward `to` every `every` metres (both ends), minus `avoid` circles. */
export function linePoints(row: LineRow): { x: number; y: number; yaw: number }[] {
  const [, , x0, y0, x1, y1, every, extra] = row,
    len = Math.hypot(x1 - x0, y1 - y0),
    n = Math.max(0, Math.floor(len / every + 1e-6)),
    yaw = Math.atan2(y1 - y0, x1 - x0) / D,
    out: { x: number; y: number; yaw: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const t = len ? (k * every) / len : 0,
      x = x0 + (x1 - x0) * t,
      y = y0 + (y1 - y0) * t;
    if (extra?.avoid?.some(([ax, ay, r]) => Math.hypot(x - ax, y - ay) <= r)) continue;
    out.push({ x, y, yaw });
  }
  return out;
}

/** Every lamp position of a bulb row (from, to, every). */
export function bulbPoints(row: BulbRow): number[][] {
  const [, a, b, every] = row,
    len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
    n = Math.max(0, Math.floor(len / every + 1e-6)),
    out: number[][] = [];
  for (let k = 0; k <= n; k++) {
    const t = len ? (k * every) / len : 0;
    out.push([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t));
  }
  return out;
}

/** What a state draws: its pieces by asset (plan rows), its lamps and its fire and smoke. */
export function dressState(state: FauldTunnelState) {
  const st = (PLAN.states as unknown as Record<string, StateRow>)[state];
  if (!st) throw new RangeError(`Unknown Fauld tunnels state ${state}; use one of ${FAULD_TUNNEL_STATES.join(', ')}`);
  const drop = new Set(st.drop),
    // a state's own rows replace the base rows of the same name (the cradle with its bomb, a door)
    own = new Set([...st.props.map((p) => p[0]), ...st.lines.map((l) => l[0])]),
    props = [...(PLAN.props as unknown as PropRow[]).filter((p) => !drop.has(p[0]) && !own.has(p[0])), ...st.props],
    lines = [...(PLAN.lines as unknown as LineRow[]).filter((l) => !drop.has(l[0]) && !own.has(l[0])), ...st.lines],
    bulbs = [...(PLAN.bulbs as unknown as BulbRow[]).filter((b) => !drop.has(b[0])), ...st.bulbs],
    yard = state.startsWith('yard');
  const pieces = new Map<string, number[][]>();
  const add = (asset: string, m: number[]) => (pieces.get(asset) ?? pieces.set(asset, []).get(asset)!).push(m);
  for (const [, asset, x, y, z, yaw, e] of props) add(asset, placement(x, y, z, yaw, e?.pitch, e?.roll, e?.scale));
  for (const row of lines) for (const p of linePoints(row)) add(row[1], placement(p.x, p.y, row[7]?.dz ?? 0, p.yaw));
  // the old roadway's timber sets (plan: tset rows at x 125 every 3 m), legs against each rock wall and a cap across,
  // built from the sawn baulk (2.4 m): legs stand, the cap spans the 6 m roadway at 1.08 times its length per metre
  if (!yard)
    for (const y of [-19.5, -16.5, -13.5, -10.5, 10.5, 13.5, 16.5, 19.5]) {
      add('fauld-1944/tunnels/tp_baulk', placement(122.35, y, 1.2, 0, 90));
      add('fauld-1944/tunnels/tp_baulk', placement(127.65, y, 1.2, 0, 90));
      add('fauld-1944/tunnels/tp_baulk', placement(123.8, y, 2.475, 0));
      add('fauld-1944/tunnels/tp_baulk', placement(126.2, y, 2.475, 0));
    }
  const lamps: { run: string; at: number[]; extra?: Extra }[] = [];
  for (const row of bulbs) for (const at of bulbPoints(row)) lamps.push({ run: row[0], at, extra: row[4] });
  return { pieces, lamps, fx: st.fx };
}

const lensFov = (focal: number) => (2 * Math.atan(20.25 / (2 * focal))) / D; // 36 x 20.25 mm (16:9 full frame)

/**
 * Builds the store (or its yard) in `engine`'s active scene.
 * @throws RangeError for an unknown state or a time outside 0..600; Error for an asset that does not load.
 * @example
 * const scene = await attach(engine, { state: 'working', library: '/asset-library/' });
 * scene.frame(scene.marks.c_fd004_a.position, scene.marks.racks.position, 24);
 */
export async function attach(engine: EngineKernel, settings: FauldTunnelsSettings = {}): Promise<FauldTunnelsScene> {
  const s = {
    state: settings.state ?? 'working',
    time: settings.time ?? 0,
    quality: settings.quality ?? 'film',
    library: settings.library ?? '/asset-library/',
  } as const;
  if (!FAULD_TUNNEL_STATES.includes(s.state))
    throw new RangeError(`Unknown Fauld tunnels state ${s.state}; use one of ${FAULD_TUNNEL_STATES.join(', ')}`);
  if (!(s.time >= 0 && s.time <= 600)) throw new RangeError('Invalid Fauld tunnels time; pass 0 to 600 seconds');
  const film = s.quality === 'film',
    yard = s.state.startsWith('yard'),
    ev = FAULD_STATE_EV[s.state],
    root = s.library.endsWith('/') ? s.library : s.library + '/',
    { pieces, lamps, fx } = dressState(s.state);
  const lights = Clustered.attach(engine, { maxLights: 256 }),
    groups = LightGroups.attach(engine, lights),
    shadows = LocalShadows.attach(engine, { lights, maxLights: film ? 16 : 8, resolution: film ? 1024 : 512 });
  const disposers: (() => void)[] = [],
    night = s.state === 'yard_night';
  let sky: PresetScene | undefined, bounce: { dispose(): void } | undefined;
  if (yard) {
    // A November overcast at Fauld (52.85 N) near noon (the sun 14 degrees up in the south, behind the deck), or the
    // night after dusk; the preset's sky lights the yard and brings its own bloom and grade.
    sky = PresetScene.attach(engine, {
      ...SCENE_PRESETS.overcast,
      day: { ...DAY_PRESETS.overcast, azimuth: 190, elevation: night ? -8 : 14 },
      fog: 3.912 / 3000,
    });
  } else {
    // The core sun is off underground: the rock has no opening but the portal.
    engine.lighting.radiance.set([0, 0, 0, 0]);
    engine.lighting.ambient.set([0, 0, 0]);
    // What the lamp-lit gypsum walls and floor bounce back, a little warm light from every side (no sky down here).
    bounce = HemisphereLight.attach(engine, {
      sky: [0.02, 0.016, 0.011],
      ground: [0.012, 0.01, 0.008],
      intensity: 0.4,
    } as never);
  }
  // Models: one load each, every repeat drawn by GPU instancing.
  let instances = 0;
  const models: { dispose?(): void }[] = [];
  await Promise.all(
    [...pieces].map(async ([asset, mats]) => {
      const id = asset.slice(asset.lastIndexOf('/') + 1),
        model = await loadGLTF(engine, `${root}${asset}/${id}_2k.gltf`, { signal: settings.signal });
      const inst = new PBRInstances(mats.length);
      mats.forEach((m, i) => inst.setMatrixAt(i, m));
      for (const p of (model as unknown as { primitives: { instances?: PBRInstances }[] }).primitives)
        p.instances = inst;
      instances += mats.length;
      lights.add(model as never);
      shadows.add(model as never);
      models.push(model as never);
    }),
  );
  // Lamps: each a caged bulkhead fitting (the kit's lamp bracket) with its bulb lighting the lower hemisphere, or a
  // hand lamp's cone toward its aim. Every light has a fitting on real geometry (lighting plan, step 1).
  const glass: Vec3[] = [];
  const lampLights: (PointLight | SpotLight)[] = [];
  for (const { run, at, extra } of lamps) {
    if (extra?.fire) continue; // the fires light themselves (vfx Fire)
    const p = toWorld(at[0], at[1], at[2]);
    if (extra?.aim) {
      const a = toWorld(extra.aim[0], extra.aim[1], extra.aim[2]),
        d = [a[0] - p[0], a[1] - p[1], a[2] - p[2]],
        l = Math.hypot(d[0], d[1], d[2]) || 1,
        cone = ((extra.cone ?? 34) / 2) * D;
      lampLights.push({
        position: p,
        direction: [d[0] / l, d[1] / l, d[2] / l],
        outerAngle: cone,
        innerAngle: cone * 0.55,
        range: 25,
        color: (extra.rgb as Vec3 | undefined) ?? [1, 0.82, 0.6],
        intensity: lumensToCandela(FAULD_LAMPS.handlamp, { outerAngle: cone, innerAngle: cone * 0.55 }),
        radius: 0.02,
        castShadow: true,
      });
      continue;
    }
    const lm = LAMP_OF_RUN(run) * BULKHEAD_OUTPUT;
    lampLights.push({
      position: p,
      direction: [0, -1, 0],
      outerAngle: Math.PI / 2,
      innerAngle: Math.PI * 0.32,
      range: 22,
      color: TUNGSTEN,
      intensity: lumensToCandela(lm, { outerAngle: Math.PI / 2, innerAngle: Math.PI * 0.32 }),
      radius: 0.03,
      castShadow: true,
    });
    glass.push(p);
  }
  // The blast: the first instant of the detonation, a white fireball at each fire of the state that floods the drift
  // to the blast state's metered exposure (EV100 9: a pale wall 30 m away reads mid grey at about 700 lux, so
  // 700 x 30^2, about 630,000 cd; BLAST_FLASH_CD holds three times that so the near bays clip, as the flash did).
  if (s.state === 'blast')
    for (const [, kind, x, y] of fx)
      if (kind === 'fire')
        lampLights.push({
          position: toWorld(x, y, 3.1),
          color: [1, 0.93, 0.82],
          intensity: BLAST_FLASH_CD,
          range: 220,
          radius: 0.6,
          castShadow: true,
        });
  const viewer = () => engine.camera.position as unknown as Vec3;
  const bulbs = groups.group('bulbs');
  const budget = () =>
    bulbs.setLights(
      shadowBudget(lampLights, {
        viewer: viewer(),
        texels: (film ? 1024 : 512) ** 2 * 6 * (film ? 16 : 8),
        resolution: film ? 1024 : 512,
        maxLights: film ? 16 : 8,
      }),
    );
  budget();
  // One bounce of every shadowed lamp: the lit floor, stacks and whitewash light the arch, the rock and the undersides,
  // as the white gypsum and limewash did (the lamps light only their lower hemisphere).
  const lightBounce = LightBounce.attach(engine, { lights, intensity: 1 } as never);
  disposers.push(() => lightBounce.dispose?.());
  // The glowing bulbs: a 30 mm sphere at the light's own radiance (flameEmission: intensity over the projected area).
  if (glass.length) {
    const bulb = lampLights.find((l) => (l as SpotLight).outerAngle === Math.PI / 2)!;
    const mat = new UnlitMaterial({
      color: [0, 0, 0],
      ...flameEmission({ color: TUNGSTEN, intensity: bulb.intensity!, radius: 0.03 }),
    });
    for (const p of glass) {
      const m = createMesh(engine, sphereGeometry(0.03, 12, 8), mat);
      m.root.setPosition([p[0], p[1] - 0.04, p[2]]);
      models.push(m as never);
    }
  }
  const stack = sky ? sky.post : PostStack.attach(engine, []);
  // Fire and smoke of the state.
  const fires: Fire[] = [],
    smokes: Smoke[] = [];
  for (const [, kind, x, y, z, scale] of fx) {
    const p = toWorld(x, y, z);
    // A burning store: flames about 1.6 m long a unit of scale (a crate and its packing, about 1 MW by Heskestad's
    // length), held under the 3.6 m arch, with their own light and smoke on the lamps' groups.
    if (kind === 'fire')
      fires.push(
        Fire.attach(engine, {
          position: p,
          flameLength: Math.min(3, 1.6 * scale),
          width: 0.9 * scale,
          lights: groups,
          depth: () => stack.depthTexture,
        }),
      );
    else if (yard)
      smokes.push(
        Smoke.attach(engine, {
          position: p,
          heat: 2e5 * scale,
          radius: 0.8 * scale,
          color: [0.08, 0.075, 0.07],
          opacity: 0.85,
          prewarm: true,
        } as never),
      );
  }
  // Dusty air lit by the lamps: fine gypsum dust in the mains states, thick smoke after the blast and in the fire.
  const smoky = s.state === 'fire' || s.state === 'blast' || s.state === 'after';
  // In the yard the lamp-lit volumetric fog takes over from the preset's sky fog (one fog at a time).
  if (sky) delete (sky.sky.options as { fog?: unknown }).fog;
  const fog = VolumetricFog.attach(engine, {
    density: yard ? 0.002 : smoky ? 0.06 : s.state === 'working' ? 0.012 : 0.02,
    color: smoky ? [0.55, 0.5, 0.45] : [0.9, 0.88, 0.84],
    anisotropy: 0.55,
    noise: smoky ? 0.6 : 0.3,
    noiseScale: smoky ? 4 : 6,
    multipleScattering: smoky ? 4 : 2,
    range: yard ? 120 : 70,
    lights,
    depth: () => stack.depthTexture,
  } as never);
  const occlusion = new GTAO({ radius: 1.2, slices: film ? 3 : 2, steps: film ? 8 : 6 } as never),
    dof = new DOF({ focalDistance: 5, aperture: 2.8, filmGauge: 36 }),
    smaa = new SMAA({ quality: 'high' } as never);
  let tonemap: Tonemap, bloom: Bloom;
  if (sky) {
    // The yard keeps the overcast preset's bloom and grade (the sky is in its own relative units); at night the lamps
    // set the exposure, in candela, as underground.
    tonemap = sky.tonemap;
    bloom = sky.bloom;
    if (night) Object.assign(tonemap.options, { exposure: Math.log2(exposureFromEV100(ev)), temperature: 3200 });
    stack.addEffect(occlusion as never, 0);
    stack.addEffect(dof as never, 1);
    stack.addEffect(smaa as never);
  } else {
    // A lens's veiling glare: a few percent of a bulb's light round it (the clipped bulb itself carries the rest).
    bloom = new Bloom({ threshold: 1.5, strength: 0.025, radius: 0.5 });
    tonemap = new Tonemap({
      curve: 'agx',
      exposure: Math.log2(exposureFromEV100(ev)),
      contrast: 1.05,
      temperature: 3200,
    } as never);
    for (const e of [occlusion, dof, bloom, tonemap, smaa]) stack.addEffect(e as never);
  }
  let time = s.time;
  for (const f of [...fires, ...smokes]) (f as unknown as { advance?(t: number): void }).advance?.(time);
  const marks = Object.fromEntries(
    Object.entries(PLAN.marks as unknown as Record<string, readonly number[]>).map(([k, [x, y, z, size]]) => [
      k,
      { position: toWorld(x, y, z), size },
    ]),
  );
  disposers.push(() => {
    for (const f of fires) f.dispose();
    for (const f of smokes) f.dispose();
    for (const m of models) m.dispose?.();
    fog.dispose?.();
    if (sky) sky.dispose();
    else stack.dispose?.();
    bounce?.dispose();
    shadows.dispose?.();
    groups.dispose?.();
    lights.dispose?.();
  });
  const scene: FauldTunnelsScene = {
    settings: s,
    marks,
    toWorld,
    frame(from, to, focal, fStop = 2.8) {
      engine.camera.position = from as never;
      engine.camera.target = to as never;
      engine.camera.fov = lensFov(focal);
      const d = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      dof.options.focalDistance = Math.max(0.2, d);
      dof.options.aperture = fStop;
      budget();
    },
    advanceTime(seconds) {
      time += seconds;
      for (const f of [...fires, ...smokes]) (f as unknown as { advance?(t: number): void }).advance?.(seconds);
    },
    ev100: ev,
    counts: { models: pieces.size, instances, lamps: lampLights.length, shadowed: film ? 16 : 8 },
    parts: { lights, groups, shadows, fog, occlusion, dof, bloom, tonemap, stack, fires, smokes },
    dispose() {
      for (const d of disposers.splice(0)) d();
    },
    [Symbol.dispose]() {
      scene.dispose();
    },
  };
  return scene;
}
