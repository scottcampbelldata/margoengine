/// <reference lib="esnext.disposable" preserve="true" />
// The Fauld explosion of 27 November 1944, 11:11, as a scene on film time: the countryside of ./fauld-world.ts (the real
// OS Terrain 50 hills, the hedged farm quilt, an overcast late morning) with the blast drawn into it by the engine's
// packages. Two releases a breath apart rise as one merging mushroom cloud (`BlastCloud` of @margoengine/weather/eruption,
// drawn into `Clouds` of @margoengine/vfx/clouds, lit by the scene's own sun, the fire inside it in a second, unlit
// `Clouds`); earth clods and white gypsum blocks fly on ballistic paths and land with dust (`Debris` of
// @margoengine/vfx/debris, drawn as instances of a library rock); the incendiary dump burns on the surface (`Fire` of
// @margoengine/vfx/fire); and with `mud` the burst reservoir's mud pours down the slope to Ford's works (`Flood` of
// @margoengine/water/flood in its mud mode). Every part is a function of the film time: `seek(t)` shows the same frame
// from any order, and each engine frame moves the film on by its delta.
// History (channel-films Docs/fauld-reference-bible.md): about 3,700 tonnes of bombs went up in two explosions seconds
// apart; the column rose about 3 km and was seen 30 km away; the reservoir above Ford's plaster works burst and about
// 450,000 m^3 of mud and water swept down onto the works.
import type { EngineKernel, Vec3 } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { BlastCloud, type BlastSource } from '@margoengine/weather/eruption';
import { Clouds } from '@margoengine/vfx/clouds';
import { Debris } from '@margoengine/vfx/debris';
import { Fire } from '@margoengine/vfx/fire';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { PBRInstances } from '@margoengine/gltf/pbr-instancing';
import { Water } from '@margoengine/water';
import { Flood } from '@margoengine/water/flood';
import { attachFauldWorld, FAULD_PLACES, type FauldWorld, type FauldWorldSettings } from './fauld-world.js';

export {
  FAULD_CENTRE,
  FAULD_CLOUD_DECK,
  FAULD_PLACES,
  FAULD_SIZE,
  FAULD_SLOTS,
  type FauldEra,
  type FauldSky,
} from './fauld-world.js';

/** Settings of {@link attach}: the shared Fauld settings plus the film time and the mud. */
export interface FauldBlastSettings extends FauldWorldSettings {
  /** Film seconds since the first explosion at attach, 0 to 3,600. Default 0. */
  readonly time?: number;
  /** Whether the burst reservoir's mud flows (`Flood` in mud mode). Default false (it costs a GPU solver). */
  readonly mud?: boolean;
  /**
   * Whether each engine frame moves the film on by its delta. Default true; false leaves the film where `seek` puts it
   * (a shot tool that seeks every frame from its own clock).
   */
  readonly clock?: boolean;
  /** Puffs of each cap and each stem (`BlastCloud.draw`). Default 2,040 and 1,020. */
  readonly puffs?: { readonly cap?: number; readonly stem?: number };
}

/** The scene handle: the world plus the blast's parts and its film clock. */
export interface FauldBlast extends FauldWorld {
  readonly blast: BlastCloud;
  readonly smoke: Clouds;
  readonly fire: Clouds;
  readonly debris: readonly Debris[];
  readonly flood: Flood | undefined;
  /** Film seconds since the first explosion. */
  readonly time: number;
  /** Sets the film time; every part shows that moment. */
  seek(t: number): void;
}

/**
 * The two releases: 3,700 tonnes of bombs, a share of it high explosive, given as 4,000 t of TNT equivalent split
 * 55 / 45 between two explosions 1.6 s apart (a model choice from the two shocks the witnesses heard), the second
 * 95 m east of the first along the crater's long axis.
 */
export const FAULD_BLASTS = Object.freeze([
  { at: 0, at_: [-40, 10] as const, tnt: 2.2e6, speed: 120 },
  { at: 1.6, at_: [55, -15] as const, tnt: 1.8e6, speed: 110 },
]);
/** Film second the reservoir's bank goes and the mud starts down the slope. */
export const FAULD_MUD_AT = 20;
/** Film second the incendiary dump on the surface catches. */
export const FAULD_FIRE_AT = 3;
/** The incendiary dump on the surface, [x, z] metres from the crater. */
export const FAULD_DUMP = Object.freeze([-150, 95] as const);

/** Seconds the reservoir pours and its rate, m^3/s: about 450,000 m^3 in all. */
const MUD_SECONDS = 180,
  MUD_RATE = 2500;
/** The mud's ground: a patch from the reservoir down to the works, 2.5 m cells. */
const MUD = { origin: [-200, -1000] as const, size: [800, 800] as const, cells: 320 };

