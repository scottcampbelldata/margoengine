// @margoengine/cutscene/lipsync: a dialogue track that drives mouth shapes. Timed phonemes go in, from a tool or from
// analyseSpeech, and weights for each viseme come out as a pure function of the time, so scrubbing moves the mouth as
// playing does. Speech is read with linear prediction (J. Makhoul, 1975) and the vowel chart of G. Peterson and H.
// Barney (1952): a formant estimate per frame, not a speech recogniser.
import type { CutsceneState, CutsceneTrackType, TrackInstant } from './cutscene.js';
import type { ClipBase, TrackCheck } from './document.js';

/** The 15 viseme names people know from game and avatar tools. */
export const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'ih', 'oh', 'ou'] as const;
/** A mouth position for a group of sounds. */
export type Viseme = (typeof VISEMES)[number];

const GROUPS: Readonly<Record<Viseme, string>> = {
  sil: 'pau sil sp spn ssil',
  PP: 'p b m',
  FF: 'f v',
  TH: 'th dh',
  DD: 't d',
  kk: 'k g hh ng',
  CH: 'ch jh sh zh',
  SS: 's z',
  nn: 'n l',
  RR: 'r er axr',
  aa: 'aa ae ah ax ay aw',
  E: 'eh ey',
  ih: 'ih iy y ix',
  oh: 'ao ow oy',
  ou: 'uh uw w',
};
const ARPABET = new Map<string, Viseme>(
  (Object.entries(GROUPS) as [Viseme, string][]).flatMap(([viseme, sounds]) =>
    sounds.split(' ').map((sound) => [sound, viseme] as [string, Viseme]),
  ),
);
const NAMES = new Set<string>(VISEMES);

/**
 * The viseme of a phoneme: an ARPAbet symbol in either case, with or without its stress digit (`AH0`, `ey`), or a
 * viseme name. Unknown symbols give null.
 */
export function visemeOf(phoneme: string): Viseme | null {
  if (NAMES.has(phoneme)) return phoneme as Viseme;
  return ARPABET.get(phoneme.toLowerCase().replace(/[0-2]$/, '')) ?? null;
}

/** A sound in dialogue. */
export interface PhonemeKey {
  /** Seconds from the start of the clip. */
  time: number;
  /** Seconds from the start of the clip; default the next key's time. */
  end?: number;
  /** ARPAbet symbol or viseme name. */
  phoneme: string;
  /** How far the mouth goes, 0 to 1 (default 1). */
  weight?: number;
}

/** A line of dialogue. */
export interface LipSyncClip extends ClipBase {
  phonemes: PhonemeKey[];
  /** Scale on every weight (default 1). */
  gain?: number;
}

/** Mouth shapes for one character. */
export interface LipSyncTrack {
  type: 'lipsync';
  id: string;
  /** The character's name in your scene. */
  target: string;
  clips: LipSyncClip[];
  /** Seconds a mouth takes to move into and out of a sound (default 0.06). */
  blend?: number;
  muted?: boolean;
}

/** Weights of the visemes that are not 0. They sum to 1 or less, and what is left is a closed, resting mouth. */
export type VisemeWeights = Partial<Record<Viseme, number>>;

function validate(track: Record<string, unknown>, check: TrackCheck): void {
  const { path, add } = check;
  check.target();
  if ('blend' in track && !(typeof track.blend === 'number' && track.blend >= 0 && Number.isFinite(track.blend)))
    add(`${path}.blend`, 'must be seconds, 0 or more');
  check.clips((clip, p) => {
    check.positive(clip, 'gain', p);
    const keys = check.list(clip.phonemes, `${p}.phonemes`);
    keys?.forEach((key, i) => {
      const at = `${p}.phonemes[${i}]`;
      if (!(typeof key.time === 'number' && key.time >= 0 && key.time <= (clip.duration as number)))
        add(`${at}.time`, 'must be seconds inside the clip');
      if ('end' in key && !(typeof key.end === 'number' && key.end >= (key.time as number)))
        add(`${at}.end`, 'must not come before its time');
      if (typeof key.phoneme !== 'string' || visemeOf(key.phoneme) === null)
        add(`${at}.phoneme`, `unknown phoneme ${JSON.stringify(key.phoneme)}; use ARPAbet or a viseme name`);
      if ('weight' in key && !(typeof key.weight === 'number' && key.weight >= 0 && key.weight <= 1))
        add(`${at}.weight`, 'must be from 0 to 1');
    });
    if (keys) check.ordered(keys, `${p}.phonemes`, 'time');
  });
}

