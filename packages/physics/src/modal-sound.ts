import { MargoError } from '@margoengine/math/errors';
import { cos, exp, sin } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { loadModalSoundBuilds, modalSoundBlock, type ModalSoundBuilds } from './modal-sound/kernel.js';
import { modalPreset, type ModalMaterial, type ModalPreset } from './modal-sound/material.js';
import { limited, MAX_LOAD, MODAL_CONTACT_WORDS } from './modal-sound/model.js';
import { regionWords } from './world/memory.js';
import {
  RATE_LEVELS,
  rateOf,
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from './world/solver.js';

export { modalPreset, type ModalMaterial, type ModalMode, type ModalPreset } from './modal-sound/material.js';
export {
  ModalContactRigidSolver,
  type ModalContactRigidOptions,
  type ModalContactRigidSetup,
  type ModalJointSound,
} from './modal-sound/rigid.js';

export { MODAL_CONTACT_WORDS, modalFractureImpulse } from './modal-sound/model.js';

const CHANNELS = 2;
const TEXTURE_PARTIALS = 4;
const BANDS = CHANNELS * TEXTURE_PARTIALS;
const MODE_WORDS = 8;
const SURFACE_WORDS = 2 + BANDS * 2;
const DRIVE_WORDS = 5 + BANDS * 3;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const F32 = Float32Array.BYTES_PER_ELEMENT;
const TAU = 2 * Math.PI;
const LAYOUT = 1;
const MAX_WASM_BYTES = 0xffffffff;
const MAX_SPEED = 1e4;

const CELLS = [0, 0, 0] as const;
const SPATIAL_RATIOS = [0.71, 1.13, 1.87, 2.79] as const;
const WEIGHTS = [0.52, 0.24, 0.15, 0.09] as const;

function descriptor(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({ name, kind: 'scalarSeries', quantity, unit, centring: 'cell' });
}

/** Configure the world clock and optional Wasm load. */
export interface ModalSoundLoadOptions {
  /** Solver and field-name prefix. Default 'modalSound'. */
  readonly id?: string;
  /** Dyadic clock level shared with the contact producer. Default 0 (60 Hz). */
  readonly rate?: RateLevel;
  /** Input field owners the world will include. Defaults to 'contacts'. */
  readonly inputs?: 'contacts' | 'fractures' | 'both' | 'none';
  /** Cancel fetching or compiling the modal kernel. */
  readonly signal?: AbortSignal;
}

/** An acoustic track's material or one of the built-in tonal presets. Default wood. */
export interface ModalSoundTrack {
  readonly material?: ModalMaterial | ModalPreset;
}

/** Select acoustic tracks and output format. */
export interface ModalSoundParams {
  /** Tracks in contact and fracture port order. Default one wood track. */
  readonly tracks?: readonly ModalSoundTrack[];
  /** Audio samples per second, an integer in 8000–96000. Default 48000. */
  readonly sampleRate?: number;
  /** Retain this many seconds of PCM for callers that advance several world steps. Default 0.25, minimum one world step. */
  readonly historySeconds?: number;
}

/** Owning copy of a mono PCM block, sampled on the world clock. */
export interface ModalSoundBlock {
  readonly sampleRate: number;
  readonly firstSample: number;
  readonly samples: Float32Array<ArrayBuffer>;
}

interface Track {
  readonly firstMode: number;
  readonly modes: number;
  readonly scrapeRoughness: number;
  readonly rollRoughness: number;
  readonly scrapeSpacing: number;
  readonly rollSpacing: number;
}

interface Data {
  readonly host: SolverHost;
  readonly run: ReturnType<typeof modalSoundBlock>;
  readonly tracks: readonly Track[];
  readonly sampleRate: number;
  readonly blockCapacity: number;
  readonly ringCapacity: number;
  readonly envelopeStep: number;
  readonly models: Region;
  readonly oscillators: Region;
  readonly surface: Region;
  readonly drive: Region;
  readonly output: Region;
  readonly ring: Region;
  readonly clock: Region;
  readonly history: Region;
}

function f64(host: SolverHost, region: Region): Float64Array {
  return new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / F64);
}

