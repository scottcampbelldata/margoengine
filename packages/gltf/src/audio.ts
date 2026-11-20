/// <reference lib="esnext.disposable" preserve="true" />
import type { AudioListener, Audio as Sound, PositionalAudioOptions } from '@margoengine/audio';
import type { PBRModel } from './model.js';
import { margoError } from '../../shared/errors.js';
import { assetURL, checkRedirect } from '../../shared/asset-url.js';
import { readResponse } from '../../shared/loading.js';
import { embedded, assetLimit } from './asset.js';

type Json = Record<string, unknown>;
type Extension = 'KHR_audio_emitter' | 'MSFT_audio_emitter';
/** Loading and scene selection for applyGLTFAudio. */
export interface GLTFAudioOptions {
  /** Default the model's source URL. */
  baseURL?: string | URL;
  /** Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Audio download budget, default 64 MiB; decoded PCM has four times this budget. */
  maxDownloadBytes?: number;
  /** Maximum simultaneous source objects created by this attachment, default 256. */
  maxSources?: number;
  /** Default doc.scene or zero. Only that scene's node and global emitter instances are created. */
  scene?: number;
  /** Default honor KHR source autoPlay, with MSFT emitters initially stopped. False disables auto play. */
  autoplay?: boolean;
  /** Random number in [0,1), used for MSFT weighted clip selection on each new play trigger. Default Math.random. */
  random?: () => number;
  /** Additional allowed external URL prefixes, default none. */
  allowedURLs?: readonly string[];
}
/** One emitter instance; a shared definition may be instantiated on several nodes. */
export interface GLTFAudioEmitter {
  readonly extension: Extension;
  readonly emitterIndex: number;
  readonly nodeIndex?: number;
  readonly name: string;
  readonly sources: readonly Sound[];
  play(offset?: number): void;
  pause(): void;
  stop(): void;
}
/** Audio owned by one glTF model. Dispose detaches sounds, without disposing the caller's listener/context. */
export interface GLTFAudio {
  readonly emitters: readonly GLTFAudioEmitter[];
  /** Follow MSFT animation events, including skipped frames, backward seeks, pauses and resumed offsets. Call each animation tick. */
  sync(time: number, playing: boolean, animation?: number): void;
  dispose(): void;
  [Symbol.dispose](): void;
}
const invalid = (label: string): TypeError =>
  new TypeError('Invalid glTF audio ' + label + '; re-export the file and check its audio extension');
const object = (v: unknown, label: string): Json => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(label);
  return v as Json;
};
const list = (v: unknown, label: string): unknown[] => {
  if (!Array.isArray(v)) throw invalid(label);
  return v;
};
const number = (v: unknown, fallback: number, label: string, max = Infinity): number => {
  const n = v ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max) throw invalid(label);
  return n;
};
const bool = (v: unknown, label: string): boolean => {
  if (v !== undefined && typeof v !== 'boolean') throw invalid(label);
  return v === true;
};
const index = (v: unknown, label: string): number => {
  const n = number(v, -1, label);
  if (!Number.isSafeInteger(n)) throw invalid(label);
  return n;
};
const at = (v: unknown, i: unknown, label: string): Json => object(list(v, label)[index(i, label)], label);
async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return pending;
  let abort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Read draft KHR and MSFT audio emitters into the audio package's global and positional sources. */
