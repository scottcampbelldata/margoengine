import { capFrameRate, currentTier, LOWERED_KEY, type Paced } from './index.js';
import { timeFrames, type FrameTimers } from './resolution.js';

/** Options of {@link FrameDrift}. */
export interface FrameDriftOptions {
  /** Frames per reading; the reading is their median. Default 300, about five seconds at 60 FPS. */
  window?: number;
  /** Cost over the coolest reading, as a ratio, that counts as hot. Above 1. Default 1.25. */
  rise?: number;
  /** Readings in a row over `rise` before it is called heat. Default 6, about half a minute. */
  readings?: number;
  /** A change between two readings above this share is a new scene, not heat, and starts over. Default 0.15. */
  jump?: number;
  /** Readings `hot` holds at least once set, however the cost moves: easing off lowers the cost, which says nothing
   * about the temperature. Default 60, about five minutes. */
  hold?: number;
}

/**
 * Tells heat from a heavier scene by the shape of the frame cost. A GPU that throttles gets slower gradually, so the
 * cost creeps up with no large step between readings and stays up; a new view, level or setting moves it in one step,
 * which starts the measure over. Once hot it stays hot for `hold` readings, or until the cost creeps back down. The
 * first reading is skipped (startup). Free of timers; feed it one frame cost per
 * frame with {@link FrameDrift.push}.
 */
export class FrameDrift {
  /** True while the frame cost has drifted up and stayed there. */
  hot = false;
  private readonly samples: Float64Array;
  private readonly rise: number;
  private readonly readings: number;
  private readonly jump: number;
  private count = 0;
  private seen = 0;
  private coolest = Infinity;
  private last = 0;
  private over = 0;
  private held = 0;
  private eased = false;
  private readonly hold: number;
  /** @throws RangeError when `window` is below 8, `rise` is not above 1, `readings` or `hold` is below 1 or `jump` is not above 0. */
  constructor({ window = 300, rise = 1.25, readings = 6, jump = 0.15, hold = 60 }: FrameDriftOptions = {}) {
    if (
      !Number.isInteger(window) ||
      window < 8 ||
      !(rise > 1 && rise < Infinity) ||
      !Number.isInteger(readings) ||
      readings < 1 ||
      !Number.isInteger(hold) ||
      hold < 1 ||
      !(jump > 0 && jump < Infinity)
    )
      throw new RangeError(
        'Invalid drift options; use an integer window >= 8, rise above 1, integer readings and hold >= 1 and jump above 0',
      );
    this.samples = new Float64Array(window);
    this.rise = rise;
    this.readings = readings;
    this.jump = jump;
    this.hold = hold;
  }
  /** Forget the measure, after a change you know of (a new level, a different quality). */
  restart(): void {
    this.count = this.seen = this.over = 0;
    this.eased = false;
    this.coolest = Infinity;
    this.hot = false;
  }
  /** Record one frame's cost in milliseconds; returns `hot` when this sample changed it. Other samples return undefined. */
  push(ms: number): boolean | undefined {
    if (!Number.isFinite(ms) || ms < 0) return undefined;
    this.samples[this.count++] = ms;
    if (this.count < this.samples.length) return undefined;
    this.count = 0;
    const was = this.hot,
      median = this.samples.sort()[this.samples.length >> 1],
      reading = this.seen++;
    if (!reading) return undefined;
    if (this.hot && ++this.held >= this.hold) {
      this.hot = false;
      this.settle(median);
      return false;
    }
    if (reading > 1 && Math.abs(median - this.last) > this.last * this.jump) {
      this.settle(median);
      return undefined;
    }
    this.last = median;
    if (median < this.coolest) this.coolest = median;
    if (median > this.coolest * this.rise) {
      if (++this.over >= this.readings && !this.hot) {
        this.hot = true;
        this.held = 0;
      }
    } else if (median < this.coolest * (1 + (this.rise - 1) / 2)) {
      this.over = 0;
      // After a step down while hot this reading is the eased-off cost: the hold decides, not how it compares.
      if (!this.eased) this.hot = false;
    }
    return this.hot === was ? undefined : this.hot;
  }
  private settle(median: number): void {
    this.over = 0;
    this.coolest = this.last = median;
    this.eased = this.hot;
  }
}

