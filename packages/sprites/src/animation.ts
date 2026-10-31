// Sprite-sheet animation: pure CPU code with no GPU or DOM, so it runs in Node and under test with plain numbers.
import { rangeError, typeError } from '../../shared/errors.js';

/** An atlas rectangle in whole texels: `[x, y, width, height]`. */
export type SpriteRect = readonly [number, number, number, number];

/** One image of a clip and how long it shows. */
export interface SpriteFrame {
  rect: SpriteRect;
  /** Seconds on screen. Default `1 / fps` of the clip. */
  duration?: number;
}

/** A named run of frames. */
export interface SpriteClip {
  frames: readonly (SpriteFrame | SpriteRect)[];
  /** `'loop'` wraps, `'once'` stops on the last frame, `'pingpong'` runs forward then back. Default `'loop'`. */
  mode?: 'loop' | 'once' | 'pingpong';
  /** Frames per second for frames without a `duration`. Default 12. */
  fps?: number;
  /** Names fired once each time the frame at `frame` (index into `frames`) starts showing. */
  events?: readonly { frame: number; name: string }[];
}

/** Settings of a {@link SpriteAnimation}. */
export interface SpriteAnimationOptions {
  clips: Readonly<Record<string, SpriteClip>>;
  /** Playback speed multiplier, 0 or more. Default 1. */
  speed?: number;
  /** Called with the event name and the clip name, in frame order, from `play` and `update`. */
  onEvent?: (name: string, clip: string) => void;
}

const bad = () => typeError('Invalid sprite animation', 'sprite-options');
const badRange = () => rangeError('Invalid sprite animation', 'sprite-options');

/** Rectangles for a regular sheet, row by row from the top-left: `frameGrid(16, 16, 4)` is four 16 x 16 frames. */
export function frameGrid(
  frameWidth: number,
  frameHeight: number,
  columns: number,
  count = columns,
  x = 0,
  y = 0,
): SpriteRect[] {
  for (const n of [frameWidth, frameHeight, columns, count]) if (!Number.isInteger(n) || n < 1) throw badRange();
  return Array.from({ length: count }, (_, i) => [
    x + (i % columns) * frameWidth,
    y + Math.floor(i / columns) * frameHeight,
    frameWidth,
    frameHeight,
  ]);
}

interface Compiled {
  rects: SpriteRect[];
  /** Frame index shown in each slot of one cycle, and the time each slot ends at (cumulative seconds). */
  order: number[];
  ends: number[];
  mode: 'loop' | 'once' | 'pingpong';
  events: Map<number, string[]>;
}

function compile(clip: SpriteClip): Compiled {
  const { frames, mode = 'loop', fps = 12, events = [] } = clip ?? ({} as SpriteClip);
  if (
    !Array.isArray(frames) ||
    frames.length === 0 ||
    !['loop', 'once', 'pingpong'].includes(mode) ||
    !(fps > 0) ||
    !Number.isFinite(fps)
  )
    throw bad();
  const times: number[] = [],
    rects: SpriteRect[] = [];
  for (const entry of frames) {
    const { rect, duration = 1 / fps } = Array.isArray(entry)
      ? { rect: entry as unknown as SpriteRect }
      : (entry as SpriteFrame);
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isInteger)) throw bad();
    if (!(duration > 0) || !Number.isFinite(duration)) throw badRange();
    rects.push(rect);
    times.push(duration);
  }
  const order = frames.map((_, i) => i);
  if (mode === 'pingpong') for (let i = frames.length - 2; i > 0; i--) order.push(i);
  let total = 0;
  const ends = order.map((i) => (total += times[i]!)),
    byFrame = new Map<number, string[]>();
  for (const { frame, name } of events) {
    if (!Number.isInteger(frame) || frame < 0 || frame >= frames.length || typeof name !== 'string') throw badRange();
    byFrame.set(frame, [...(byFrame.get(frame) ?? []), name]);
  }
  return { rects, order, ends, mode, events: byFrame };
}

