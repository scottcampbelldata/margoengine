/// <reference lib="esnext.disposable" preserve="true" />
import type { Mesh } from '@margoengine/core';
import type {
  ColorBackground,
  EnvironmentLighting,
  EnvironmentLoadOptions,
  EnvironmentSource,
} from '@margoengine/environment';
import type { GLTFLoadOptions, PBRModel } from '@margoengine/gltf-pro';
import type { Shadows, ShadowOptions } from '@margoengine/shadows';
import type { ContactShadowOptions, ContactShadows } from '@margoengine/staging';
import type { Tonemap, TonemapOptions } from '@margoengine/tonemap';
import type { Stage } from './index.js';
import { optionalPackage, stageSignal } from './feature.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** The turntable's settings. */
export interface TurntableOptions {
  /** Seconds per turn; negative turns the other way. Default 30. */
  seconds?: number;
  /** Seconds after the last drag or wheel before it turns again. Default 3. */
  resumeAfter?: number;
}
/** Options for `addViewer`. Each `false` leaves that part out, and its package need not be installed. */
export interface ViewerOptions {
  /** `.hdr`, `.exr` or UltraHDR `.jpg` URL, or a decoded source, for the image-based light. Default a built-in soft studio. */
  environment?: string | URL | EnvironmentSource | false;
  /** `EnvironmentLighting.load` options, such as `intensity`. */
  lighting?: Omit<EnvironmentLoadOptions, 'signal'>;
  /** Colour behind the model. A light one, because a ground shadow needs something to darken. Default '#dfe1e4'. */
  background?: string | false;
  /** 'contact' for a soft ground shadow, 'cascaded' for a cast shadow on a floor. Default 'contact'. */
  shadows?: 'contact' | 'cascaded' | false;
  /** Options of the shadow picked by `shadows`, over the values the viewer tunes to the model's size. */
  shadow?: ContactShadowOptions | ShadowOptions;
  /** Tonemap options; `exposure` is the one a viewer usually wants. Default the neutral curve at exposure 0. */
  tonemap?: TonemapOptions | false;
  /** Orbit the camera around the model. Default true, and off for a visitor who asks for reduced motion. */
  turntable?: boolean | TurntableOptions;
  /** Frame the model from a three-quarter view and set the camera's near and far to its size. Default true. */
  fit?: boolean;
  /** `loadGLTF` options, such as a shared `draco` decoder. */
  gltf?: Omit<GLTFLoadOptions, 'signal'>;
  /** Cancels the load; the stage's disposal cancels it too. */
  signal?: AbortSignal;
}

/** What `addViewer` returns. */
export interface Viewer {
  /** The loaded model. */
  readonly model: PBRModel;
  /** The image-based light, or null with `environment: false`. */
  readonly environment: EnvironmentLighting | null;
  /** The colour behind the model, or null with `background: false`; `viewer.background.color` is live. */
  readonly background: ColorBackground | null;
  /** The shadow, or null with `shadows: false`. */
  readonly shadows: ContactShadows | Shadows | null;
  /** The floor that receives a 'cascaded' shadow, otherwise null. */
  readonly floor: Mesh | null;
  /** The grading pass, or null with `tonemap: false`; `viewer.tonemap.options.exposure` is live. */
  readonly tonemap: Tonemap | null;
  /** Whether the camera turns; set it to start or stop. */
  turntable: boolean;
  /** Removes the model and everything the viewer added. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Soft boxes of the built-in studio: direction, cosine of the edge and radiance. */
const lamps = [
  [0.45, 0.8, 0.4, 0.8, 9],
  [-0.85, 0.3, 0.45, 0.85, 3],
  [0.1, 0.35, -0.95, 0.9, 5],
] as const;

/** A neutral 128 x 64 equirect studio: a grey room, lighter overhead, with a key, a fill and a rim soft box. */
function studio(): EnvironmentSource {
  const width = 128,
    height = 64,
    data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const polar = ((y + 0.5) / height) * Math.PI,
      up = Math.cos(polar),
      ring = Math.sin(polar);
    for (let x = 0; x < width; x++) {
      const azimuth = ((x + 0.5) / width) * Math.PI * 2,
        dx = ring * Math.sin(azimuth),
        dz = ring * Math.cos(azimuth);
      let radiance = 0.45 + 0.25 * up;
      for (const [lx, ly, lz, edge, power] of lamps) {
        const inside = ((dx * lx + up * ly + dz * lz) / Math.hypot(lx, ly, lz) - edge) / (1 - edge);
        if (inside > 0) radiance += power * Math.min(1, inside * 3);
      }
      data.fill(radiance, (y * width + x) * 4, (y * width + x) * 4 + 3);
      data[(y * width + x) * 4 + 3] = 1;
    }
  }
  return { width, height, data };
}