/**
 * Builds the countryside with the explosion into `engine`, at film time `settings.time`.
 * @example
 * const scene = await attach(engine, { sky: 'overcast', time: 30 });
 * scene.look([-1800, 150, 900], [0, 900, 0], 30);
 * scene.seek(60); // the column a minute after the first explosion
 */
export async function attach(engine: EngineKernel, settings: FauldBlastSettings = {}): Promise<FauldBlast> {
  // Settings are checked before anything is built.
  const start = settings.time ?? 0;
  if (!(start >= 0 && start <= 3600)) throw new RangeError(`fauld-blast time ${start} is outside 0 to 3,600 seconds.`);
  const world = await attachFauldWorld(engine, { era: 'before', sky: 'overcast', ...settings }),
    disposers: (() => void)[] = [];
  try {
    const ground = (x: number, z: number) => world.height(x, z),
      base = ground(0, 0),
      lighting = (engine.scene as unknown as { lighting: { direction: Float32Array } }).lighting,
      sun: Vec3 = [lighting.direction[0]!, lighting.direction[1]!, lighting.direction[2]!];
    // The fire first, so the smoke draws over it.
    const fire = Clouds.attach(engine, { limit: 400, shading: 'unlit' });
    disposers.push(() => fire.dispose());
    // Overcast light: a weak, white sun through the deck and a strong sky light.
    const smoke = Clouds.attach(engine, {
      limit: 16000,
      relief: 1,
      lightDirection: sun,
      lightColor: [0.55, 0.55, 0.56],
      ambient: 0.75,
      density: 0.35,
    });
    disposers.push(() => smoke.dispose());
    const sources: BlastSource[] = FAULD_BLASTS.map((b) => ({
      at: b.at,
      tnt: b.tnt,
      speed: b.speed,
      position: [b.at_[0], ground(b.at_[0], b.at_[1]), b.at_[1]],
    }));
    const blast = new BlastCloud({ sources, altitude: base, wind: 3, windDirection: 70, fireDuration: 6, seed: 1944 });
    disposers.push(() => blast.clear());
    // Earth clods and gypsum blocks out of the crater (230 m across): the clods brown, the gypsum white.
    const debris = [
      new Debris({
        origin: [0, base, 0],
        radius: 80,
        count: 1400,
        speed: 40,
        size: [0.3, 2.4],
        density: 1800,
        ground,
        color: [0.2, 0.15, 0.1],
        puffColor: [0.34, 0.3, 0.26],
        seed: 27,
      }),
      new Debris({
        origin: [0, base, 0],
        radius: 60,
        count: 260,
        start: 1.6,
        speed: 35,
        size: [0.4, 2.8],
        density: 2300,
        ground,
        color: [0.78, 0.76, 0.7],
        puffColor: [0.6, 0.58, 0.54],
        seed: 44,
      }),
    ];
    // Each piece an instance of a library rock (Poly Haven rock_07, CC0, about 0.25 m across, scaled to a unit size).
    const rocks = await Promise.all(
      debris.map(async (d) => {
        const model = await loadGLTF(
            engine,
            `${settings.library ?? '/asset-library/'}big-burn-1910/rocks/rock_07/rock_07_2k.gltf`,
            settings.signal ? { signal: settings.signal } : {},
          ),
          inst = new PBRInstances(d.options.count ?? 300);
        for (const p of (model as unknown as { primitives: { instances?: PBRInstances }[] }).primitives)
          p.instances = inst;
        disposers.push(() => (model as unknown as { dispose(): void }).dispose());
        const unit = new Float32Array(16);
        return {
          capacity: inst.capacity,
          get count() {
            return inst.count;
          },
          set count(n: number) {
            inst.count = n;
          },
          setMatrixAt(i: number, m: ArrayLike<number>) {
            for (let k = 0; k < 16; k++) unit[k] = k < 12 && k % 4 !== 3 ? m[k]! * 4 : m[k]!;
            inst.setMatrixAt(i, unit);
          },
          setColorAt(i: number, c: ArrayLike<number>) {
            inst.setColorAt(i, [c[0]!, c[1]!, c[2]!, 1]);
          },
        };
      }),
    );
    // The incendiary dump burning on the surface, from FAULD_FIRE_AT on.
    let dump: Fire | undefined;
    // The mud: the reservoir's water and the blown earth pouring from the burst bank down to the works.
    let flood: Flood | undefined, water: Water | undefined;
    if (settings.mud) {
      const n = MUD.cells,
        heights = new Float32Array(n * n);
      let low = Infinity;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const h = ground(
            MUD.origin[0] + ((i + 0.5) * MUD.size[0]) / n,
            MUD.origin[1] + ((j + 0.5) * MUD.size[1]) / n,
          );
          heights[j * n + i] = h;
          low = Math.min(low, h);
        }
      const made = new Map<GPUDevice, GPUTexture>();
      const heightmap = () => {
        const device = (engine as unknown as { gpu: GPUDevice }).gpu;
        if (!made.has(device)) {
          const t = device.createTexture({
            size: [n, n],
            format: 'r32float',
            usage: 0x04 | 0x02, // GPUTextureUsage TEXTURE_BINDING | COPY_DST (no WebGPU globals in the types)
          });
          device.queue.writeTexture({ texture: t }, heights, { bytesPerRow: n * 4 }, [n, n]);
          made.set(device, t);
        }
        return made.get(device);
      };
      water = Water.attach(
        engine as never,
        {
          height: low - 5,
          size: [2400, 2400],
          segments: 512,
          waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
          color: [0.11, 0.075, 0.045],
          terrain: { heightmap, origin: MUD.origin, size: MUD.size, heights: { data: heights, width: n, height: n } },
        } as never,
      );
      disposers.push(() => water?.dispose());
      flood = Flood.attach(
        engine as never,
        {
          surface: water,
          mud: { sediment: 'aspen-natural-soil', concentration: 0.42 },
          roughness: 0.04,
          maxDepth: 12,
          maxSpeed: 20,
        } as never,
      );
      disposers.push(() => flood?.dispose());
      disposers.push(() => made.forEach((t) => t.destroy()));
    }
    let film = -1,
      pouring = false,
      seeking = true;
    // The film second the flood's clock started from: the mud's start, or the attach time when that is later (the
    // flood is first moved on to the attach time in two legs, so the sources stop where they do in a continuous run).
    const floodAt = Math.min(start, FAULD_MUD_AT);
    if (flood && start > FAULD_MUD_AT) {
      const [rx, rz] = FAULD_PLACES.reservoir,
        pour = Math.min(start - FAULD_MUD_AT, MUD_SECONDS);
      flood.setSources([{ position: [rx, rz - 40], discharge: MUD_RATE, radius: 25 }]);
      flood.advanceTime(pour);
      pouring = true;
    }
    const show = (t: number) => {
      blast.seek(t);
      blast.draw(smoke, fire, settings.puffs ?? {});
      for (const [k, d] of debris.entries()) {
        d.seek(t);
        d.draw(rocks[k]!);
        d.drawPuffs(smoke);
      }
      if (!dump && t >= FAULD_FIRE_AT) {
        const [x, z] = FAULD_DUMP;
        dump = Fire.attach(engine as never, { position: [x, ground(x, z), z], flameLength: 14, width: 60 });
        disposers.push(() => dump?.dispose());
      }
      if (flood) {
        // The reservoir (about 450,000 m^3) empties at 2,500 m^3/s for three minutes through the breach in its north
        // bank. The flood keeps its own clock (one engine frame moves both by the same delta); a seek moves it on.
        const on = t >= FAULD_MUD_AT && t < FAULD_MUD_AT + MUD_SECONDS;
        if (on !== pouring) {
          const [rx, rz] = FAULD_PLACES.reservoir;
          flood.setSources(on ? [{ position: [rx, rz - 40], discharge: MUD_RATE, radius: 25 }] : []);
          pouring = on;
        }
        if (seeking && t > floodAt + flood.time) flood.advanceTime(t - floodAt - flood.time);
      }
      film = t;
    };
    show(start);
    seeking = false;
    // Each engine frame moves the film on by its delta.
    const runtime = engineRuntime(engine),
      clock = {
        name: 'fauld-blast-clock',
        onPreUpdate(delta: number) {
          if (delta > 0) show(film + delta);
        },
      };
    if (settings.clock ?? true) runtime.use(clock as never);
    const handle: FauldBlast = {
      ...world,
      blast,
      smoke,
      fire,
      debris,
      get flood() {
        return flood;
      },
      get time() {
        return film;
      },
      seek(t: number) {
        if (!(t >= 0)) throw new RangeError(`fauld-blast seek ${t}: pass film seconds of 0 or more.`);
        if (flood && t < floodAt + flood.time - 1e-9)
          throw new RangeError(`fauld-blast seek ${t}: the mud runs forward only; attach a new scene to go back.`);
        seeking = true;
        show(t);
        seeking = false;
      },
      dispose() {
        (runtime as unknown as { sceneOf(p: object): { removePlugin(n: string): void } | undefined })
          .sceneOf(clock)
          ?.removePlugin(clock.name);
        for (const d of disposers.reverse()) d();
        disposers.length = 0;
        world.dispose();
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
    return handle;
  } catch (error) {
    for (const d of disposers.reverse()) d();
    world.dispose();
    throw error;
  }
}