function prepare(tracks: readonly ModalSoundTrack[], sampleRate: number): { tracks: Track[]; models: Float64Array } {
  if (!tracks.length) throw new MargoError('state', 'Add at least one modal sound track.');
  const result: Track[] = [];
  const coefficients: number[] = [];
  for (const track of tracks) {
    const setting = track.material ?? 'wood';
    const material = typeof setting === 'string' ? modalPreset(setting) : setting;
    const count = material.modes.length;
    if (!count) throw new MargoError('state', 'Give every modal sound track at least one resonant mode.');
    result.push({
      firstMode: coefficients.length / MODE_WORDS,
      modes: count,
      scrapeRoughness: limited(material.scrapeRoughness ?? 0.4, 0, 10, 'scrape roughness'),
      rollRoughness: limited(material.rollRoughness ?? 0.2, 0, 10, 'roll roughness'),
      scrapeSpacing: limited(material.scrapeSpacing ?? 0.006, 1e-4, 10, 'scrape spacing in m'),
      rollSpacing: limited(material.rollSpacing ?? 0.024, 1e-4, 10, 'roll spacing in m'),
    });
    for (const mode of material.modes) {
      const omega = TAU * limited(mode.frequency, 20, 0.45 * sampleRate, 'mode frequency in Hz');
      const alpha = limited(mode.decay, 0, 10000, 'mode decay in 1/s');
      const e = exp(-alpha / sampleRate);
      const a = e * cos(omega / sampleRate);
      const b = e * sin(omega / sampleRate);
      const norm = alpha * alpha + omega * omega;
      const gain = limited(mode.gain, -10, 10, 'mode gain');
      coefficients.push(
        a,
        b,
        (omega * (1 - a) - alpha * b) / norm,
        (alpha * (1 - a) + omega * b) / norm,
        gain,
        gain * limited(mode.scrape ?? 1, -10, 10, 'scrape mode multiplier'),
        gain * limited(mode.roll ?? 1, -10, 10, 'roll mode multiplier'),
        gain * limited(mode.fracture ?? 1, -10, 10, 'fracture mode multiplier'),
      );
    }
  }
  return { tracks: result, models: Float64Array.from(coefficients) };
}

function read(data: Data, port: Port | undefined, words: number): Float64Array | undefined {
  if (!port) return undefined;
  if (port.region.type !== 'f64' || port.region.layout !== LAYOUT || port.region.byteLength !== words * F64)
    throw new MargoError(
      'state',
      `Modal sound field "${port.field}" has incompatible rows. Publish layout 1 with ${words} f64 words.`,
    );
  return regionWords(data.host.memory, port.region) as Float64Array;
}

function texture(
  drive: Float64Array,
  channel: number,
  power: number,
  weightedSpeed: number,
  roughness: number,
  spacing: number,
  rate: number,
): void {
  const weighted = limited(weightedSpeed, 0, power * MAX_SPEED, 'power-weighted contact speed in W m/s');
  const speed = power > 0 ? weighted / power : 0;
  drive[2 + channel] = Math.sqrt(power) * roughness;
  for (let i = 0; i < TEXTURE_PARTIALS; i++) {
    const frequency = (speed * SPATIAL_RATIOS[i]!) / (spacing * rate);
    const angle = TAU * Math.min(0.45, frequency);
    const taper = Math.max(0, Math.min(1, (0.45 - frequency) / 0.05));
    const at = 5 + (channel * TEXTURE_PARTIALS + i) * 3;
    drive[at] = cos(angle);
    drive[at + 1] = sin(angle);
    drive[at + 2] = WEIGHTS[i]! * taper;
  }
}

