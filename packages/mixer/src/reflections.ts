import { MargoError } from '@margoengine/math/errors';
import { impulseResponse } from './dsp.js';
import { createEffect, type Effect } from './effects.js';
import { bounded } from './worklet-host.js';

/** Axis-aligned room vector in metres: x width, y height, z depth. */
export type RoomVector = readonly [number, number, number];
/** One first-order reflecting wall. */
export type RoomWall = 'left' | 'right' | 'floor' | 'ceiling' | 'front' | 'back';
/** Geometry for first-order image-source reflections. */
export interface ReflectionOptions {
  /** Room dimensions, each 0.5..100 m. Default [6,3,8]. */
  room?: RoomVector;
  /** Point source inside the room. Default [0.35*width,0.5*height,0.25*depth]. */
  source?: RoomVector;
  /** Listener centre inside the room. Default [0.6*width,0.5*height,0.7*depth]. */
  listener?: RoomVector;
  /** Frequency-independent wall pressure coefficient, 0..1, default 0.7. */
  reflection?: number;
  /** Channels, 1 or 2, default 2. Stereo ears lie along the x axis. */
  channels?: 1 | 2;
  /** Ear separation, 0..1 m, default 0.18. Ignored for mono. Ears must remain inside the room. */
  earSpacing?: number;
  /** Speed of sound, 200..400 m/s, default 343. */
  speedOfSound?: number;
}
/** One reflected arrival, relative to the direct sound at that ear. */
export interface EarlyReflection {
  /** Output channel, zero-based. */
  readonly channel: number;
  /** Reflecting wall. */
  readonly wall: RoomWall;
  /** Extra path travel time in seconds. */
  readonly delay: number;
  /** Pressure gain relative to a unit source at one metre, reflection / path length. */
  readonly gain: number;
}
/** Synthetic room response settings. */
export interface RoomImpulseOptions extends ReflectionOptions {
  /** Late-tail duration, default 2 s, range 0.05..20. Early arrivals precede it. */
  seconds?: number;
  /** Late-tail RT60, default seconds/2, range 0.01..20 s. */
  decay?: number;
  /** Gain of the existing unit-energy noise tail, 0..1, default 0.35. Zero omits it. */
  tailGain?: number;
  /** Integer noise seed, 0..4294967295, default 1. */
  seed?: number;
}
/** Room response plus wet/dry setting. */
export interface RoomReverbOptions extends RoomImpulseOptions {
  /** Wet share 0..1, default 0.25. Dry is 1 minus it. */
  mix?: number;
}

function vector(value: RoomVector, name: string): number[] {
  if (!Array.isArray(value) || value.length !== 3)
    throw new TypeError(`${name} needs three metre coordinates; pass [x,y,z]`);
  return [0, 1, 2].map((i) => bounded(value[i], -100, 100, name));
}