/** The part of the Battery Status API {@link watchPower} reads. */
export interface BatteryLike {
  charging: boolean;
  level: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The part of the Compute Pressure API {@link watchPower} reads. */
export interface PressureLike {
  observe(source: 'cpu'): Promise<void>;
  disconnect(): void;
}

/** What {@link watchPower} knows now. */
export interface PowerReading {
  /** 0 mains or unknown, 1 on battery, 2 strained: hot, under pressure or low on battery. */
  level: 0 | 1 | 2;
  /** False on battery. Undefined where the browser does not say. */
  charging?: boolean;
  /** Battery charge, 0 to 1. Undefined where the browser does not say. */
  battery?: number;
  /** Compute Pressure state: 'nominal', 'fair', 'serious' or 'critical'. Undefined where the browser does not say. */
  pressure?: string;
  /** Frame times have drifted up and stayed there. */
  hot: boolean;
}

/** Options of {@link watchPower}; browser sources default to the browser's own, so tests can inject them. */
export interface PowerOptions extends FrameDriftOptions, FrameTimers {
  /** Capped to `rates` while on battery or strained, and given its own pace back after. */
  engine?: Paced;
  /** Frames per second at levels 1 and 2. Default [60, 30]. */
  rates?: readonly [number, number];
  /** A {@link FeatureScaler}, or anything with a `budget`: it is multiplied by `budgets` at levels 1 and 2. */
  features?: { budget: number };
  /** Share of the budget at levels 1 and 2. Default [0.75, 0.5]. */
  budgets?: readonly [number, number];
  /** Charge at or under which a discharging battery counts as strained. Default 0.2. */
  lowBattery?: number;
  /** Told every change of the reading. */
  onChange?: (reading: PowerReading) => void;
  /** Runs once on the full tier when the level leaves 0, after this tab's next load has been set to the light tier.
   * Default none, so the page is never reloaded unasked; pass `() => location.reload()` to change tier at once. */
  reload?: () => void;
  /** Where this tab's lowered tier is kept. Default sessionStorage. */
  session?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  /** Default `navigator.getBattery`. Null for none. */
  battery?: (() => Promise<BatteryLike>) | null;
  /** Makes the pressure observer; the callback gets its records. Default the browser's `PressureObserver`. Null for none. */
  pressure?: ((callback: (records: readonly { state: string }[]) => void) => PressureLike) | null;
}

/** Stops {@link watchPower}. */
export interface PowerWatch {
  /** The reading now. */
  readonly reading: Readonly<PowerReading>;
  /** Forget the frame time measure, after a change you know of. */
  restart(): void;
  /** Stop, and give the engine its pace and the features their budget back. Also runs on `using` disposal. */
  dispose(): void;
  [Symbol.dispose](): void;
}

declare const PressureObserver:
  | (new (callback: (records: readonly { state: string }[]) => void) => PressureLike)
  | undefined;
const session = () => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

/**
 * Eases off on battery and when the machine runs hot. Reads the battery where the browser gives it, CPU pressure where
 * the browser gives it, and frame times everywhere (see {@link FrameDrift}). Level 1 (on battery) and level 2 (strained)
 * cap the frame rate and cut the feature budget; on the full tier, whose 4x multisampling cannot change while running,
 * this tab's next load starts on the light tier until the machine is back on mains.
 * @throws RangeError for invalid options.
 */
export function watchPower({
  engine,
  rates = [60, 30],
  features,
  budgets = [0.75, 0.5],
  lowBattery = 0.2,
  onChange,
  reload,
  session: store = session(),
  battery = (globalThis.navigator as { getBattery?: () => Promise<BatteryLike> } | undefined)?.getBattery?.bind(
    globalThis.navigator,
  ),
  pressure = typeof PressureObserver === 'undefined' ? undefined : (callback) => new PressureObserver(callback),
  request,
  queue,
  now,
  ...drift
}: PowerOptions = {}): PowerWatch {
  if (!rates.every((rate) => rate > 0) || !budgets.every((share) => share > 0 && share <= 1))
    throw new RangeError('Invalid power options; use rates above 0 and budgets in (0, 1]');
  if (!(lowBattery >= 0 && lowBattery <= 1)) throw new RangeError('Invalid power options; use lowBattery in 0..1');
  const frames = new FrameDrift(drift),
    budget = features?.budget,
    pace = (engine as { pace?: (time: number) => boolean } | undefined)?.pace,
    reading: PowerReading = { level: 0, hot: false };
  let source: BatteryLike | undefined,
    observer: PressureLike | undefined,
    stopped = false,
    asked = false;
  const judge = () => {
      const { charging, battery: charge, pressure: state } = reading,
        low = charging === false && charge !== undefined && charge <= lowBattery,
        strained = reading.hot || low || state === 'serious' || state === 'critical',
        level = strained ? 2 : charging === false ? 1 : 0;
      if (level !== reading.level) apply(level);
    },
    apply = (level: 0 | 1 | 2) => {
      reading.level = level;
      if (engine) {
        if (level) capFrameRate(engine, rates[level - 1]);
        else (engine as { pace?: (time: number) => boolean }).pace = pace;
      }
      if (features) features.budget = level ? budget! * budgets[level - 1] : budget!;
      if (!level) store?.removeItem(LOWERED_KEY);
      else if (currentTier() === 'high') {
        store?.setItem(LOWERED_KEY, '1');
        if (!asked) {
          asked = true;
          reload?.();
        }
      }
    },
    report = () => {
      if (stopped) return;
      judge();
      onChange?.({ ...reading });
    },
    readBattery = () => {
      // One plug or unplug fires both events.
      if (reading.charging === source!.charging && reading.battery === source!.level) return;
      reading.charging = source!.charging;
      reading.battery = source!.level;
      report();
    },
    stopFrames = timeFrames({ request, queue, now }, (ms) => {
      const hot = frames.push(ms);
      if (hot === undefined || stopped) return;
      reading.hot = hot;
      report();
    });
  void battery?.().then(
    (manager) => {
      if (stopped) return;
      source = manager;
      manager.addEventListener('chargingchange', readBattery);
      manager.addEventListener('levelchange', readBattery);
      readBattery();
    },
    // Refused by the browser or a permissions policy: this source says nothing, and the others still work.
    () => {},
  );
  if (pressure) {
    observer = pressure((records) => {
      const state = records.at(-1)?.state;
      if (state === reading.pressure) return;
      reading.pressure = state;
      report();
    });
    void observer.observe('cpu').catch(() => {});
  }
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    stopFrames();
    source?.removeEventListener('chargingchange', readBattery);
    source?.removeEventListener('levelchange', readBattery);
    observer?.disconnect();
    if (reading.level) {
      if (engine) (engine as { pace?: (time: number) => boolean }).pace = pace;
      if (features) features.budget = budget!;
    }
  };
  return {
    reading,
    restart: () => {
      frames.restart();
      reading.hot = false;
      report();
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
