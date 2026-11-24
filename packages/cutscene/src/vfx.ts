// @margoengine/cutscene/vfx: particle effects and object visibility on the timeline. Tracks stay pure, as every track
// does: `state` says which effects run and which objects show at a time. GPU particles are the one thing here with a
// past, so the director turns that state into starts, stops and bursts, and a seek runs the simulation again from when
// the effect was last empty: the same steps give the same particles, so a scrub lands on what playing there shows.
import type { Cutscene, CutsceneState, CutsceneTrackType, TrackInstant } from './cutscene.js';
import type { ClipBase, TrackCheck } from './document.js';

/** A burst of particles inside a clip. */
export interface VfxBurst {
  /** Seconds from the start of the clip. */
  time: number;
  /** Particles to add, a whole number from 1. */
  count: number;
}

/** A span of an effect running. */
export interface VfxClip extends ClipBase {
  /** Births per second while it runs (default the rate of the effect when the director took it over). */
  rate?: number;
  /** Bursts, sorted by time. */
  bursts?: VfxBurst[];
}

/** An effect on the timeline. */
export interface VfxTrack {
  type: 'vfx';
  id: string;
  /** The effect's name in the director. */
  target: string;
  clips: VfxClip[];
  muted?: boolean;
}

/** Spans an object shows. */
export interface ActivationTrack {
  type: 'activation';
  id: string;
  /** The object's name. */
  target: string;
  clips: ClipBase[];
  /** Hide the object during the spans instead of showing it (default false). */
  invert?: boolean;
  muted?: boolean;
}

/** An effect's state at a time. */
export interface VfxState {
  /** True inside a clip. */
  running: boolean;
  /** Which clip of the track, or the last one before this time; -1 before the first. */
  clip: number;
  /** Seconds into that clip, when running. */
  time: number;
  /** Births per second the clip asks for; absent keeps the effect's own. */
  rate?: number;
}

/** What the name of a burst instant ends in, after the effect's name. */
const BURST = ':burst';

function validateVfx(track: Record<string, unknown>, check: TrackCheck): void {
  const { add } = check;
  check.target();
  check.clips((clip, p) => {
    check.positive(clip, 'rate', p);
    if (!('bursts' in clip)) return;
    const bursts = check.list(clip.bursts, `${p}.bursts`);
    bursts?.forEach((burst, i) => {
      const at = `${p}.bursts[${i}]`;
      if (!(typeof burst.time === 'number' && burst.time >= 0 && burst.time <= (clip.duration as number)))
        add(`${at}.time`, 'must be seconds inside the clip');
      if (!Number.isInteger(burst.count) || (burst.count as number) < 1)
        add(`${at}.count`, 'must be a whole number from 1');
    });
    if (bursts) check.ordered(bursts, `${p}.bursts`, 'time');
  });
}

function validateActivation(track: Record<string, unknown>, check: TrackCheck): void {
  check.target();
  if ('invert' in track && typeof track.invert !== 'boolean') check.add(`${check.path}.invert`, 'must be true or false');
  check.clips(() => {});
}

const enterExit = (raw: Record<string, unknown>): TrackInstant[] => {
  const { clips, target } = raw as unknown as { clips: ClipBase[]; target: string };
  return clips.flatMap((clip) => [
    { time: clip.start, kind: 'enter' as const, name: target, clip },
    { time: clip.start + clip.duration, kind: 'exit' as const, name: target, clip },
  ]);
};