interface Sound {
  from: number;
  to: number;
  viseme: Viseme;
  weight: number;
  /** The latest end of this sound and all before it, so a search backward knows when to stop. */
  latest: number;
}
const compiled = new WeakMap<object, Sound[]>();
function sounds(clip: LipSyncClip): Sound[] {
  let list = compiled.get(clip);
  if (list) return list;
  let latest = 0;
  list = clip.phonemes.map((key, i) => {
    const to = key.end ?? clip.phonemes[i + 1]?.time ?? clip.duration;
    latest = Math.max(latest, to);
    return { from: key.time, to, viseme: visemeOf(key.phoneme) as Viseme, weight: key.weight ?? 1, latest };
  });
  compiled.set(clip, list);
  return list;
}

/** Seconds a mouth takes to move into and out of a sound, unless the track says. */
const DEFAULT_BLEND = 0.06;

/** A sound's strength at `t`: full across it, ramping over `blend` on both sides, centred on its edges. */
function reach({ from, to }: Sound, t: number, blend: number): number {
  if (!blend) return t >= from && t < to ? 1 : 0;
  const half = blend / 2;
  return Math.max(0, Math.min(1, (t - from + half) / blend, (to + half - t) / blend));
}

/** The viseme weights of a clip at `t` seconds into it. */
export function visemesAt(clip: LipSyncClip, t: number, blend = DEFAULT_BLEND): VisemeWeights {
  const list = sounds(clip),
    half = blend / 2,
    out: VisemeWeights = {};
  // Sounds are sorted by start: look from the last one starting in reach, back to where nothing before lasts this long.
  let hi = list.length,
    lo = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].from - half <= t) lo = mid + 1;
    else hi = mid;
  }
  let total = 0;
  for (let i = lo - 1; i >= 0 && list[i].latest + half > t; i--) {
    const sound = list[i],
      strength = reach(sound, t, blend);
    if (strength <= 0) continue;
    total += strength;
    if (sound.viseme !== 'sil') out[sound.viseme] = (out[sound.viseme] ?? 0) + strength * sound.weight;
  }
  // Two sounds crossing share the mouth; together they never pass 1.
  const gain = (clip.gain ?? 1) / Math.max(1, total);
  for (const name of Object.keys(out) as Viseme[]) out[name] = Math.min(1, out[name]! * gain);
  return out;
}

/**
 * The `lipsync` track type: pass it in the `tracks` option of `Cutscene` or `CutscenePlayer`. A track sets the
 * character's weights, read with {@link mouthOf}. Clips fire `enter` and `exit`, named after the character.
 */
export function lipSyncTrack(): CutsceneTrackType {
  return {
    type: 'lipsync',
    validate,
    instants(raw): TrackInstant[] {
      const { clips, target } = raw as unknown as LipSyncTrack;
      return clips.flatMap((clip) => [
        { time: clip.start, kind: 'enter' as const, name: target, clip },
        { time: clip.start + clip.duration, kind: 'exit' as const, name: target, clip },
      ]);
    },
    evaluate(raw, t, state): void {
      const { clips, target, blend = DEFAULT_BLEND } = raw as unknown as LipSyncTrack,
        mouths = ((state.extras ??= {}).mouths ??= {}) as Record<string, VisemeWeights>,
        into = (mouths[target] ??= {});
      // Half a blend past each end of the clip, so a mouth opens into a line's first sound and closes after its last.
      const half = blend / 2;
      for (const clip of clips)
        if (t >= clip.start - half && t < clip.start + clip.duration + half)
          for (const [name, weight] of Object.entries(visemesAt(clip, t - clip.start, blend)))
            into[name as Viseme] = Math.min(1, (into[name as Viseme] ?? 0) + weight);
    },
  };
}