export async function applyGLTFAudio(
  model: PBRModel,
  listener: AudioListener,
  options: GLTFAudioOptions = {},
): Promise<GLTFAudio> {
  options.signal?.throwIfAborted();
  if (model.disposed) throw margoError('disposed', 'Cannot attach audio to a disposed model; load it again');
  const { Audio, PositionalAudio, decodeAudio } = await import('@margoengine/audio').catch((error) => {
    throw margoError(
      'unsupported',
      `glTF audio needs @margoengine/audio (${error instanceof Error ? error.message : error}); install that optional package`,
    );
  });
  options.signal?.throwIfAborted();
  const doc = model.asset.doc,
    budget = number(options.maxDownloadBytes, assetLimit, 'maxDownloadBytes');
  if (!Number.isSafeInteger(budget) || budget < 1) throw invalid('maxDownloadBytes');
  const maxSources = number(options.maxSources, 256, 'maxSources');
  if (!Number.isSafeInteger(maxSources) || maxSources < 1) throw invalid('maxSources');
  if (options.autoplay !== undefined) bool(options.autoplay, 'autoplay');
  const random = options.random ?? Math.random;
  if (typeof random !== 'function') throw invalid('random');
  const auto: { sound: Sound; choose?: () => void }[] = [];
  const made: GLTFAudioEmitter[] = [],
    sounds: Sound[] = [],
    states: { emitter: GLTFAudioEmitter; choose(key?: object): void }[] = [];
  let downloaded = 0,
    decoded = 0,
    disposed = false;
  const buffers = new Map<string, Promise<AudioBuffer>>();
  const sceneIndex = index(options.scene ?? doc.scene ?? 0, 'scene');
  const scene = doc.scenes?.length ? object(doc.scenes[sceneIndex], 'scene') : undefined;
  const active = new Set<number>();
  const visit = (id: unknown) => {
    const n = index(id, 'node');
    if (active.has(n)) return;
    active.add(n);
    const node = object(doc.nodes?.[n], 'node');
    for (const child of node.children === undefined ? [] : list(node.children, 'children')) visit(child);
  };
  if (scene) for (const root of scene.nodes === undefined ? [] : list(scene.nodes, 'scene nodes')) visit(root);
  else for (let n = 0; n < (doc.nodes?.length ?? 0); n++) active.add(n);
  const read = (extension: Extension, defs: Json, clip: unknown): Promise<AudioBuffer> => {
    const id = index(clip, 'clip'),
      key = extension + ':' + id;
    let pending = buffers.get(key);
    if (pending) return pending;
    pending = (async () => {
      const def = at(extension === 'KHR_audio_emitter' ? defs.audio : defs.clips, id, 'audio data');
      const mime = def.mimeType;
      if (
        (def.bufferView !== undefined && typeof mime !== 'string') ||
        (mime !== undefined && !['audio/wav', 'audio/mpeg'].includes(String(mime)))
      )
        throw invalid('MIME type');
      let bytes: Uint8Array;
      if (def.bufferView !== undefined) bytes = model.asset.view(index(def.bufferView, 'bufferView'));
      else if (typeof def.uri !== 'string') throw invalid('URI');
      else if (def.uri.startsWith('data:')) bytes = embedded(def.uri, budget - downloaded);
      else {
        const base = options.baseURL ?? model.asset.baseURL;
        const url = assetURL(def.uri, base?.toString(), options.allowedURLs, 'glTF audio');
        const response = await (options.fetch ?? globalThis.fetch)(url, { signal: options.signal });
        checkRedirect(response, base?.toString(), options.allowedURLs, 'glTF audio');
        bytes = await readResponse(response, {
          maxBytes: budget - downloaded,
          signal: options.signal,
          label: 'glTF audio',
        });
      }
      downloaded += bytes.length;
      if (downloaded > budget) throw new RangeError('glTF audio exceeds download budget; raise maxDownloadBytes');
      const copy = new Uint8Array(bytes).buffer;
      const buffer = await abortable(decodeAudio(listener.context, copy), options.signal);
      decoded += buffer.length * buffer.numberOfChannels * 4;
      if (decoded > budget * 4) throw new RangeError('glTF audio exceeds decoded PCM budget; raise maxDownloadBytes');
      return buffer;
    })();
    buffers.set(key, pending);
    return pending;
  };
  const create = async (extension: Extension, defs: Json, emitterId: unknown, nodeIndex?: number) => {
    options.signal?.throwIfAborted();
    const emitterIndex = index(emitterId, 'emitter'),
      def = at(defs.emitters, emitterIndex, 'emitter');
    const khr = extension === 'KHR_audio_emitter';
    const positional = khr ? def.type === 'positional' : nodeIndex !== undefined;
    if (khr && def.type !== 'positional' && def.type !== 'global') throw invalid('emitter type');
    if (positional && nodeIndex === undefined) throw invalid('positional scene emitter');
    const spatial = khr ? (def.positional === undefined ? {} : object(def.positional, 'positional')) : def;
    if (
      !positional &&
      (khr
        ? def.positional !== undefined
        : ['distanceModel', 'refDistance', 'maxDistance', 'rolloffFactor', 'innerAngle', 'outerAngle'].some(
            (k) => def[k] !== undefined,
          ))
    )
      throw invalid('global emitter spatial properties');
    const gain = number(khr ? def.gain : def.volume, 1, 'emitter gain');
    const distanceModel = spatial.distanceModel ?? (khr ? 'inverse' : 'exponential');
    if (!['linear', 'inverse', 'exponential'].includes(String(distanceModel))) throw invalid('distance model');
    const refDistance = number(spatial.refDistance, 1, 'reference distance');
    if (!refDistance) throw invalid('reference distance');
    const maxDistance = number(spatial.maxDistance, khr ? 0 : 256, 'maximum distance') || 3.4028234663852886e38;
    if (distanceModel === 'linear' && maxDistance <= refDistance) throw invalid('linear maximum distance');
    const rolloffFactor = number(spatial.rolloffFactor, 1, 'rolloff', distanceModel === 'linear' ? 1 : Infinity);
    const shape = spatial.shapeType ?? 'omnidirectional';
    if (khr && !['cone', 'omnidirectional'].includes(String(shape))) throw invalid('emitter shape');
    const cone = khr ? shape === 'cone' : spatial.innerAngle !== undefined || spatial.outerAngle !== undefined;
    const unit = khr ? 180 / Math.PI : 360 / Math.PI,
      limit = khr ? Math.PI * 2 : Math.PI;
    const inner = cone
      ? number(khr ? spatial.coneInnerAngle : spatial.innerAngle, limit, 'inner cone angle', limit) * unit
      : 360;
    const outer = cone
      ? number(khr ? spatial.coneOuterAngle : spatial.outerAngle, limit, 'outer cone angle', limit) * unit
      : 360;
    if (outer < inner) throw invalid('cone angle order');
    const settings: PositionalAudioOptions = {
      volume: gain,
      direction: khr ? [0, 0, -1] : [0, 0, 1],
      mesh: nodeIndex === undefined ? undefined : model.nodes[nodeIndex],
      distanceModel: distanceModel as PositionalAudioOptions['distanceModel'],
      refDistance,
      maxDistance,
      rolloffFactor,
      coneInnerAngle: inner,
      coneOuterAngle: outer,
      coneOuterGain: khr ? number(spatial.coneOuterGain, 0, 'cone outer gain', 1) : 0,
    };
    const refs = list(khr ? (def.sources ?? []) : def.clips, 'emitter sources');
    if ((khr ? refs.length : 1) > maxSources - sounds.length)
      throw new RangeError('glTF audio exceeds source budget; raise maxSources');
    if (!khr && !refs.length) throw invalid('empty MSFT clips');
    const sourceDefs = khr
      ? refs.map((id) => at(defs.sources, id, 'source'))
      : refs.map((v) => object(v, 'clip reference'));
    const data: AudioBuffer[] = [];
    for (const source of sourceDefs) data.push(await read(extension, defs, khr ? source.audio : source.clip));
    const weights = khr ? [] : sourceDefs.map((source) => number(source.weight, 1, 'clip weight'));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!khr && (!Number.isFinite(total) || total <= 0)) throw invalid('clip weights');
    const local: Sound[] = [];
    for (let n = 0; n < (khr ? sourceDefs.length : 1); n++) {
      const source = sourceDefs[n];
      const opts = {
        ...settings,
        loop: bool(khr ? source.loop : def.loop, 'loop'),
        volume: gain * (khr ? number(source.gain, 1, 'source gain') : 1),
      };
      const sound = positional ? new PositionalAudio(listener, opts) : new Audio(listener, opts);
      sounds.push(sound);
      local.push(sound);
      sound.setBuffer(data[n]);
    }
    const choices = new WeakMap<object, number>();
    const choose = (key?: object) => {
      if (khr) return;
      let selected = key && choices.get(key);
      if (selected === undefined) {
        const r = random();
        if (!Number.isFinite(r) || r < 0 || r >= 1) throw invalid('random sample');
        const point = r * total;
        let sum = 0;
        selected = weights.length - 1;
        while (weights[selected] === 0) selected--;
        for (let i = 0; i < weights.length; i++)
          if (point < (sum += weights[i])) {
            selected = i;
            break;
          }
        if (key) choices.set(key, selected);
      }
      if (local[0].buffer !== data[selected]) {
        local[0].stop();
        local[0].setBuffer(data[selected]);
      }
    };
    const check = () => {
      if (disposed) throw margoError('disposed', 'glTF audio is disposed; apply the audio extension again');
    };
    const emitter: GLTFAudioEmitter = {
      extension,
      emitterIndex,
      nodeIndex,
      name: typeof def.name === 'string' ? def.name : '',
      sources: local,
      play(offset = 0) {
        check();
        number(offset, 0, 'play offset');
        choose();
        for (const sound of local) {
          sound.stop();
          sound.offset = offset;
          sound.play();
        }
      },
      pause() {
        check();
        for (const sound of local) sound.pause();
      },
      stop() {
        check();
        for (const sound of local) sound.stop();
      },
    };
    made.push(emitter);
    states.push({ emitter, choose });
    for (let n = 0; n < local.length; n++) {
      const authored = khr && bool(sourceDefs[n].autoPlay, 'autoPlay');
      if (options.autoplay !== false && (options.autoplay === true || authored))
        auto.push({ sound: local[n], choose: khr ? undefined : choose });
    }
  };
  let remove = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    remove();
    for (const sound of sounds) sound.dispose();
    buffers.clear();
  };
  try {
    for (const extension of ['KHR_audio_emitter', 'MSFT_audio_emitter'] as const) {
      const root = doc.extensions?.[extension];
      if (root === undefined) continue;
      const defs = object(root, extension);
      for (const n of active) {
        const ref = doc.nodes?.[n]?.extensions?.[extension];
        if (ref === undefined) continue;
        const node = object(ref, 'node emitter');
        const ids = extension === 'KHR_audio_emitter' ? [node.emitter] : list(node.emitters, 'node emitters');
        for (const id of ids) await create(extension, defs, id, n);
      }
      const ref = scene && (scene.extensions as Json | undefined)?.[extension];
      if (ref !== undefined)
        for (const id of list(object(ref, 'scene emitter').emitters, 'scene emitters'))
          await create(extension, defs, id);
    }
    options.signal?.throwIfAborted();
    if (model.disposed) throw margoError('disposed', 'Model was disposed while audio loaded; load it again');
    const result: GLTFAudio = {
      emitters: made,
      dispose,
      [Symbol.dispose]: dispose,
      sync(time, playing, animation = 0) {
        if (disposed) throw margoError('disposed', 'glTF audio is disposed; apply the audio extension again');
        number(time, 0, 'timeline time');
        if (typeof playing !== 'boolean') throw invalid('playing');
        const def = doc.animations?.[index(animation, 'animation')];
        const ext = def?.extensions?.MSFT_audio_emitter;
        const events =
          ext === undefined
            ? []
            : list(object(ext, 'animation events').events, 'events').map((v) => object(v, 'event'));
        const ordered = events
          .map((event, order) => ({ event, order, time: number(event.time, NaN, 'event time') }))
          .sort((a, b) => a.time - b.time || a.order - b.order);
        for (const { emitter, choose } of states) {
          if (emitter.extension !== 'MSFT_audio_emitter') continue;
          let on = false,
            paused = false,
            position = 0,
            start = 0,
            key: object | undefined;
          for (const { event, time: eventTime } of ordered) {
            const id = index(event.emitter, 'event emitter');
            at(object(doc.extensions?.MSFT_audio_emitter, 'MSFT_audio_emitter').emitters, id, 'event emitter');
            if (!['play', 'pause', 'stop'].includes(String(event.action))) throw invalid('event action');
            if (eventTime > time || id !== emitter.emitterIndex) continue;
            if (event.action === 'play') {
              if (!paused) {
                position = number(event.startOffset, 0, 'start offset');
                key = event;
              }
              on = true;
              paused = false;
              start = eventTime;
            } else if (event.action === 'pause') {
              if (on) position += eventTime - start;
              on = false;
              paused = true;
            } else {
              position = 0;
              on = false;
              paused = false;
              key = undefined;
            }
          }
          if (on) position += time - start;
          if (key) choose(key);
          for (const sound of emitter.sources) {
            sound.offset = 0;
            sound.sync(position, on && playing);
          }
        }
      },
    };
    remove = model.onDispose(dispose);
    for (const { sound, choose } of auto) {
      choose?.();
      sound.play();
    }
    return result;
  } catch (error) {
    dispose();
    throw error;
  }
}