/** Rotates the camera around its target, on the world's Y axis. */
function orbit(stage: Stage, angle: number): void {
  const { camera } = stage.engine,
    [x, y, z] = camera.position,
    [tx, , tz] = camera.target,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  camera.position = [tx + (x - tx) * cos + (z - tz) * sin, y, tz - (x - tx) * sin + (z - tz) * cos];
}

/**
 * Loads a model into a product viewer: `@margoengine/gltf-pro` for the model, image-based light and a plain backdrop
 * from `@margoengine/environment`, a soft ground shadow from `@margoengine/staging` or a cast one from
 * `@margoengine/shadows`, grading from `@margoengine/tonemap`, a framed camera and a turntable, sized to the model.
 * Each package is imported on the first call and only when its part is on. Rejects with `Install <package>` when one
 * is missing, and with AbortError when `signal` aborts or the stage is disposed first. A failure leaves the stage as it
 * was: every part goes, the camera is untouched, and the error reaches the caller. Needs WebGPU.
 * @example const viewer = await addViewer(stage, '/shoe.glb', { environment: '/studio.hdr' });
 */
export async function addViewer(
  stage: Stage,
  url: string | URL,
  {
    environment,
    lighting,
    background = '#dfe1e4',
    shadows = 'contact',
    shadow,
    tonemap = {},
    turntable = true,
    fit = true,
    gltf,
    signal,
  }: ViewerOptions = {},
): Promise<Viewer> {
  if (shadows !== 'contact' && shadows !== 'cascaded' && shadows !== false)
    throw typeError('shadows: contact, cascaded or false', 'arguments');
  if (typeof fit !== 'boolean')
    throw typeError('Invalid fit: expected a boolean; use true to fit the camera or false to keep its view', 'arguments');
  const { seconds = 30, resumeAfter = 3 } = typeof turntable === 'object' ? turntable : {};
  if (!Number.isFinite(seconds) || !seconds || !Number.isFinite(resumeAfter) || !(resumeAfter >= 0))
    throw rangeError('Turntable: finite seconds not 0, finite resumeAfter 0 or more', 'arguments');
  const abort = stageSignal(stage, signal),
    { engine, canvas } = stage;
  abort.throwIfAborted();
  // Later steps undo first: a failure, a late abort and `dispose()` all run this list, every step whatever one throws.
  const undo: (() => void)[] = [],
    release = (): unknown[] => {
      const errors: unknown[] = [];
      // The stage's disposal already took every plugin with the engine.
      if (!stage.signal.aborted)
        for (const step of undo.splice(0).reverse())
          try {
            step();
          } catch (error) {
            errors.push(error);
          }
      return errors;
    },
    dispose = (): void => {
      const errors = release();
      for (const error of errors.slice(1)) engine.onError(error);
      if (errors.length) throw errors[0];
    };
  const loading = await Promise.allSettled([
    optionalPackage('@margoengine/gltf-pro', () => import('@margoengine/gltf-pro'), abort).then(({ loadGLTF }) =>
      loadGLTF(engine, url, { ...gltf, signal: abort }),
    ),
    environment === false
      ? null
      : optionalPackage('@margoengine/environment', () => import('@margoengine/environment'), abort).then(
          ({ EnvironmentLighting }) =>
            EnvironmentLighting.load(engine, environment ?? studio(), { ...lighting, signal: abort }),
        ),
    // Every import here, so nothing after the load waits: no frame draws the model unframed, and a missing package
    // fails before anything is set up.
    background === false
      ? null
      : optionalPackage('@margoengine/environment', () => import('@margoengine/environment'), abort),
    shadows === 'contact' ? optionalPackage('@margoengine/staging', () => import('@margoengine/staging'), abort) : null,
    shadows === 'cascaded' ? optionalPackage('@margoengine/shadows', () => import('@margoengine/shadows'), abort) : null,
    tonemap ? optionalPackage('@margoengine/tonemap', () => import('@margoengine/tonemap'), abort) : null,
  ]);
  const [modelLoad, lightLoad, backdropLoad, contactLoad, castLoad, gradeLoad] = loading,
    loaded = <T>(load: PromiseSettledResult<T>): T => (load as PromiseFulfilledResult<T>).value;
  if (modelLoad.status === 'fulfilled') undo.push(() => modelLoad.value.dispose());
  if (lightLoad.status === 'fulfilled' && lightLoad.value) undo.push(() => lightLoad.value!.dispose());
  try {
    for (const load of loading) if (load.status === 'rejected') throw load.reason;
    abort.throwIfAborted();
    const model = loaded(modelLoad),
      light = loaded(lightLoad);
    light?.add(model);
    const bounds = model.bounds,
      size = Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]),
      center: [number, number, number] = [
        (bounds[0] + bounds[3]) / 2,
        (bounds[1] + bounds[4]) / 2,
        (bounds[2] + bounds[5]) / 2,
      ];
    if (!(size > 0 && size < Infinity)) throw fault('state', 'Viewer model has no geometry to frame');
    let backdrop: ColorBackground | null = null;
    if (background !== false) {
      // Before the shadow, which blends over what is drawn here.
      const plain = loaded(backdropLoad)!.ColorBackground.attach(engine, { color: background, order: 0.25 });
      undo.push(() => plain.dispose());
      backdrop = plain;
    }
    let shadow3: ContactShadows | Shadows | null = null,
      floor: Mesh | null = null;
    if (shadows === 'contact') {
      // Sized here rather than with `fit`, which would overwrite the caller's `size` and `position`.
      const foot = Math.max(bounds[3] - bounds[0], bounds[5] - bounds[2], size * 0.1),
        contact = loaded(contactLoad)!.ContactShadows.attach(engine, {
          position: [center[0], bounds[1], center[2]],
          size: foot * 3,
          height: Math.max(bounds[4] - bounds[1], size * 0.1),
          blur: foot * 0.2,
          opacity: 1,
          static: true,
          ...(shadow as ContactShadowOptions),
        });
      undo.push(() => contact.dispose());
      contact.add(model);
      shadow3 = contact;
    } else if (shadows === 'cascaded') {
      const reach = size * 2,
        ground = bounds[1];
      const cast = loaded(castLoad)!.Shadows.attach(engine, {
        bounds: {
          min: [center[0] - reach, ground - size * 0.01, center[2] - reach],
          max: [center[0] + reach, bounds[4], center[2] + reach],
        },
        normalBias: size * 0.002,
        ...(shadow as ShadowOptions),
      });
      undo.push(() => cast.dispose());
      // Wide enough that its edge sits near the horizon; core's sun and the image-based light both reach it.
      const thickness = size * 0.01,
        plane = stage.box({
          size: [size * 40, thickness, size * 40],
          position: [center[0], ground - thickness / 2, center[2]],
          color: '#808080',
          roughness: 0.9,
        });
      undo.push(() => plane.dispose());
      cast.add(model, { static: true });
      cast.add(plane, { static: true, castShadow: false });
      floor = plane;
      shadow3 = cast;
    }
    let grade: Tonemap | null = null;
    if (tonemap) {
      grade = loaded(gradeLoad)!.Tonemap.attach(engine, tonemap);
      undo.push(() => grade!.dispose());
    }
    abort.throwIfAborted();
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let spinning = !!turntable && !still,
      held = false,
      wait = 0;
    const press = (): void => {
        held = true;
      },
      lift = (): void => {
        held = false;
        wait = resumeAfter;
      },
      wheel = (): void => {
        wait = resumeAfter;
      };
    const events = new AbortController(),
      listening = { signal: AbortSignal.any([events.signal, stage.signal]) };
    canvas.addEventListener('pointerdown', press, listening);
    canvas.addEventListener('pointerup', lift, listening);
    canvas.addEventListener('pointercancel', lift, listening);
    canvas.addEventListener('wheel', wheel, { ...listening, passive: true });
    undo.push(() => events.abort());
    undo.push(
      stage.onTick((delta) => {
        if (!spinning || held) return;
        if (wait > 0) wait -= delta;
        // Reduce elapsed time before dividing: even finite subnormal periods must not overflow the angle.
        else orbit(stage, ((delta % seconds) / seconds) * (Math.PI * 2));
      }),
    );
    // Last, because nothing can undo it: it ends any fit in flight, and `dispose` leaves the camera to the visitor.
    // fitToBoundingBox throws before it changes anything of its own, so these four fields are all there is to restore.
    if (fit) {
      const { camera } = engine,
        { near, far, target, position } = camera,
        aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight),
        // Sine of the half angle the fit frames in: it stands back size * 0.55 over this, so a long lens needs more far.
        lens = Math.sin(Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, aspect)));
      try {
        camera.near = size / 200;
        camera.far = size * Math.max(50, 1 + 1 / lens);
        camera.target = center;
        camera.position = [center[0] + size * 0.55, center[1] + size * 0.3, center[2] + size];
        camera.fitToBoundingBox([bounds[0], bounds[1], bounds[2]], [bounds[3], bounds[4], bounds[5]], {
          aspect,
          duration: 0,
        });
      } catch (error) {
        Object.assign(camera, { near, far, target, position });
        throw error;
      }
    }
    return {
      model,
      environment: light,
      background: backdrop,
      shadows: shadow3,
      floor,
      tonemap: grade,
      get turntable() {
        return spinning;
      },
      set turntable(value: boolean) {
        spinning = value;
      },
      dispose,
      [Symbol.dispose ?? Symbol()]: dispose,
    } as Viewer;
  } catch (error) {
    // The caller hears of the failure; a part that also fails to clean up goes to `engine.onError`, not over it.
    for (const cleanup of release()) engine.onError(cleanup);
    throw error;
  }
}
