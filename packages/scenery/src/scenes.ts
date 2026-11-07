// Scene presets: a day preset's sky and light with the fog and the post effects that suit it, attached in one call.
// The sky is `Sky` from @margoengine/sky with the day preset's options and sky fog; the post is a `PostStack` of
// `Bloom` and `Tonemap`, whose depth the fog reads. Every value lives on the parts' own options, so a scene can be
// fine-tuned after it is attached, and `set` switches all of it at once.
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { Bloom } from '@margoengine/post/bloom';
import { PostStack } from '@margoengine/post/stack';
import { Sky } from '@margoengine/sky';
import { Tonemap } from '@margoengine/tonemap';
import { DAY_PRESETS, applyDayPreset, dayPreset, dayPresetNames, type DayPreset } from './presets.js';

/** The scene preset names, the day preset names: `noon`, `goldenHour`, `overcast` and `dawn`. */
export const scenePresetNames = dayPresetNames;
/** One of {@link scenePresetNames}. */
export type ScenePresetName = (typeof scenePresetNames)[number];

/** What a scene preset holds: a day preset, fog, bloom and a display grade. */
export interface ScenePreset {
  /** Sky, sun and sky light (`@margoengine/scenery/presets`). */
  readonly day: DayPreset;
  /** Sky fog over the scene depth, exponential (`1 - exp(-density x distance)`): density per metre, 0 for none. */
  readonly fog: number;
  /** Bloom strength (0 to 4) and the HDR level it starts from. */
  readonly bloom: { readonly strength: number; readonly threshold: number };
  /** Display grade (`Tonemap` options): exposure in stops, contrast, white balance in Kelvin and vignette. */
  readonly tonemap: {
    readonly exposure: number;
    readonly contrast: number;
    readonly temperature: number;
    readonly vignette: number;
  };
}

// Margo design values. Fog density from the visibility it gives (Koschmieder 1924: an object fades to 2% contrast at
// 3.912 / density metres): noon's clear air about 20 km, golden hour's haze 10 km, overcast 2 km, dawn's mist 600 m.
// Exposure brings each scene's lit ground back near noon's on screen: the presets light it 0.2 to 0.7 times as much
// (2.3 stops less overcast). Golden hour is warmed a little more and dawn cooled a little (white balance), and both
// get a soft vignette and more bloom around the low sun.
const scene = (p: ScenePreset): ScenePreset =>
  Object.freeze({ ...p, bloom: Object.freeze({ ...p.bloom }), tonemap: Object.freeze({ ...p.tonemap }) });
/** The four scene presets. Frozen; copy one with `{...SCENE_PRESETS.noon, fog: 0.001}` to make another. */
export const SCENE_PRESETS: Readonly<Record<ScenePresetName, ScenePreset>> = Object.freeze({
  noon: scene({
    day: DAY_PRESETS.noon,
    fog: 3.912 / 20000,
    bloom: { strength: 0.03, threshold: 1.5 },
    tonemap: { exposure: 0, contrast: 1, temperature: 6500, vignette: 0 },
  }),
  goldenHour: scene({
    day: DAY_PRESETS.goldenHour,
    fog: 3.912 / 10000,
    bloom: { strength: 0.08, threshold: 1 },
    tonemap: { exposure: 1.5, contrast: 1.05, temperature: 7200, vignette: 0.15 },
  }),
  overcast: scene({
    day: DAY_PRESETS.overcast,
    fog: 3.912 / 2000,
    bloom: { strength: 0.02, threshold: 1.5 },
    tonemap: { exposure: 2.3, contrast: 0.95, temperature: 6500, vignette: 0 },
  }),
  dawn: scene({
    day: DAY_PRESETS.dawn,
    fog: 3.912 / 600,
    bloom: { strength: 0.06, threshold: 1 },
    tonemap: { exposure: 2.5, contrast: 1, temperature: 6000, vignette: 0.15 },
  }),
});

/** A preset name or a {@link ScenePreset}. */
export type ScenePresetInput = ScenePresetName | ScenePreset;

const resolve = (input: ScenePresetInput): ScenePreset => {
  if (typeof input === 'string') {
    if (!Object.hasOwn(SCENE_PRESETS, input))
      throw new RangeError(`Unknown scene preset "${input}"; use one of ${scenePresetNames.join(', ')}.`);
    return SCENE_PRESETS[input];
  }
  const p = input,
    ok = (v: unknown, low: number, high: number) => typeof v === 'number' && v >= low && v <= high;
  if (
    typeof p !== 'object' ||
    p === null ||
    typeof p.day !== 'object' ||
    !ok(p.fog, 0, 1) ||
    !ok(p.bloom?.strength, 0, 4) ||
    !ok(p.bloom?.threshold, 0, 1e6) ||
    !ok(p.tonemap?.exposure, -16, 16) ||
    !ok(p.tonemap?.contrast, 0, 4) ||
    !ok(p.tonemap?.temperature, 1667, 25000) ||
    !ok(p.tonemap?.vignette, 0, 1)
  )
    throw new RangeError(
      'Invalid scene preset; give a day preset, fog 0..1, bloom strength 0..4 and threshold >= 0, and tonemap exposure -16..16, contrast 0..4, temperature 1667..25000 and vignette 0..1.',
    );
  return p;
};

/**
 * A whole look in one call: sky, sun and sky light, fog, bloom and a display grade. `PresetScene.attach(engine, name)`
 * adds a `Sky` (`sky`), and a `PostStack` (`post`) of `Bloom` (`bloom`) and `Tonemap` (`tonemap`); the sky's fog reads
 * the stack's depth. Change the parts' `options` to fine-tune, `set` to switch the whole scene, `dispose` (or `using`)
 * to remove all of it. WebGPU only, as the post stack.
 * @example
 * const scene = PresetScene.attach(engine, 'goldenHour');
 * scene.set('overcast');
 */
export class PresetScene implements Disposable {
  readonly sky: Sky;
  readonly bloom: Bloom;
  readonly tonemap: Tonemap;
  readonly post: PostStack;
  private disposed = false;

  /** Attaches the scene's sky and post stack to `engine`. @throws RangeError for an unknown name or invalid preset. */
  static attach(engine: EngineKernel, input: ScenePresetInput): PresetScene {
    return new PresetScene(engine, resolve(input));
  }

  private constructor(engine: EngineKernel, preset: ScenePreset) {
    this.bloom = new Bloom({ strength: preset.bloom.strength, threshold: preset.bloom.threshold });
    this.tonemap = new Tonemap({ ...preset.tonemap });
    this.post = PostStack.attach(engine, [this.bloom, this.tonemap]);
    this.sky = Sky.attach(engine, { ...dayPreset(preset.day), fog: this.fog(preset.fog) });
  }

  private fog(density: number) {
    return { depth: () => this.post.depthTexture, density, start: 0, falloff: 'exp' as const };
  }

  /**
   * Switches the whole scene to a preset: the sky, light and fog (other sky options kept), bloom and grade.
   * Nothing is re-created.
   * @throws RangeError for an unknown name or invalid preset; MargoError `'disposed'` after `dispose()`.
   */
  set(input: ScenePresetInput): this {
    if (this.disposed) throw new MargoError('disposed', 'This PresetScene was disposed; attach a new one.');
    const p = resolve(input);
    applyDayPreset(this.sky, p.day);
    this.sky.options.fog = this.fog(p.fog);
    Object.assign(this.bloom.options, p.bloom);
    Object.assign(this.tonemap.options, p.tonemap);
    return this;
  }

  /** Removes the sky and the post stack from the engine. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sky.dispose();
    this.post.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