/** The `vfx` track type: pass it in the `tracks` option. Read a state with {@link effectsOf}. */
export function vfxTrack(): CutsceneTrackType {
  return {
    type: 'vfx',
    validate: validateVfx,
    instants(raw): TrackInstant[] {
      const { clips, target } = raw as unknown as VfxTrack,
        bursts = clips.flatMap((clip) =>
          (clip.bursts ?? []).map((burst) => ({
            time: clip.start + burst.time,
            kind: 'event' as const,
            name: target + BURST,
            data: { count: burst.count },
          })),
        );
      return [...enterExit(raw), ...bursts];
    },
    evaluate(raw, t, state): void {
      const { clips, target } = raw as unknown as VfxTrack,
        effects = ((state.extras ??= {}).vfx ??= {}) as Record<string, VfxState>;
      let index = -1;
      while (index + 1 < clips.length && clips[index + 1].start <= t) index++;
      const clip = clips[index],
        running = !!clip && t < clip.start + clip.duration;
      // A running effect wins over a stopped one, so two tracks can share an effect.
      if (effects[target]?.running) return;
      effects[target] = running
        ? { running, clip: index, time: t - clip.start, ...(clip.rate === undefined ? {} : { rate: clip.rate }) }
        : { running, clip: index, time: 0 };
    },
  };
}

/** The `activation` track type: pass it in the `tracks` option. Read a state with {@link activeOf}. */
export function activationTrack(): CutsceneTrackType {
  return {
    type: 'activation',
    validate: validateActivation,
    instants: enterExit,
    evaluate(raw, t, state): void {
      const { clips, target, invert } = raw as unknown as ActivationTrack,
        active = ((state.extras ??= {}).active ??= {}) as Record<string, boolean>,
        inside = clips.some((clip) => t >= clip.start && t < clip.start + clip.duration);
      active[target] = inside !== (invert === true);
    },
  };
}

/** What each effect does at this state's time, by effect name. */
export function effectsOf(state: CutsceneState): Record<string, VfxState> {
  return (state.extras?.vfx as Record<string, VfxState> | undefined) ?? {};
}

/** Whether each object shows at this state's time, by object name. */
export function activeOf(state: CutsceneState): Record<string, boolean> {
  return (state.extras?.active as Record<string, boolean> | undefined) ?? {};
}

/** Sets `visible` on the objects a state names; a `Mesh` fits. Objects you do not pass are left alone. */
export function applyActivation(state: CutsceneState, objects: Readonly<Record<string, { visible: boolean }>>): void {
  for (const [name, visible] of Object.entries(activeOf(state)))
    if (Object.hasOwn(objects, name)) objects[name].visible = visible;
}

/** What the director drives; `VFX` of `@margoengine/vfx` fits. */
export interface DirectedEffect {
  options: { rate?: number; lifetime?: readonly [number, number] };
  burst(count: number): unknown;
  reset(): unknown;
}

/** Options of {@link VfxDirector}. */
export interface VfxDirectorOptions {
  /** Draws one step of the given seconds, for the replay of a seek: `(delta) => engine.render({ delta })`. Required. */
  step: (delta: number) => unknown;
  /** Seconds of one replay step. Match your frame time, as the same steps give the same particles (default 1/60). */
  stepSize?: number;
  /** Longest replay, seconds. A seek replays at most this much before its time (default 10). */
  longest?: number;
}

/** Frames an update may leap and still count as playing, for a game that drops a few. */
const FORWARD_STEPS = 8;
/** The longest life of a particle of an effect that sets none: the default of `@margoengine/vfx`. */
const DEFAULT_LONGEST_LIFE = 3;
/**
 * Seconds every time is read ahead by. Playing adds frame times up and a replay counts them back from its end, so two
 * reads of one frame differ by rounding; this keeps a clip or burst sitting exactly on a frame on the same side in both.
 */
const EDGE = 1e-6;

/** The longest a particle of this effect lives, seconds: past that, nothing it made is left. */
const life = (effect: DirectedEffect): number => effect.options.lifetime?.[1] ?? DEFAULT_LONGEST_LIFE;

interface Directed {
  effect: DirectedEffect;
  /** The rate the effect had: the default of a clip with none. */
  rate: number | undefined;
  running: boolean;
  /** When a clip last ran it. */
  on: number;
}

/**
 * Applies a cutscene's particle state to live effects, once per frame, before you draw. Playing forward starts and
 * stops them and fires bursts as their times pass. Anything else, a seek, a step backward or a leap, wipes the effects
 * and runs the same frames again from the moment they last had nothing alive, so a scrub lands on what playing there
 * shows, leftovers of earlier clips included. An effect starts fresh whenever a clip finds it empty, so its random
 * numbers depend on the cutscene alone.
 *
 * ```ts
 * const director = new VfxDirector(cutscene, { sparks }, { step: (delta) => engine.render({ delta }) });
 * director.apply(player.state); // each frame, before engine.render({ delta })
 * ```
 */