/** The viseme weights a state gives a character; empty when its mouth is at rest. */
export function mouthOf(state: CutsceneState, target: string): VisemeWeights {
  return (state.extras?.mouths as Record<string, VisemeWeights> | undefined)?.[target] ?? {};
}

/** Each viseme as blend shapes, by shape set. Shapes of one viseme are how far that shape goes at full weight. */
const SHAPES: Readonly<Record<'vrm' | 'arkit', Partial<Record<Viseme, Readonly<Record<string, number>>>>>> = {
  // The five mouth presets of VRM 1.0. Closed sounds are the mouth at rest, so they hold the others down by sharing.
  vrm: {
    FF: { ih: 0.2 },
    TH: { ih: 0.3, aa: 0.1 },
    DD: { ih: 0.3, aa: 0.15 },
    kk: { aa: 0.25, ih: 0.15 },
    CH: { ou: 0.4, ih: 0.3 },
    SS: { ih: 0.5 },
    nn: { ih: 0.25, aa: 0.15 },
    RR: { ou: 0.4, oh: 0.2 },
    aa: { aa: 1 },
    E: { ee: 0.8, aa: 0.2 },
    ih: { ih: 1 },
    oh: { oh: 1 },
    ou: { ou: 1 },
  },
  // The names of Apple's ARFaceAnchor blend shapes.
  arkit: {
    PP: { mouthClose: 0.3, mouthPressLeft: 0.6, mouthPressRight: 0.6 },
    FF: { mouthRollLower: 0.6, mouthUpperUpLeft: 0.3, mouthUpperUpRight: 0.3, jawOpen: 0.05 },
    TH: { jawOpen: 0.15, mouthUpperUpLeft: 0.1, mouthUpperUpRight: 0.1 },
    DD: { jawOpen: 0.15, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
    kk: { jawOpen: 0.2, mouthStretchLeft: 0.1, mouthStretchRight: 0.1 },
    CH: { jawOpen: 0.1, mouthFunnel: 0.6, mouthPucker: 0.3 },
    SS: { jawOpen: 0.05, mouthStretchLeft: 0.5, mouthStretchRight: 0.5 },
    nn: { jawOpen: 0.15, mouthStretchLeft: 0.15, mouthStretchRight: 0.15 },
    RR: { jawOpen: 0.15, mouthFunnel: 0.4, mouthPucker: 0.2 },
    aa: { jawOpen: 0.7 },
    E: { jawOpen: 0.35, mouthStretchLeft: 0.5, mouthStretchRight: 0.5 },
    ih: { jawOpen: 0.2, mouthSmileLeft: 0.4, mouthSmileRight: 0.4 },
    oh: { jawOpen: 0.45, mouthFunnel: 0.6 },
    ou: { jawOpen: 0.15, mouthPucker: 0.9 },
  },
};

/**
 * Weights as blend shapes to set: `'visemes'` (default) names them `viseme_aa` and so on, as avatar tools do, `'vrm'`
 * gives the five VRM 1.0 mouth presets, `'arkit'` Apple's face shape names. A shape absent from the result is 0.
 */
export function mouthShapes(weights: VisemeWeights, set: 'visemes' | 'vrm' | 'arkit' = 'visemes'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [viseme, weight] of Object.entries(weights) as [Viseme, number][]) {
    if (set === 'visemes') out[`viseme_${viseme}`] = weight;
    else
      for (const [shape, amount] of Object.entries(SHAPES[set][viseme] ?? {}))
        out[shape] = Math.min(1, (out[shape] ?? 0) + amount * weight);
  }
  return out;
}

/** Options of {@link analyseSpeech}. */
export interface SpeechOptions {
  /** Seconds of the frame step (default 0.01). */
  step?: number;
  /** Quietest sound counted, in dB under the loudest frame (default 35). */
  floor?: number;
  /** Shortest sound kept, seconds (default 0.04). */
  shortest?: number;
}