/** Samples contact and fracture force fields as audio-rate decaying modal vibrations. */
export class ModalSoundSolver implements Solver<ModalSoundParams> {
  /** World solver ID and field-name prefix. */
  readonly id: string;
  /** Dyadic level used by the rigid contact producer. */
  readonly rate: RateLevel;
  /** Reads the layout-1 f64 rows described by {@link MODAL_CONTACT_WORDS}. */
  readonly contactField: FieldDescriptor;
  /** Reads one layout-1 f64 equivalent fracture impulse in N s per track. */
  readonly fractureField: FieldDescriptor;
  /** Writes layout-1 f32 PCM with one zero-padded row per track. Consume the valid count in {@link clockField}. */
  readonly pcmField: FieldDescriptor;
  /** Writes layout-1 f64 sample rate, first sample, valid sample count, row capacity and track count. */
  readonly clockField: FieldDescriptor;
  readonly #builds: ModalSoundBuilds;
  readonly #inputs: NonNullable<ModalSoundLoadOptions['inputs']>;
  #data?: Data;

  private constructor(
    id: string,
    rate: RateLevel,
    inputs: NonNullable<ModalSoundLoadOptions['inputs']>,
    builds: ModalSoundBuilds,
  ) {
    this.id = id;
    this.rate = rate;
    this.#builds = builds;
    this.#inputs = inputs;
    this.contactField = descriptor(`${id}.contacts`, 'modalContactLoad', 'N s, W, W m/s, W, W m/s');
    this.fractureField = descriptor(`${id}.fractures`, 'modalFractureImpulse', 'N s');
    this.pcmField = descriptor(`${id}.pcm`, 'modalAudio', 'normalized PCM');
    this.clockField = descriptor(`${id}.clock`, 'modalAudioClock', 'Hz, sample, sample, sample, track');
  }

