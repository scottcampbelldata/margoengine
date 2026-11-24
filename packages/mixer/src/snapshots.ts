import { rampParam, type Mixer, type RampOptions } from './mixer.js';
import { dbToGain, gainToDb } from './dsp.js';
import { bounded } from './worklet-host.js';

/** Numeric settings of an existing effect; topology and impulse buffers stay with the mixer. */
export interface SnapshotEffect {
  /** Effect kind, matching its current position in the bus chain. */
  readonly kind: string;
  /** Named AudioParam values, for example filter frequency and reverb wet/dry gains. */
  readonly params: Readonly<Record<string, number>>;
}

/** Saved settings of a bus. Routing, sends and live detector envelopes stay with the mixer. */
export interface SnapshotBus {
  /** Existing bus name, including master. */
  readonly name: string;
  /** Fader dB, or null for silence. Null keeps JSON round trips lossless. */
  readonly gain: number | null;
  /** Saved mute state. */
  readonly muted: boolean;
  /** Saved solo state. */
  readonly solo: boolean;
  /** Current numeric effect values, in chain order. */
  readonly effects: readonly SnapshotEffect[];
}

/** Serializable mixer target state, independent of the AudioContext. */
export interface MixerSnapshot {
  /** Schema version, currently 1. */
  readonly version: 1;
  /** Bus settings, with unique names. A manually edited snapshot may contain a subset. */
  readonly buses: readonly SnapshotBus[];
}

function validate(snapshot: MixerSnapshot): void {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.buses))
    throw new TypeError('Mixer snapshot needs version 1 and a buses array; use captureSnapshot(mixer)');
  const names = new Set<string>();
  for (const bus of snapshot.buses) {
    if (!bus || typeof bus.name !== 'string' || !bus.name || names.has(bus.name) ||
      (bus.gain !== null && (typeof bus.gain !== 'number' || !Number.isFinite(bus.gain) || !Number.isFinite(Math.fround(dbToGain(bus.gain))))) ||
      typeof bus.muted !== 'boolean' || typeof bus.solo !== 'boolean')
      throw new TypeError('Mixer snapshot bus needs a unique name, finite gain (or null), muted and solo booleans; recapture the snapshot');
    names.add(bus.name);
    if (!Array.isArray(bus.effects)) throw new TypeError('Snapshot effects needs an array; recapture the snapshot');
    for (const effect of bus.effects) {
      if (!effect || typeof effect.kind !== 'string' || !effect.params || typeof effect.params !== 'object' ||
        Array.isArray(effect.params) || Object.values(effect.params).some((value) => typeof value !== 'number' || !Number.isFinite(value)))
        throw new TypeError('Snapshot effect needs kind and finite numeric params; recapture the snapshot');
    }
  }
}

/** Copy the mixer's target fader, mute and solo settings. Changes to the mixer do not mutate the snapshot. */
export function captureSnapshot(mixer: Mixer): MixerSnapshot {
  const snapshot: MixerSnapshot = {
    version: 1,
    buses: mixer.buses().map((bus) => ({
      name: bus.name, gain: bus.gain === -Infinity ? null : bus.gain, muted: bus.muted, solo: bus.solo,
      effects: bus.effects.map((effect) => ({ kind: effect.kind,
        params: Object.fromEntries(Object.entries(effect.params).map(([name, param]) => [name, param.value])),
      })),
    })),
  };
  validate(snapshot);
  return snapshot;
}

/** Recall a saved target state, fading on the AudioContext clock. Default seconds 0.25 (about 98% settled). */
export function recallSnapshot(mixer: Mixer, snapshot: MixerSnapshot, options: RampOptions = {}): void {
  validate(snapshot);
  const seconds = bounded(options.seconds ?? 0.25, 0, 3600, 'Snapshot seconds');
  const at = bounded(options.at ?? mixer.now, mixer.now, Number.MAX_VALUE, 'Snapshot time');
  // Resolve and validate the entire snapshot before scheduling anything.
  const buses = snapshot.buses.map((state) => ({ state, bus: mixer.bus(state.name) }));
  const params: { param: AudioParam; value: number }[] = [];
  for (const { state, bus } of buses) {
    if (state.effects.length !== bus.effects.length)
      throw new TypeError('Snapshot effect chain changed; restore the original chain or recapture the snapshot');
    state.effects.forEach((saved, index) => {
      const live = bus.effects[index];
      if (saved.kind !== live.kind || Object.keys(saved.params).length !== Object.keys(live.params).length)
        throw new TypeError('Snapshot effect kind or params changed; restore the chain or recapture the snapshot');
      for (const [name, value] of Object.entries(saved.params)) {
        if (!Object.hasOwn(live.params, name))
          throw new TypeError('Snapshot effect parameter is unknown; recapture the snapshot');
        const ranges: Record<string, [number, number]> = {
          frequency: [10, mixer.context.sampleRate / 2], q: [-40, 1000], gain: [-40, 40],
          wet: [0, 1], dry: [0, 1], feedback: [0, 0.95], threshold: [-100, 0], knee: [0, 40],
          ratio: [1, 20], attack: [0, 1], release: [live.kind === 'limiter' ? 0.001 : 0, 1],
        };
        const range = ranges[name.replace(/\d+$/, '')];
        if (!range) throw new TypeError('Snapshot parameter is unsupported; recapture a mixer built-in effect');
        bounded(value, range[0], range[1], `Snapshot ${name}`);
        params.push({ param: live.params[name], value });
      }
    });
  }
  for (const { state, bus } of buses) {
    bus.setGain(state.gain ?? -Infinity, { at, seconds });
    bus.setMuted(state.muted, { at, seconds });
    bus.setSolo(state.solo, { at, seconds });
  }
  for (const { param, value } of params) rampParam(mixer.context, param, value, { at, seconds });
}

/** Interpolate two snapshots in linear amplitude, with mute/solo choosing the nearer endpoint; t is 0..1. */
export function blendSnapshots(a: MixerSnapshot, b: MixerSnapshot, t: number): MixerSnapshot {
  validate(a); validate(b);
  bounded(t, 0, 1, 'Snapshot blend');
  const byName = new Map(b.buses.map((bus) => [bus.name, bus]));
  if (a.buses.length !== b.buses.length || a.buses.some((bus) => !byName.has(bus.name)))
    throw new TypeError('Snapshot blend needs the same bus names; capture both states from the same mixer layout');
  return { version: 1, buses: a.buses.map((from) => {
    const to = byName.get(from.name)!;
    if (from.effects.length !== to.effects.length)
      throw new TypeError('Snapshot blend needs matching effect chains; recapture both states from one layout');
    const effects = from.effects.map((effect, i) => {
      const other = to.effects[i];
      if (effect.kind !== other.kind || Object.keys(effect.params).length !== Object.keys(other.params).length ||
        Object.keys(effect.params).some((name) => !Object.hasOwn(other.params, name)))
        throw new TypeError('Snapshot blend needs matching effect parameters; recapture both states from one layout');
      return { kind: effect.kind, params: Object.fromEntries(Object.entries(effect.params).map(([name, value]) =>
        [name, t === 0 ? value : t === 1 ? other.params[name] : value * (1 - t) + other.params[name] * t])) };
    });
    const gain = t === 0 ? from.gain : t === 1 ? to.gain : gainToDb(
      dbToGain(from.gain ?? -Infinity) * (1 - t) + dbToGain(to.gain ?? -Infinity) * t,
    );
    return { ...(t < 0.5 ? from : to), effects, gain: gain === -Infinity ? null : gain };
  }) };
}