/** Rate speech is brought to: formants of interest lie under half of it. */
const FORMANT_RATE = 11_025;
const ORDER = 14;

/** Autocorrelation linear prediction by the Levinson-Durbin recursion. Coefficients of A(z), a[0] = 1. */
function predict(frame: Float64Array, order: number): Float64Array | null {
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = lag; i < frame.length; i++) sum += frame[i] * frame[i - lag];
    r[lag] = sum;
  }
  if (!(r[0] > 0)) return null;
  r[0] *= 1 + 1e-5; // White noise correction: keeps a near-silent frame's recursion stable.
  const a = new Float64Array(order + 1),
    next = new Float64Array(order + 1);
  a[0] = 1;
  let error = r[0];
  for (let i = 1; i <= order; i++) {
    let sum = r[i];
    for (let j = 1; j < i; j++) sum += a[j] * r[i - j];
    const k = -sum / error;
    next.set(a);
    for (let j = 1; j < i; j++) next[j] = a[j] + k * a[i - j];
    next[i] = k;
    a.set(next);
    error *= 1 - k * k;
    if (!(error > 0)) return null;
  }
  return a;
}

/** Peaks of the prediction filter's envelope, as frequencies in hertz, lowest first. */
function formants(a: Float64Array, rate: number): number[] {
  const bins = 256,
    power = new Float64Array(bins + 1);
  for (let b = 0; b <= bins; b++) {
    const w = (Math.PI * b) / bins;
    let re = 0,
      im = 0;
    for (let k = 0; k < a.length; k++) {
      re += a[k] * Math.cos(w * k);
      im -= a[k] * Math.sin(w * k);
    }
    power[b] = 1 / (re * re + im * im);
  }
  const out: number[] = [];
  for (let b = 1; b < bins; b++)
    if (power[b] > power[b - 1] && power[b] >= power[b + 1]) {
      // A parabola through the log of the three bins places the peak between them.
      const l = Math.log(power[b - 1]),
        c = Math.log(power[b]),
        r = Math.log(power[b + 1]),
        shift = (0.5 * (l - r)) / (l - 2 * c + r || 1),
        hertz = ((b + shift) / bins) * (rate / 2);
      if (hertz > 150) out.push(hertz);
    }
  return out;
}

/** Vowel centres of Peterson and Barney's chart, F1 and F2 in hertz, averaged over speakers. */
const VOWELS: readonly [Viseme, number, number][] = [
  ['ih', 300, 2400],
  ['ih', 420, 2050],
  ['E', 560, 1900],
  ['aa', 800, 1750],
  ['aa', 800, 1250],
  ['oh', 620, 950],
  ['ou', 470, 1050],
  ['ou', 320, 900],
];

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
};

/**
 * Reads timed visemes out of recorded speech: silence, hiss, and each vowel's mouth from its formants. It needs no
 * words or transcript and works on any voice in any language, as a rough mouth, not a transcript: it does not tell
 * consonants apart beyond closed, hiss and open. Use timed phonemes from a forced aligner when the mouth must be exact.
 * @returns keys ready for a clip's `phonemes`, with `weight` following how loud each sound is.
 * @throws RangeError for a bad rate or option.
 */
