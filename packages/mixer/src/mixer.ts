/// <reference lib="esnext.disposable" preserve="true" />
// Buses and the mixer: a tree of buses (child feeds parent, the root is `master`), each with effects, a fader, ducking,
// a mute/solo gate and sends. Everything is scheduled on AudioContext time, so the same calls drive a live
// AudioContext and an OfflineAudioContext.
import { MargoError } from '@margoengine/math/errors';
import { dbToGain } from './dsp.js';
import { createEffect, type Effect, type EffectSpec } from './effects.js';
import { Emitter, type EmitterOptions } from './spatial.js';

/** When and how fast a parameter moves. */
export interface RampOptions {
  /** AudioContext time of the change in seconds. Default now. */
  at?: number;
  /** Seconds to settle (about 98 percent of the way). 0 jumps. Default 0.02, which avoids clicks. */
  seconds?: number;
}

/** Settings of one bus. */
export interface BusOptions {
  /** Name of the bus this one feeds. Default `'master'`. */
  parent?: string;
  /** Fader in dB. Default 0. */
  gain?: number;
  /** Start muted. Default false. */
  muted?: boolean;
  /** Start soloed. Default false. */
  solo?: boolean;
  /** Stay audible while other buses are soloed, like a reverb return. Default false. */
  soloSafe?: boolean;
  /** Insert effects, in order, between the bus input and its fader. */
  effects?: readonly EffectSpec[];
}

/** Options of {@link Bus.send}. */
export interface SendOptions {
  /** Send level in dB. Default 0. */
  gain?: number;
  /** Tap before the fader and the mute gate (default false: after them, so muting the bus mutes the send). */
  pre?: boolean;
}

/** Options of {@link Bus.duck}. */
export interface DuckOptions {
  /** How far to lower the bus, dB, 0 or more. Default 12. */
  amount?: number;
  /** Seconds to get there. Default 0.05. */
  attack?: number;
  /** AudioContext time to start. Default now. */
  at?: number;
}

/** A running duck; call {@link Duck.release} to bring the bus back. */
export interface Duck {
  /** Ends this duck at `at` (default now) over `seconds` (default 0.4). Other active ducks keep the bus lowered. */
  release(options?: RampOptions): void;
  /** True until released. */
  readonly active: boolean;
}

/** A send from one bus to another. */
export interface Send {
  /** Changes the level in dB. */
  setGain(db: number, options?: RampOptions): void;
  /** Disconnects the send. */
  remove(): void;
}

/** One bus in the {@link audibleBuses} tree. */
export interface BusState {
  name: string;
  parent: string | null;
  muted: boolean;
  solo: boolean;
  soloSafe: boolean;
}

/**
 * Which buses let sound through. A muted bus is silent. While any bus is soloed, a bus is audible only if it is
 * soloed, is solo-safe, or sits on the path of a soloed bus (an ancestor, which carries the sound on, or a
 * descendant, which feeds it). A cycle or an unknown parent throws a TypeError.
 */
export function audibleBuses(buses: readonly BusState[]): Map<string, boolean> {
  const byName = new Map(buses.map((bus) => [bus.name, bus]));
  const ancestors = (name: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let at = byName.get(name)?.parent ?? null; at !== null; at = byName.get(at)?.parent ?? null) {
      if (!byName.has(at)) throw new TypeError(`Bus "${name}" has the unknown parent "${at}"; create the parent first`);
      if (seen.has(at) || at === name)
        throw new TypeError(`Bus "${name}" is part of a parent cycle; give it a parent above it`);
      seen.add(at);
      chain.push(at);
    }
    return chain;
  };
  const soloed = buses.filter((bus) => bus.solo).map((bus) => bus.name);
  const onPath = new Set<string>(soloed);
  for (const name of soloed) for (const above of ancestors(name)) onPath.add(above);
  for (const bus of buses) if (ancestors(bus.name).some((above) => soloed.includes(above))) onPath.add(bus.name);
  const result = new Map<string, boolean>();
  for (const bus of buses) {
    ancestors(bus.name);
    result.set(bus.name, !bus.muted && (soloed.length === 0 || bus.soloSafe || onPath.has(bus.name)));
  }
  return result;
}