export class VfxDirector {
  private readonly effects: Map<string, Directed>;
  private readonly step: (delta: number) => unknown;
  private readonly stepSize: number;
  private readonly longest: number;
  /** The time last applied; below 0 before the first. */
  private clock = -1;
  constructor(
    private readonly cutscene: Cutscene,
    effects: Readonly<Record<string, DirectedEffect>>,
    options: VfxDirectorOptions,
  ) {
    const { step, stepSize = 1 / 60, longest = 10 } = options ?? {};
    if (typeof cutscene?.evaluate !== 'function') throw new TypeError('VfxDirector needs the Cutscene as its first argument');
    if (typeof step !== 'function') throw new TypeError('VfxDirector needs step(delta), which draws one frame');
    if (!(stepSize > 0) || !Number.isFinite(stepSize)) throw new RangeError('VfxDirector stepSize must be above 0');
    if (!(longest >= 0) || !Number.isFinite(longest)) throw new RangeError('VfxDirector longest must be 0 or more');
    this.step = step;
    this.stepSize = stepSize;
    this.longest = longest;
    this.effects = new Map(
      Object.entries(effects).map(([name, effect]) => {
        const rate = effect.options.rate;
        effect.options.rate = 0;
        return [name, { effect, rate, running: false, on: Number.NEGATIVE_INFINITY }];
      }),
    );
  }
  /** Makes the effects match a state of this cutscene. Call once per frame, before drawing. */
  apply(state: CutsceneState): void {
    const { time } = state,
      leap = time - Math.max(0, this.clock);
    if (leap >= 0 && leap <= this.stepSize * FORWARD_STEPS) this.forward(time);
    else this.seek(time);
  }
  /** One frame of playing: what every frame does, live or in a replay. */
  private forward(time: number): void {
    const wanted = effectsOf(this.cutscene.evaluate(time + EDGE));
    for (const [name, entry] of this.effects) {
      const target = wanted[name],
        { effect } = entry;
      if (target?.running) {
        if (!entry.running && time - entry.on > life(effect)) effect.reset();
        effect.options.rate = target.rate ?? entry.rate;
        entry.running = true;
        entry.on = time;
      } else {
        effect.options.rate = 0;
        entry.running = false;
      }
    }
    for (const instant of this.cutscene.eventsBetween(this.clock + EDGE, time + EDGE))
      if (instant.type === 'vfx' && instant.kind === 'event')
        this.effects.get(instant.name.slice(0, -BURST.length))?.effect.burst((instant.data as VfxBurst).count);
    this.clock = time;
  }
  /** The earliest time something alive at `time` began, within `longest`; `time` when nothing is alive. */
  private cause(time: number): number {
    const seen = new Map<string, number>(),
      steps = Math.floor(Math.min(time, this.longest) / this.stepSize + EDGE);
    let earliest = time;
    for (let k = 0; k <= steps; k++) {
      const t = time - k * this.stepSize,
        wanted = effectsOf(this.cutscene.evaluate(t + EDGE));
      for (const [name, { effect }] of this.effects) {
        const last = seen.get(name) ?? time;
        if (!wanted[name]?.running || last - t > life(effect)) continue;
        seen.set(name, t);
        earliest = Math.min(earliest, t);
      }
    }
    return earliest;
  }
  private seek(time: number): void {
    const size = this.stepSize,
      steps = Math.ceil((time - this.cause(time)) / size - EDGE);
    for (const entry of this.effects.values()) {
      entry.effect.reset();
      entry.effect.options.rate = 0;
      entry.running = false;
      entry.on = Number.NEGATIVE_INFINITY;
    }
    this.clock = time - (steps + 1) * size;
    for (let k = steps; k > 0; k--) {
      this.forward(Math.max(0, time - k * size));
      this.step(size);
    }
    this.forward(time);
  }
}