/** Calculate six first-order wall arrivals per ear, without allocating audio buffers. No direct path is included. */
export function roomReflections(options: ReflectionOptions = {}): EarlyReflection[] {
  const room = vector(options.room ?? [6, 3, 8], 'Room size');
  room.forEach((value) => bounded(value, 0.5, 100, 'Room size'));
  const source = vector(options.source ?? [room[0] * 0.35, room[1] * 0.5, room[2] * 0.25], 'Room source');
  const listener = vector(options.listener ?? [room[0] * 0.6, room[1] * 0.5, room[2] * 0.7], 'Room listener');
  const channels = options.channels ?? 2;
  if (typeof channels !== 'number') throw new TypeError('Room channels needs a number; choose 1 or 2');
  if (channels !== 1 && channels !== 2) throw new RangeError('Room channels needs 1 or 2; choose mono or stereo');
  const spacing = bounded(options.earSpacing ?? 0.18, 0, 1, 'Room earSpacing');
  const coefficient = bounded(options.reflection ?? 0.7, 0, 1, 'Room reflection');
  const speed = bounded(options.speedOfSound ?? 343, 200, 400, 'Room speedOfSound');
  for (let i = 0; i < 3; i++) {
    bounded(source[i], 0.01, room[i] - 0.01, 'Room source coordinate');
    bounded(listener[i], 0.01, room[i] - 0.01, 'Room listener coordinate');
  }
  const walls: RoomWall[] = ['left', 'right', 'floor', 'ceiling', 'front', 'back'];
  const arrivals: EarlyReflection[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const ear = [...listener];
    ear[0] += channels === 1 ? 0 : (channel === 0 ? -spacing / 2 : spacing / 2);
    bounded(ear[0], 0.01, room[0] - 0.01, 'Room ear position; reduce earSpacing or move the listener');
    const direct = Math.hypot(...source.map((value, i) => value - ear[i]));
    for (let wall = 0; wall < 6; wall++) {
      const axis = Math.floor(wall / 2), image = [...source];
      image[axis] = wall % 2 === 0 ? -source[axis] : 2 * room[axis] - source[axis];
      const distance = Math.hypot(...image.map((value, i) => value - ear[i]));
      arrivals.push({ channel, wall: walls[wall], delay: (distance - direct) / speed, gain: coefficient / distance });
    }
  }
  return arrivals;
}

/** Combine fractional-sample wall impulses and the existing seeded synthetic tail; preserves physical early gains. */
export function roomImpulseResponse(sampleRate: number, options: RoomImpulseOptions = {}): Float32Array[] {
  bounded(sampleRate, 8000, 192000, 'Room sampleRate');
  if (!Number.isInteger(sampleRate)) throw new RangeError('Room sampleRate needs an integer; pass the context sampleRate');
  const arrivals = roomReflections(options), channels = options.channels ?? 2;
  const seconds = bounded(options.seconds ?? 2, 0.05, 20, 'Room seconds');
  const decay = bounded(options.decay ?? seconds / 2, 0.01, 20, 'Room decay');
  const tailGain = bounded(options.tailGain ?? 0.35, 0, 1, 'Room tailGain');
  const seed = bounded(options.seed ?? 1, 0, 4294967295, 'Room seed');
  if (!Number.isInteger(seed)) throw new RangeError('Room seed needs an integer; pass a 32-bit unsigned seed');
  const last = Math.max(...arrivals.map((arrival) => arrival.delay));
  const start = Math.ceil(Math.max(0.03, last + 0.01) * sampleRate);
  const tail = tailGain === 0 ? undefined : impulseResponse(sampleRate, { seconds, decay, channels, seed });
  const length = Math.max(Math.ceil(last * sampleRate) + 2, tail ? start + tail[0].length : 0);
  const out = Array.from({ length: channels }, () => new Float32Array(length));
  for (const arrival of arrivals) {
    const frame = arrival.delay * sampleRate, at = Math.floor(frame), fraction = frame - at;
    out[arrival.channel][at] += arrival.gain * (1 - fraction);
    out[arrival.channel][at + 1] += arrival.gain * fraction;
  }
  if (tail) for (let channel = 0; channel < channels; channel++)
    for (let i = 0; i < tail[channel].length; i++) out[channel][start + i] += tail[channel][i] * tailGain;
  return out;
}

/** Create a disposable Web Audio convolution reverb with early room reflections; works beside WebGPU and WebGL2. */
export function createRoomReverb(context: BaseAudioContext, options: RoomReverbOptions = {}): Effect {
  if (!context || typeof context.createConvolver !== 'function' || typeof context.createBuffer !== 'function')
    throw new MargoError('unsupported', 'Room reverb needs Web Audio; use an AudioContext or OfflineAudioContext. https://margoengine.com/llms/packages/mixer.md');
  const mix = bounded(options.mix ?? 0.25, 0, 1, 'Room mix');
  const channels = roomImpulseResponse(context.sampleRate, options);
  const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
  channels.forEach((data, channel) => buffer.getChannelData(channel).set(data));
  return createEffect(context, { type: 'reverb', impulse: buffer, mix });
}