/** Moves a parameter to `value`: immediately while the context has not started (or when `seconds` is 0), else smoothly. */
export function rampParam(
  context: BaseAudioContext,
  param: AudioParam,
  value: number,
  { at, seconds = 0.02 }: RampOptions = {},
): void {
  if (!Number.isFinite(value)) throw new RangeError(`Parameter value must be a finite number, got ${value}`);
  if (seconds < 0 || !Number.isFinite(seconds)) throw new RangeError(`seconds must be 0 or more, got ${seconds}`);
  const time = at ?? context.currentTime;
  param.cancelScheduledValues(time);
  if (seconds === 0 || (time <= context.currentTime && context.state !== 'running')) param.setValueAtTime(value, time);
  else param.setTargetAtTime(value, time, seconds / 4);
}

/** One channel strip. Create it with {@link Mixer.createBus}. */
export class Bus implements Disposable {
  /** Where sound enters (connect sources here). */
  readonly input: GainNode;
  /** Where sound leaves, after effects, fader, ducking and the mute gate. */
  readonly output: GainNode;
  /** The unique name. */
  readonly name: string;
  /** @internal */
  readonly preTap: GainNode;
  /** @internal */
  readonly fader: GainNode;
  /** @internal */
  readonly duckNode: GainNode;
  /** @internal */
  readonly gate: GainNode;
  /** @internal */
  state: BusState;
  private gainDb: number;
  private effectList: Effect[] = [];
  private readonly ducks = new Set<{ depth: number }>();
  private readonly sends = new Set<{ node: GainNode; target: Bus }>();
  private analyser: AnalyserNode | undefined;
  private disposed = false;

  /** @internal Use {@link Mixer.createBus}. */
  constructor(
    private readonly mixer: Mixer,
    name: string,
    parent: string | null,
    options: BusOptions,
  ) {
    const context = mixer.context;
    this.name = name;
    this.input = context.createGain();
    this.preTap = context.createGain();
    this.fader = context.createGain();
    this.duckNode = context.createGain();
    this.gate = context.createGain();
    this.output = context.createGain();
    this.gainDb = options.gain ?? 0;
    this.fader.gain.value = dbToGain(this.gainDb);
    this.state = { name, parent, muted: !!options.muted, solo: !!options.solo, soloSafe: !!options.soloSafe };
    this.preTap.connect(this.fader).connect(this.duckNode).connect(this.gate).connect(this.output);
    this.setEffects(options.effects ?? []);
  }

