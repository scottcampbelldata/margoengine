// Extrapolation: when the next snapshot is late, a remote entity keeps moving on from its last two snapshots for a
// short while instead of freezing, and when the truth arrives the drawn state blends to it instead of jumping (dead
// reckoning, as in Aggarwal et al., NetGames 2004; the blend is the convergence step of the same scheme).
import type { GameClient } from './client.js';

/** Options of {@link Extrapolator}. */
export interface ExtrapolatorOptions {
  /** Ticks past the newest snapshot to keep moving, then it holds there (default 6). */
  maxTicks?: number;
  /** Milliseconds to blend from what was drawn to the truth once a snapshot arrives (default 100; 0 jumps). */
  blend?: number;
  /** The clock in milliseconds (default `performance.now`). */
  now?: () => number;
}

/**
 * Draws `client.interpolated()`, carried on past the newest snapshot when the next one is late. Every field the schema
 * interpolates moves on in a line (`'angle'` the short way) at the speed of the last two snapshots; the others keep
 * their newest value.
 *
 * @example
 * ```ts
 * const view = new Extrapolator(client, { maxTicks: 6 });
 * engine.onFrame(() => {
 *   client.update();
 *   for (const [id, box] of view.state().boxes) if (id !== client.player) drawOther(box);
 * });
 * ```
 */
export class Extrapolator<State, Input = unknown> {
  private readonly maxTicks: number;
  private readonly blend: number;
  private readonly now: () => number;
  private shown: State | undefined;
  private from: State | undefined;
  private since = 0;
  /** The newest snapshot's tick while running past it. */
  private base = Number.NaN;
  private behind = 0;

  /** @throws RangeError for an option out of range; TypeError when `client` is not a GameClient. */
  constructor(
    private readonly client: GameClient<State, Input>,
    options: ExtrapolatorOptions = {},
  ) {
    if (!client?.game) throw new TypeError('Extrapolator needs a GameClient; pass what GameClient.join gave you');
    this.maxTicks = options.maxTicks ?? 6;
    this.blend = options.blend ?? 100;
    this.now = options.now ?? (() => performance.now());
    if (!(this.maxTicks >= 0)) throw new RangeError(`Extrapolator maxTicks is ${this.maxTicks}; pass 0 or more`);
    if (!(this.blend >= 0)) throw new RangeError(`Extrapolator blend is ${this.blend}; pass ms of 0 or more`);
  }

  /** Ticks the newest {@link Extrapolator.state} was past the newest snapshot, 0 when the snapshots kept up. */
  get late(): number {
    return this.behind;
  }

  /** What to draw now, in place of `client.interpolated()`. Call it once per frame. Do not write to the result. */
  state(): State {
    const client = this.client,
      { schema, stateType } = client.game,
      now = this.now(),
      view = client.interpolated(),
      newest = client.serverTick,
      late = client.viewTick - newest,
      past = client.previousSnapshot,
      running = late > 0 && past !== undefined;
    let out = view;
    if (running) {
      const t = 1 + Math.min(late, this.maxTicks) / (newest - past.tick);
      out = schema.interpolate(stateType, past.state, client.authoritative, t) as State;
    }
    // Truth arrived: the base of what is drawn has moved, so blend from what was on screen.
    if (!Number.isNaN(this.base) && !(running && this.base === newest) && this.blend > 0) {
      this.from = this.shown;
      this.since = now;
    }
    this.base = running ? newest : Number.NaN;
    this.behind = running ? late : 0;
    if (this.from !== undefined) {
      const u = (now - this.since) / this.blend;
      if (u >= 1) this.from = undefined;
      else out = schema.interpolate(stateType, this.from, out, Math.max(0, u)) as State;
    }
    this.shown = out;
    return out;
  }
}