export function analyseSpeech(samples: Float32Array, sampleRate: number, options: SpeechOptions = {}): PhonemeKey[] {
  const { step = 0.01, floor = 35, shortest = 0.04 } = options;
  if (!(sampleRate >= 8000) || !Number.isFinite(sampleRate)) throw new RangeError('analyseSpeech needs a sampleRate of 8000 or more');
  if (!(step > 0) || !(floor > 0) || !(shortest >= 0)) throw new RangeError('analyseSpeech options must be above 0');
  // Averaging down to about FORMANT_RATE; what it does to the top of the band is above any formant read here.
  const factor = Math.max(1, Math.floor(sampleRate / FORMANT_RATE)),
    rate = sampleRate / factor,
    low = new Float64Array(Math.floor(samples.length / factor));
  for (let i = 0; i < low.length; i++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += samples[i * factor + k];
    low[i] = sum / factor;
  }
  const size = Math.round(0.03 * rate),
    hop = Math.max(1, Math.round(step * rate)),
    count = Math.max(0, Math.floor((low.length - size) / hop) + 1),
    window = Float64Array.from({ length: size }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1))),
    energy = new Float64Array(count),
    hiss = new Float64Array(count),
    first: number[][] = [],
    frame = new Float64Array(size);
  let loudest = 0;
  for (let f = 0; f < count; f++) {
    const at = f * hop;
    let sum = 0,
      diff = 0;
    for (let i = 0; i < size; i++) {
      const x = low[at + i],
        before = at + i > 0 ? low[at + i - 1] : 0;
      sum += x * x;
      diff += (x - before) ** 2;
      frame[i] = (x - 0.97 * before) * window[i];
    }
    energy[f] = sum / size;
    hiss[f] = sum > 0 ? diff / sum : 0;
    loudest = Math.max(loudest, energy[f]);
    const a = predict(frame, ORDER);
    first.push(a ? formants(a, rate) : []);
  }
  const quiet = loudest * 10 ** (-floor / 10),
    labels: Viseme[] = [],
    open: number[] = [];
  for (let f = 0; f < count; f++) {
    if (energy[f] <= quiet) labels.push('sil');
    else if (hiss[f] > 1.1) labels.push('SS');
    else {
      labels.push('aa');
      if (energy[f] > loudest * 0.03 && first[f].length >= 2) open.push(first[f][1]);
    }
  }
  // A longer vocal tract scales every formant down: the speaker's middle F2 against the chart's sets the scale.
  const scale = open.length ? median(open) / 1500 : 1;
  for (let f = 0; f < count; f++) {
    if (labels[f] !== 'aa') continue;
    const peaks = first[f];
    if (peaks.length < 2 || energy[f] < loudest * 0.003) {
      labels[f] = 'nn';
      continue;
    }
    const f1 = Math.log(peaks[0] / scale),
      f2 = Math.log(peaks[1] / scale);
    let best = Number.POSITIVE_INFINITY;
    for (const [viseme, c1, c2] of VOWELS) {
      const gap = (f1 - Math.log(c1)) ** 2 + (f2 - Math.log(c2)) ** 2;
      if (gap < best) {
        best = gap;
        labels[f] = viseme;
      }
    }
  }
  // A running vote over five frames takes out one-frame flips between neighbours on the chart.
  const voted = labels.map((label, f) => {
    const seen = new Map<Viseme, number>();
    for (let i = Math.max(0, f - 2); i <= Math.min(count - 1, f + 2); i++) seen.set(labels[i], (seen.get(labels[i]) ?? 0) + 1);
    let top = label,
      most = 0;
    for (const [name, votes] of seen)
      if (votes > most) {
        most = votes;
        top = name;
      }
    return top;
  });
  const seconds = (f: number): number => (f * hop + size / 2) / rate,
    runs: { from: number; to: number; viseme: Viseme }[] = [];
  for (let f = 0; f < count; f++) {
    const last = runs.at(-1);
    if (last?.viseme === voted[f]) last.to = f + 1;
    else runs.push({ from: f, to: f + 1, viseme: voted[f] });
  }
  // A sound too short to see joins the one before.
  const kept: typeof runs = [];
  for (const run of runs) {
    const last = kept.at(-1);
    if (last && (seconds(run.to) - seconds(run.from) < shortest || last.viseme === run.viseme)) last.to = run.to;
    else kept.push({ ...run });
  }
  const peak = Math.sqrt(loudest) || 1;
  return kept.map(({ from, to, viseme }) => {
    let sum = 0;
    for (let f = from; f < to; f++) sum += energy[f];
    const level = Math.sqrt(sum / (to - from)) / peak;
    return {
      time: seconds(from),
      end: seconds(to),
      phoneme: viseme,
      weight: viseme === 'sil' ? 1 : Math.min(1, 0.4 + level * 1.2),
    };
  });
}
