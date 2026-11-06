import type { Binding, InputFeed } from './index.js';

/**
 * A recording, safe to `JSON.stringify` into a file. Only changes are stored, so a held key costs nothing per tick.
 * Written by {@link InputRecorder.clip}; {@link InputReplay} checks all of it, so a clip may come from anywhere.
 */
export interface InputClip {
  version: 1;
  /** What each channel holds: action name and binding index. */
  channels: [action: string, binding: number][];
  /** Milliseconds since the first tick, one number per tick. */
  times: number[];
  /** Flat triples of tick, channel and new value, in tick order. */
  events: number[];
}

/** What {@link InputRecorder} reads: an `Input`, or anything with the same two members. */
export interface RecordSource {
  readonly actions: Readonly<Record<string, readonly Binding[]>>;
  bindingValue(action: string, binding: number): number;
}

/** What {@link InputReplay} plays into: an `Input`, or anything with the same two members. */
export interface ReplayTarget {
  readonly actions: Readonly<Record<string, readonly Binding[]>>;
  setFeed(feed: InputFeed | null): void;
}

/** Options for {@link InputReplay}. */
export interface ReplayOptions {
  /** Start again at the end, for an attract mode. `finished` then waits for `stop`. Default false. */
  loop?: boolean;
  /** Stops the replay; `finished` rejects with the reason. */
  signal?: AbortSignal;
}

/**
 * Records what every binding of an `Input` gave, tick by tick.
 *
 * ```ts
 * const recorder = new InputRecorder(input);
 * input.update();
 * recorder.capture(); // once per tick, after input.update()
 * localStorage.setItem('demo', JSON.stringify(recorder.clip()));
 * ```
 */
export class InputRecorder {
  private readonly source: RecordSource;
  private readonly now: () => number;
  private readonly channels: [string, number][] = [];
  private readonly ids = new Map<string, number[]>();
  private readonly last: number[] = [];
  private readonly times: number[] = [];
  private readonly events: number[] = [];
  private start = 0;
  /** @param options.now Clock in milliseconds. Default `performance.now`. */
  constructor(input: RecordSource, { now = () => performance.now() }: { now?: () => number } = {}) {
    if (typeof input?.bindingValue !== 'function' || !input.actions)
      throw new TypeError('InputRecorder reads an Input; pass one as the first argument');
    this.source = input;
    this.now = now;
  }
  /** Ticks captured so far. */
  get frames(): number {
    return this.times.length;
  }
  /** Note this tick. Call once per tick, after `input.update()`. */
  capture(): void {
    const tick = this.times.length,
      now = this.now();
    if (!tick) this.start = now;
    this.times.push(now - this.start);
    const actions = this.source.actions;
    for (const action of Object.keys(actions)) {
      const ids = this.ids.get(action) ?? [],
        count = actions[action].length;
      this.ids.set(action, ids);
      for (let i = 0; i < count; i++) {
        const id = (ids[i] ??= this.channels.push([action, i]) - 1),
          value = this.source.bindingValue(action, i);
        if (value === (this.last[id] ?? 0)) continue;
        this.last[id] = value;
        this.events.push(tick, id, value);
      }
    }
  }
  /** Copy of what was recorded so far. Recording can go on. */
  clip(): InputClip {
    return {
      version: 1,
      channels: this.channels.map(([action, binding]) => [action, binding]),
      times: [...this.times],
      events: [...this.events],
    };
  }
}

function invalid(detail: string): TypeError {
  return new TypeError(`Invalid input clip: ${detail}; use what InputRecorder.clip() wrote`);
}

function parse(clip: InputClip | string): InputClip {
  let data: InputClip;
  try {
    data = typeof clip === 'string' ? (JSON.parse(clip) as InputClip) : clip;
  } catch {
    throw invalid('not JSON');
  }
  if (!data || data.version !== 1) throw invalid('unknown version');
  const { channels, times, events } = data;
  if (!Array.isArray(channels) || !Array.isArray(times) || !Array.isArray(events) || events.length % 3)
    throw invalid('missing lists');
  for (const channel of channels)
    if (
      !Array.isArray(channel) ||
      typeof channel[0] !== 'string' ||
      !Number.isInteger(channel[1]) ||
      channel[1] < 0
    )
      throw invalid('bad channel');
  for (let i = 0; i < times.length; i++)
    if (!Number.isFinite(times[i]) || (i > 0 && times[i] < times[i - 1])) throw invalid('times out of order');
  for (let i = 0, tick = 0; i < events.length; i += 3) {
    const at = events[i],
      id = events[i + 1];
    if (!Number.isInteger(at) || at < tick || at >= times.length) throw invalid('tick out of order');
    if (!Number.isInteger(id) || id < 0 || id >= channels.length) throw invalid('unknown channel');
    if (!Number.isFinite(events[i + 2])) throw invalid('value not finite');
    tick = at;
  }
  return data;
}