const checkSpeed = (speed: number): number => {
  if (!(speed >= 0) || !Number.isFinite(speed)) throw badRange();
  return speed;
};

/**
 * Plays named clips of a sprite sheet. Call `update(dt)` once per frame with the seconds elapsed, then `apply(sprite)` (or
 * read `rect`). The result depends only on the clips and the sequence of `dt`s, so it is deterministic and testable
 * without a GPU.
 */
export class SpriteAnimation {
  /** Playback speed multiplier, 0 or more. */
  speed: number;
  /** Name of the clip playing, or `undefined` before `play`. */
  clip: string | undefined;
  /** Seconds played in the current clip, after speed. */
  time = 0;
  /** True once a `'once'` clip has reached the end of its last frame. */
  finished = false;
  readonly #clips = new Map<string, Compiled>();
  readonly #onEvent: ((name: string, clip: string) => void) | undefined;
  #current: Compiled | undefined;
  #slot = 0;

  constructor(options: SpriteAnimationOptions) {
    const { clips, speed = 1, onEvent } = options ?? ({} as SpriteAnimationOptions);
    if (typeof clips !== 'object' || clips === null || (onEvent !== undefined && typeof onEvent !== 'function'))
      throw bad();
    this.speed = checkSpeed(speed);
    this.#onEvent = onEvent;
    for (const [name, clip] of Object.entries(clips)) this.#clips.set(name, compile(clip));
  }

  /** Index into the clip's `frames` that is showing. */
  get frame(): number {
    const c = this.#current;
    return c ? c.order[this.#slot % c.order.length]! : 0;
  }

  /** Atlas rectangle of the frame that is showing, or `undefined` before `play`. */
  get rect(): SpriteRect | undefined {
    return this.#current?.rects[this.frame];
  }

  /**
   * Starts a clip from its first frame and fires that frame's events. Playing the clip already playing does nothing
   * unless it has finished or `restart` is true.
   * @throws RangeError for a clip name that was not given.
   */
  play(name: string, restart = false): this {
    const clip = this.#clips.get(name);
    if (!clip) throw rangeError('Unknown sprite clip', 'sprite-options');
    if (this.clip === name && !restart && !this.finished) return this;
    this.clip = name;
    this.#current = clip;
    this.time = 0;
    this.#slot = 0;
    this.finished = false;
    this.#fire(clip, 0);
    return this;
  }

  /**
   * Advances by `dt` seconds (times `speed`) and fires the events of every frame entered, in order.
   * @throws RangeError for a `dt` that is negative or not finite.
   */
  update(dt: number): this {
    const c = this.#current;
    if (!Number.isFinite(dt) || dt < 0) throw badRange();
    if (!c || this.finished) return this;
    this.time += dt * checkSpeed(this.speed);
    const length = c.order.length,
      period = c.ends[length - 1]!;
    let target: number;
    if (c.mode === 'once' && this.time >= period) {
      target = length - 1;
      this.finished = true;
    } else {
      const cycles = Math.floor(this.time / period),
        within = this.time - cycles * period,
        slot = c.ends.findIndex((end) => within < end);
      target = cycles * length + (slot < 0 ? length - 1 : slot);
    }
    for (let s = this.#slot + 1; s <= target; s++) this.#fire(c, s);
    this.#slot = target;
    return this;
  }

  /** Writes the current rectangle to a sprite (or any `{ rect }`). Does nothing before `play`. */
  apply(sprite: { rect?: SpriteRect | undefined }): void {
    const rect = this.rect;
    if (rect) sprite.rect = rect;
  }

  #fire(c: Compiled, slot: number): void {
    const names = c.events.get(c.order[slot % c.order.length]!);
    if (names && this.#onEvent) for (const name of names) this.#onEvent(name, this.clip!);
  }
}