  /** Fader in dB. */
  get gain(): number {
    return this.gainDb;
  }
  /** True while muted. */
  get muted(): boolean {
    return this.state.muted;
  }
  /** True while soloed. */
  get solo(): boolean {
    return this.state.solo;
  }
  /** The effects now in the chain. */
  get effects(): readonly Effect[] {
    return this.effectList;
  }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', `Bus "${this.name}" is disposed; create a new bus`);
  }

  /** Sets the fader in dB (`-Infinity` for silence). */
  setGain(db: number, options?: RampOptions): this {
    this.alive();
    if (typeof db !== 'number' || Number.isNaN(db))
      throw new TypeError(`Bus gain must be a number of dB, got ${String(db)}`);
    this.gainDb = db;
    rampParam(this.mixer.context, this.fader.gain, dbToGain(db), options);
    return this;
  }

  /** Mutes or unmutes (the gate closes over a few milliseconds). */
  setMuted(muted: boolean, options?: RampOptions): this {
    this.alive();
    this.state.muted = !!muted;
    this.mixer.refreshGates(options);
    return this;
  }

  /** Solos or unsolos; see {@link audibleBuses} for what stays audible. */
  setSolo(solo: boolean, options?: RampOptions): this {
    this.alive();
    this.state.solo = !!solo;
    this.mixer.refreshGates(options);
    return this;
  }

  /** Replaces the effect chain with new effects built from `specs`; the old ones are disposed. */
  setEffects(specs: readonly EffectSpec[]): this {
    this.alive();
    if (!Array.isArray(specs)) throw new TypeError('Bus effects must be an array of effect specs');
    const built: Effect[] = [];
    try {
      for (const spec of specs) built.push(createEffect(this.mixer.context, spec));
    } catch (error) {
      for (const effect of built) effect.dispose();
      throw error;
    }
    this.input.disconnect();
    for (const effect of this.effectList) effect.dispose();
    this.effectList = built;
    let tail: AudioNode = this.input;
    for (const effect of built) {
      tail.connect(effect.input);
      tail = effect.output;
    }
    tail.connect(this.preTap);
    return this;
  }

  /** Sends part of this bus to another bus (an aux or reverb return). */
  send(target: Bus | string, { gain = 0, pre = false }: SendOptions = {}): Send {
    this.alive();
    const to = typeof target === 'string' ? this.mixer.bus(target) : target;
    if (to === this) throw new RangeError(`Bus "${this.name}" cannot send to itself; send to another bus`);
    if (this.mixer.feeds(to, this))
      throw new RangeError(
        `Sending "${this.name}" to "${to.name}" would make a loop; send to a bus that does not feed it`,
      );
    const context = this.mixer.context;
    const node = context.createGain();
    node.gain.value = dbToGain(gain);
    const record = { node, target: to };
    (pre ? this.preTap : this.output).connect(node).connect(to.input);
    this.sends.add(record);
    return {
      setGain: (db, options) => {
        if (typeof db !== 'number' || Number.isNaN(db))
          throw new TypeError(`Send gain must be a number of dB, got ${String(db)}`);
        rampParam(context, node.gain, dbToGain(db), options);
      },
      remove: () => {
        node.disconnect();
        (pre ? this.preTap : this.output).disconnect(node);
        this.sends.delete(record);
      },
    };
  }

  /** @internal Sends to this bus, for cleanup. */
  sendsTo(target: Bus): boolean {
    for (const send of this.sends) if (send.target === target) return true;
    return false;
  }

  /**
   * Lowers the bus by `amount` dB (default 12) over `attack` seconds, starting at AudioContext time `at`. Several
   * ducks can overlap; the deepest one holds until released. Typical use: duck music while a voice line plays.
   */
  duck({ amount = 12, attack = 0.05, at }: DuckOptions = {}): Duck {
    this.alive();
    if (!(amount >= 0) || !Number.isFinite(amount))
      throw new RangeError(`duck amount must be 0 or more dB, got ${amount}`);
    const entry = { depth: amount };
    this.ducks.add(entry);
    this.applyDuck({ at, seconds: attack });
    let active = true;
    return {
      release: (options = {}) => {
        if (!active) return;
        active = false;
        this.ducks.delete(entry);
        if (!this.disposed) this.applyDuck({ seconds: 0.4, ...options });
      },
      get active() {
        return active;
      },
    };
  }

  private applyDuck(options: RampOptions): void {
    let depth = 0;
    for (const d of this.ducks) depth = Math.max(depth, d.depth);
    rampParam(this.mixer.context, this.duckNode.gain, dbToGain(-depth), options);
  }

  /** Peak level 0..1 of the last block of samples at the output (creates an AnalyserNode on first use). */
  peak(): number {
    this.alive();
    if (!this.analyser) {
      this.analyser = this.mixer.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.output.connect(this.analyser);
    }
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  /** @internal */
  teardown(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const effect of this.effectList) effect.dispose();
    for (const send of this.sends) send.node.disconnect();
    for (const node of [this.input, this.preTap, this.fader, this.duckNode, this.gate, this.output]) node.disconnect();
    this.analyser?.disconnect();
    this.sends.clear();
    this.ducks.clear();
  }

  /** Removes the bus from its mixer (it must have no child buses). */
  dispose(): void {
    if (this.disposed) return;
    this.mixer.removeBus(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Settings of a {@link Mixer}. */
export interface MixerOptions {
  /** Where the master bus goes. Default `context.destination`; pass an `AudioListener.input` to mix before it. */
  destination?: AudioNode;
  /** Master fader in dB. Default 0. */
  gain?: number;
  /** Effects on the master bus, for example a limiter. */
  effects?: readonly EffectSpec[];
  /** Buses to create now, in order (a parent must come before its children). */
  buses?: Readonly<Record<string, BusOptions>>;
}

/** Anything that can be routed: a node, or an object with `getOutput()` such as `Audio` from `@margoengine/audio`. */
export type Routable = AudioNode | { getOutput(): AudioNode };

/**
 * A tree of buses on one audio context. The root is `master`.
 * @example
 * using mixer = new Mixer(context, {buses: {music: {gain: -6}, sfx: {}}});
 * mixer.route(musicSource, 'music');
 */
export class Mixer implements Disposable {
  /** The context everything is created on. */
  readonly context: BaseAudioContext;
  /** The root bus. */
  readonly master: Bus;
  private readonly all = new Map<string, Bus>();
  private disposed = false;

  constructor(context: BaseAudioContext, options: MixerOptions = {}) {
    if (!context || typeof context.createGain !== 'function')
      throw new TypeError(
        'Mixer needs an AudioContext or OfflineAudioContext, for example new Mixer(new AudioContext())',
      );
    this.context = context;
    this.master = new Bus(this, 'master', null, { gain: options.gain, effects: options.effects });
    this.all.set('master', this.master);
    this.master.output.connect(options.destination ?? context.destination);
    for (const [name, busOptions] of Object.entries(options.buses ?? {})) this.createBus(name, busOptions);
  }

  /** Current AudioContext time in seconds. */
  get now(): number {
    return this.context.currentTime;
  }

  /** Creates a bus feeding `options.parent` (default master). */
  createBus(name: string, options: BusOptions = {}): Bus {
    this.alive();
    if (typeof name !== 'string' || !name)
      throw new TypeError('Bus name must be a non-empty string, for example "music"');
    if (this.all.has(name))
      throw new MargoError('state', `Bus "${name}" already exists; pick another name or use mixer.bus("${name}")`);
    const parentName = options.parent ?? 'master',
      parent = this.all.get(parentName);
    if (!parent)
      throw new MargoError(
        'state',
        `Bus "${name}" names the parent "${parentName}", which does not exist; create it first`,
      );
    const bus = new Bus(this, name, parentName, options);
    bus.output.connect(parent.input);
    this.all.set(name, bus);
    this.refreshGates({ seconds: 0 });
    return bus;
  }

  /** The bus called `name`; throws MargoError ('state') when there is none. */
  bus(name: string): Bus {
    const bus = this.all.get(name);
    if (!bus) throw new MargoError('state', `No bus called "${name}"; create it with mixer.createBus("${name}")`);
    return bus;
  }
  /** True when a bus called `name` exists. */
  has(name: string): boolean {
    return this.all.has(name);
  }
  /** Every bus, master first. */
  buses(): Bus[] {
    return [...this.all.values()];
  }

  /** True when `from` reaches `to` through parents or sends. */
  feeds(from: Bus, to: Bus, seen = new Set<Bus>()): boolean {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const parent = from.state.parent === null ? undefined : this.all.get(from.state.parent);
    if (parent && this.feeds(parent, to, seen)) return true;
    for (const bus of this.all.values()) if (from.sendsTo(bus) && this.feeds(bus, to, seen)) return true;
    return false;
  }

  /** Removes a bus with no children and disconnects the sends to it. The master bus cannot be removed. */
  removeBus(name: string): void {
    this.alive();
    const bus = this.bus(name);
    if (bus === this.master)
      throw new MargoError('state', 'The master bus cannot be removed; dispose the mixer instead');
    for (const other of this.all.values())
      if (other.state.parent === name)
        throw new MargoError('state', `Bus "${name}" still has the child "${other.name}"; remove the child first`);
    bus.teardown();
    this.all.delete(name);
    this.refreshGates({ seconds: 0 });
  }

  /** Recomputes mute and solo gates from the bus states. */
  refreshGates(options?: RampOptions): void {
    if (this.disposed) return;
    const audible = audibleBuses([...this.all.values()].map((bus) => bus.state));
    for (const bus of this.all.values())
      rampParam(this.context, bus.gate.gain, audible.get(bus.name) ? 1 : 0, { seconds: 0.01, ...options });
  }

  /**
   * Connects a source to a bus, first removing its other connections (an `Audio` from `@margoengine/audio` is
   * wired to its listener until now). Configure filters and panning first. Returns a function that undoes it.
   */
  route(source: Routable, bus: Bus | string): () => void {
    this.alive();
    const target = typeof bus === 'string' ? this.bus(bus) : bus;
    const node =
      'getOutput' in source && typeof source.getOutput === 'function' ? source.getOutput() : (source as AudioNode);
    if (!node || typeof node.connect !== 'function')
      throw new TypeError('route needs an AudioNode or an object with getOutput()');
    node.disconnect();
    node.connect(target.input);
    return () => node.disconnect(target.input);
  }

  /** A positional sound source feeding `bus`; see {@link Emitter}. */
  emitter(bus: Bus | string, options: EmitterOptions = {}): Emitter {
    this.alive();
    const target = typeof bus === 'string' ? this.bus(bus) : bus;
    return new Emitter(this.context, target.input, options);
  }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'Mixer is disposed; create a new Mixer');
  }

  /** Disconnects every bus and effect. The context is left open. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bus of [...this.all.values()].reverse()) bus.teardown();
    this.all.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