/**
 * Plays a clip into an `Input`: each `input.update()` takes one recorded tick in place of the devices, and everything
 * reading that Input (the game, `Interactions`) runs as it did live. At the end the Input goes back to its devices.
 *
 * ```ts
 * const replay = new InputReplay(input, localStorage.getItem('demo')!);
 * await replay.finished;
 * ```
 */
export class InputReplay implements InputFeed {
  /** Resolves when the clip has played or {@link InputReplay.stop} was called; rejects when `signal` aborts. */
  readonly finished: Promise<void>;
  private readonly input: ReplayTarget;
  private readonly clip: InputClip;
  private readonly loop: boolean;
  private readonly signal: AbortSignal | undefined;
  private readonly table = new Map<string, number[]>();
  private readonly values: Float64Array;
  private tick = -1;
  private cursor = 0;
  private offset = 0;
  private done = false;
  private resolve!: () => void;
  private reject!: (reason: unknown) => void;
  private readonly abort = () => this.finish(this.signal!.reason ?? new DOMException('Aborted', 'AbortError'));
  /**
   * @param clip What {@link InputRecorder.clip} gave, or its JSON text.
   * @throws TypeError for a clip that fails its checks, or one with an action this Input does not have.
   */
  constructor(input: ReplayTarget, clip: InputClip | string, { loop = false, signal }: ReplayOptions = {}) {
    if (typeof input?.setFeed !== 'function' || !input.actions)
      throw new TypeError('InputReplay plays into an Input; pass one as the first argument');
    this.input = input;
    this.clip = parse(clip);
    this.loop = loop;
    this.signal = signal;
    this.values = new Float64Array(this.clip.channels.length);
    this.clip.channels.forEach(([action, binding], id) => {
      if (!Object.hasOwn(input.actions, action))
        throw new TypeError(`Input clip has an action this Input lacks, ${action}; add it to the actions`);
      (this.table.get(action) ?? this.table.set(action, []).get(action)!)[binding] = id;
    });
    this.finished = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.finished.catch(() => {});
    if (signal?.aborted) {
      this.abort();
      return;
    }
    signal?.addEventListener('abort', this.abort, { once: true });
    input.setFeed(this);
  }
  /** The tick playing, from 0, or -1 before the first update. */
  get frame(): number {
    return this.tick;
  }
  /** Ticks in the clip. */
  get frames(): number {
    return this.clip.times.length;
  }
  /**
   * Recorded time of this tick in milliseconds, growing across loops. Give it to whatever reads a clock, so timing
   * rules replay exactly: `new Interactions(input, rules, { now: () => replay.time })`.
   */
  get time(): number {
    return this.offset + (this.clip.times[Math.max(this.tick, 0)] ?? 0);
  }
  /** Stop now and hand the Input back to its devices. `finished` resolves. Idempotent. */
  stop(): void {
    this.finish();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.stop();
  }
  /** @internal Called by `Input.update`. */
  begin(): void {
    const { times, events } = this.clip;
    if (this.tick + 1 >= times.length) {
      if (!this.loop || !times.length) return this.finish();
      const end = times[times.length - 1];
      this.offset += end + (times.length > 1 ? end - times[times.length - 2] : 0);
      this.tick = -1;
      this.cursor = 0;
      this.values.fill(0);
    }
    this.tick++;
    while (this.cursor < events.length && events[this.cursor] === this.tick) {
      this.values[events[this.cursor + 1]] = events[this.cursor + 2];
      this.cursor += 3;
    }
  }
  /** @internal Called by `Input.update`. */
  read(action: string, binding: number): number {
    const id = this.table.get(action)?.[binding];
    return id === undefined ? 0 : this.values[id];
  }
  private finish(reason?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.signal?.removeEventListener('abort', this.abort);
    this.input.setFeed(null);
    if (reason === undefined) this.resolve();
    else this.reject(reason);
  }
}