  /** Prepare plain and, where supported, shared-memory kernels. Add the result to a PhysicsWorld. */
  static async load({
    id = 'modalSound',
    rate = 0,
    inputs = 'contacts',
    signal,
  }: ModalSoundLoadOptions = {}): Promise<ModalSoundSolver> {
    if (!id || !Number.isInteger(rate) || rate < 0 || rate >= RATE_LEVELS)
      throw new MargoError('state', 'Use a nonempty modal sound ID and a rate level from 0 through 7.');
    if (inputs !== 'contacts' && inputs !== 'fractures' && inputs !== 'both' && inputs !== 'none')
      throw new MargoError('state', 'Choose contacts, fractures, both or none for modal sound inputs.');
    return new ModalSoundSolver(id, rate, inputs, await loadModalSoundBuilds(signal));
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        ...(this.#inputs === 'contacts' || this.#inputs === 'both'
          ? [{ field: this.contactField, access: 'read' as const }]
          : []),
        ...(this.#inputs === 'fractures' || this.#inputs === 'both'
          ? [{ field: this.fractureField, access: 'read' as const }]
          : []),
        { field: this.pcmField, access: 'write' },
        { field: this.clockField, access: 'write' },
      ],
      rate: this.rate,
      stableRate: () => this.rate,
    };
  }

  init(host: SolverHost, { sampleRate = 48000, tracks = [{}], historySeconds = 0.25 }: ModalSoundParams = {}): void {
    if (this.#data)
      throw new MargoError('attached', 'Modal sound is already attached. Load a new solver for the next world.');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
      throw new MargoError('state', 'Set modal sound sampleRate to a whole number from 8000 through 96000 Hz.');
    const prepared = prepare(tracks, sampleRate);
    const blockCapacity = Math.ceil(sampleRate / rateOf(this.rate));
    const historyLimit = Math.floor(MAX_WASM_BYTES / (tracks.length * F32)) / sampleRate;
    const history = limited(historySeconds, 1 / rateOf(this.rate), historyLimit, 'history duration in s');
    const ringCapacity = Math.ceil(sampleRate * history);
    const alloc = (name: string, words: number) => host.allocate(name, words * F64, 'f64', LAYOUT);
    const data: Data = {
      host,
      sampleRate,
      blockCapacity,
      ringCapacity,
      envelopeStep: 1 - exp(-1 / (0.003 * sampleRate)),
      tracks: prepared.tracks,
      run: modalSoundBlock(host, this.#builds),
      models: alloc('modal-models', prepared.models.length),
      oscillators: alloc('modal-oscillators', (2 * prepared.models.length) / MODE_WORDS),
      surface: alloc('modal-surfaces', tracks.length * SURFACE_WORDS),
      drive: alloc('modal-drive', tracks.length * DRIVE_WORDS),
      output: host.allocate('modal-pcm', blockCapacity * tracks.length * F32, 'f32', LAYOUT),
      ring: host.allocate('modal-pcm-history', ringCapacity * tracks.length * F32, 'f32', LAYOUT),
      clock: alloc('modal-pcm-clock', 5),
      history: alloc('modal-history', 4),
    };
    f64(host, data.models).set(prepared.models);
    f64(host, data.clock).set([sampleRate, 0, 0, blockCapacity, tracks.length]);
    f64(host, data.history).set([0, -1, -1, 0]);
    this.#data = data;
  }

  step(context: StepContext, dt: number): void {
    const data = this.#live();
    const { host, sampleRate, tracks } = data;
    const contactPort = context.inputs.get(this.contactField.name);
    const fracturePort = context.inputs.get(this.fractureField.name);
    const loads = read(data, contactPort, tracks.length * MODAL_CONTACT_WORDS);
    const fractures = read(data, fracturePort, tracks.length);
    const history = f64(host, data.history);
    const clock = f64(host, data.clock);
    const scratch = f64(host, data.drive);
    const output = regionWords(host.memory, data.output) as Float32Array;
    const frequency = rateOf(context.level);
    const available = history[0]! + sampleRate;
    const samples = Math.floor(available / frequency);
    if (context.level !== this.rate || dt * frequency !== 1)
      throw new MargoError(
        'state',
        'Modal sound is on an incompatible clock. Schedule it at the rate declared during load.',
      );
    const newContact = contactPort !== undefined && contactPort.tick !== history[1];
    const newFracture = fracturePort !== undefined && fracturePort.tick !== history[2];
    for (const [index, track] of tracks.entries()) {
      const j = index * MODAL_CONTACT_WORDS;
      const drive = scratch.subarray(index * DRIVE_WORDS, (index + 1) * DRIVE_WORDS);
      drive[0] = newContact ? limited(loads![j]!, 0, MAX_LOAD, 'impact impulse in N s') : 0;
      drive[1] = newFracture ? limited(fractures![index]!, 0, MAX_LOAD, 'fracture impulse in N s') : 0;
      drive[4] = data.envelopeStep;
      const scrapePower = limited(loads?.[j + 1] ?? 0, 0, MAX_LOAD, 'scrape power in W');
      const rollPower = limited(loads?.[j + 3] ?? 0, 0, MAX_LOAD, 'rolling power in W');
      texture(drive, 0, scrapePower, loads?.[j + 2] ?? 0, track.scrapeRoughness, track.scrapeSpacing, sampleRate);
      texture(drive, 1, rollPower, loads?.[j + 4] ?? 0, track.rollRoughness, track.rollSpacing, sampleRate);
    }
    if (!history[3]) {
      const random = new RandomStream(context.seed, solverNumber(this.id));
      const surface = f64(host, data.surface);
      for (let index = 0; index < tracks.length; index++) {
        for (let b = 0; b < BANDS; b++) {
          const phase = TAU * random.unitF64(0, index, b)[0];
          const offset = index * SURFACE_WORDS + 2 + 2 * b;
          surface[offset] = cos(phase);
          surface[offset + 1] = sin(phase);
        }
      }
    }
    output.fill(0);
    const first = clock[1]! + clock[2]!;
    const ring = regionWords(host.memory, data.ring) as Float32Array;
    const wrap = first % data.ringCapacity;
    const split = Math.min(samples, data.ringCapacity - wrap);
    for (const [index, track] of tracks.entries()) {
      const row = index * data.blockCapacity;
      data.run(
        data.models.byteOffset + track.firstMode * MODE_WORDS * F64,
        data.oscillators.byteOffset + track.firstMode * 2 * F64,
        track.modes,
        data.surface.byteOffset + index * SURFACE_WORDS * F64,
        data.drive.byteOffset + index * DRIVE_WORDS * F64,
        data.output.byteOffset + row * F32,
        samples,
      );
      ring.set(output.subarray(row, row + split), index * data.ringCapacity + wrap);
      if (split < samples) ring.set(output.subarray(row + split, row + samples), index * data.ringCapacity);
    }
    clock[1] = first;
    clock[2] = samples;
    history.set([available - samples * frequency, contactPort?.tick ?? -1, fracturePort?.tick ?? -1, 1]);
  }

  /** Copy one track's latest rendered block. Returns null before its first world step. */
  copyBlock(track = 0): ModalSoundBlock | null {
    const data = this.#live();
    this.#checkTrack(track, data.tracks.length);
    const clock = f64(data.host, data.clock);
    if (!clock[2]) return null;
    const offset = data.output.byteOffset + track * data.blockCapacity * F32;
    return {
      sampleRate: clock[0]!,
      firstSample: clock[1]!,
      samples: new Float32Array(data.host.memory.buffer, offset, clock[2]!).slice(),
    };
  }

  /**
   * Copy every retained sample at or after the cursor. Pass 0 for a fresh world, then advance by the returned length.
   * Returns null when caught up. A cursor outside the retained interval throws and gives the new oldest sample.
   */
  copySince(firstSample: number, track = 0): ModalSoundBlock | null {
    const data = this.#live();
    this.#checkTrack(track, data.tracks.length);
    const clock = f64(data.host, data.clock);
    const end = clock[1]! + clock[2]!;
    const oldest = Math.max(0, end - data.ringCapacity);
    if (!Number.isSafeInteger(firstSample) || firstSample < oldest || firstSample > end)
      throw new MargoError('state', `Audio cursor is outside history. Choose a sample from ${oldest} through ${end}.`);
    if (firstSample === end) return null;
    const samples = new Float32Array(end - firstSample);
    const ring = regionWords(data.host.memory, data.ring) as Float32Array;
    const row = track * data.ringCapacity;
    const wrap = firstSample % data.ringCapacity;
    const split = Math.min(samples.length, data.ringCapacity - wrap);
    samples.set(ring.subarray(row + wrap, row + wrap + split));
    if (split < samples.length) samples.set(ring.subarray(row, row + samples.length - split), split);
    return { sampleRate: clock[0]!, firstSample, samples };
  }

  exportPorts(tick: number): readonly Port[] {
    const data = this.#live();
    return [
      { field: this.pcmField.name, region: data.output, cell: CELLS, tick },
      { field: this.clockField.name, region: data.clock, cell: CELLS, tick },
    ];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    const data = this.#live();
    return [data.oscillators, data.surface, data.output, data.ring, data.clock, data.history];
  }

  extraState(): readonly Region[] {
    return [];
  }

  #checkTrack(track: number, count: number): void {
    if (!Number.isInteger(track) || track < 0 || track >= count)
      throw new MargoError(
        'state',
        `Modal sound track index is out of range. Choose a whole index from 0 through ${count - 1}.`,
      );
  }

  #live(): Data {
    if (!this.#data) throw new MargoError('state', 'Add the modal sound solver to a PhysicsWorld first.');
    return this.#data;
  }
}
