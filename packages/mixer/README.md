# @margoengine/mixer

Import `margoengine/mixer` from the `margoengine` package, or `@margoengine/mixer` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Audio mixing and effects on Web Audio, as a sibling of `@margoengine/audio`: a tree of buses with fader, mute, solo, sends and ducking; an effects chain (equaliser, filter, compressor, limiter, delay, convolution reverb); positional emitters; and deterministic offline rendering so a chain can be rendered and its numbers compared in a test. Nothing touches `AudioContext` at import time, and the package adds nothing to core.

```ts
import { Mixer, renderOffline, measure } from 'margoengine/mixer';

// Live: mix before the listener, so the camera-following AudioListener from margoengine/audio stays the last stage.
//   using mixer = new Mixer(listener.context, {destination: listener.input, buses: {...}});
// Offline (runs in a browser; the same calls work on a live AudioContext):
const buffer = await renderOffline({ seconds: 2, sampleRate: 48000, mixer: { effects: [{ type: 'limiter', ceiling: -1 }] } }, ({ context, mixer }) => {
  mixer.createBus('music', { gain: -6, effects: [{ type: 'eq', bands: [{ type: 'lowshelf', frequency: 120, gain: 3 }] }] });
  mixer.createBus('voice');
  const reverb = mixer.createBus('room', { effects: [{ type: 'reverb', seconds: 1.5, mix: 1 }], soloSafe: true });
  mixer.bus('voice').send(reverb, { gain: -9 });

  const tone = new OscillatorNode(context, { frequency: 220 });
  mixer.route(tone, 'music');
  tone.start(0);
  tone.stop(2);

  // Lower the music by 12 dB from 0.5 s to 1.2 s for a line of dialogue.
  const duck = mixer.bus('music').duck({ amount: 12, attack: 0.05, at: 0.5 });
  duck.release({ at: 1.2, seconds: 0.3 });
});
const { peak, rms } = measure(buffer.getChannelData(0));
```

## Buses

`new Mixer(context, {destination, gain, effects, buses})` makes a `master` bus and any buses you list. `mixer.createBus(name, {parent, gain, muted, solo, soloSafe, effects})` adds one that feeds its parent (default master). Each bus is `input -> effects -> fader -> duck -> mute/solo gate -> output`.

- **Gain** in dB: `bus.setGain(-6, {at, seconds})`. Changes move smoothly (about 20 ms) unless the context has not started or `seconds` is 0, so there are no clicks and an offline render starts at the right level.
- **Mute and solo**: `bus.setMuted(true)`, `bus.setSolo(true)`. While anything is soloed, only soloed buses, their ancestors (which carry the sound on), their descendants (which feed them) and `soloSafe` buses such as reverb returns stay audible. A solo-safe bus still plays through its parent, so put returns straight under `master`: under a group that no solo reaches, its sound stops at the group's closed gate. `audibleBuses(states)` is that rule as a pure function, one gate per bus.
- **Sends**: `bus.send(other, {gain, pre})` copies part of a bus to another (after the gate by default, so muting the bus mutes the send; `pre` taps before the fader). A send that would make a loop throws `RangeError`.
- **Ducking**: `bus.duck({amount, attack, at})` lowers a bus and returns a handle; `handle.release({at, seconds})` brings it back. Overlapping ducks hold the deepest one. You decide when to duck (when a voice starts); automatic audio-clock detection is available in the optional `mixer/sidechain` entry below.
- **Routing**: `mixer.route(source, bus)` connects an AudioNode, or anything with `getOutput()` such as `Audio` and `PositionalAudio` from `margoengine/audio`, to a bus after removing its other connections. Configure the sound's filters first.
- **Scheduling** uses AudioContext time: every `at` is `context.currentTime` seconds (default now), and `mixer.now` reads the clock.
- `bus.peak()` reads the current output peak (it adds an AnalyserNode on first use).

Invalid numeric fades are rejected before bus targets, gates, duck membership or existing automation
change. Times/durations must be finite and nonnegative; parameter values must fit finite float32.
Gain is checked before it reaches a node (-Infinity dB remains silence). Invalid duck releases
leave the handle active so it can be released correctly. An omitted or undefined release duration
keeps 0.4 s; gate fades keep their 0.01 s default.

## Effects

Effects are plain objects, so a chain can be stored as JSON: `bus.setEffects([...])`, or `createEffect(context, spec)` for one effect.

| `type` | Settings (defaults) | Built from |
| --- | --- | --- |
| `eq` | `bands: [{type: 'peaking', frequency, q, gain}]`, 1 to 16 bands | one BiquadFilterNode per band |
| `filter` | `filter`, `frequency`, `q`, `gain` | BiquadFilterNode |
| `compressor` | `threshold` -24, `knee` 30, `ratio` 4, `attack` 0.003, `release` 0.25 | DynamicsCompressorNode |
| `limiter` | `ceiling` -1 dB, `release` 0.05 | DynamicsCompressorNode, ratio 20, knee 0 |
| `delay` | `time` 0.3 s (at least 128 samples), `feedback` 0.35 (at most 0.95), `mix` 0.3 | DelayNode with a feedback loop; echo k lands exactly at k times `time` |
| `reverb` | `seconds` 2, `decay` seconds/2, `preDelay` 0, `mix` 0.25, `seed` 1, or a recorded `impulse` | ConvolverNode, `normalize = false` |

Filter `q` follows the Web Audio specification: decibels of resonance for `lowpass` and `highpass` (default -3.01, a Butterworth response), a plain quality factor for the rest (0.001 to 1000; lowpass and highpass take -40 to 100 dB in an effect). A bad value throws `RangeError`, a wrong type `TypeError`. Every effect has `input`, `output`, named `params` you can automate, `dispose()` and `using` support; delay and reverb also have `setMix(0..1, at)`.

The reverb room is synthetic by default: seeded noise that falls 60 dB over `decay` seconds, scaled to unit energy (`impulseResponse(sampleRate, options)`, same seed, same samples). For a recorded room, `await loadImpulse(context, '/rooms/hall.wav', {signal})` and pass it as `impulse`; the signal cancels the download and decoding.

## Positional sound

`mixer.emitter(bus, {position, refDistance, rolloffFactor, distanceModel, panningModel, cone})` returns an `Emitter`: connect your source to `emitter.input`, move it with `setPosition(x, y, z, at)`, aim it with `setOrientation`. It is panned against the context's own listener. With `AudioListener` from `margoengine/audio` that listener follows the engine camera every frame, so emitters are tied to the camera with no extra code; without it, call `setListenerPose(context, {position, forward, up})` yourself.

## Offline rendering

`renderOffline({seconds, sampleRate, channels, mixer, signal}, setup)` builds a mixer on an `OfflineAudioContext`, runs your (possibly async) `setup` to create and schedule sources, renders faster than real time and returns the AudioBuffer. The same graph and inputs give the same samples, which is how this package tests its chains against the filter formulas. `bufferChannels(buffer)` copies the channels out.

## Maths you can use without Web Audio

`biquadCoefficients`, `biquadMagnitude` and `biquadProcess` (the RBJ cookbook as the Web Audio specification states it), `compressorCurve` (the soft-knee static curve of Giannoulis, Massberg and Reiss), `impulseResponse`, `dbToGain`, `gainToDb`, `measure` (peak and RMS). All run in Node.

## Errors

`RangeError` and `TypeError` for bad arguments. `MargoError` codes: `disposed` (a bus, emitter or mixer used after `dispose()`), `state` (unknown, duplicate or still-parented bus), `unsupported` (no `OfflineAudioContext` or `fetch`), `failed` (an HTTP or decoding error, or a filter setting with no stable filter). Messages say what to change.

## Limits

- Compressor and limiter use the browser's DynamicsCompressorNode. The Web Audio specification leaves its curve to the browser and adds an automatic make-up gain, so results differ between browsers; the root limiter lowers peaks hard but is not a sample-accurate brick wall; use the optional worklet entry below for its fixed curve and true-peak bound. `compressorCurve` is a design aid, not a model of the node.
- Web Audio cannot be interrupted mid-render: an aborted `renderOffline` rejects when the render ends and drops the result.
- Web Audio cannot loop faster than 128 samples (2.7 ms at 48 kHz), so that is the shortest delay `time`, and it is fixed when the effect is created; build a new effect to change it.
- The root entry has manual ducking; automatic detection is in the optional `mixer/sidechain` entry.
- The root reverb is a synthetic noise tail unless you give it a recorded impulse; the optional reflections entry adds geometric early arrivals. It runs on the audio thread as a convolution, so a long `seconds` costs CPU.
- Offline checks run in a browser (`npm run test:browser` in this package). The Node tests cover the maths and the graph wiring and scheduling through a fake context, not rendered sound.

Apache-2.0. Optional, tree-shakable package; no core dependency.

Build and unit tests: npm test --workspace @margoengine/mixer

## Automatic sidechain ducking

`createSidechain(context, options)` from `margoengine/mixer/sidechain` (or
`@margoengine/mixer/sidechain`) lowers a music signal while a separate dialogue key is active.
No timers or manual duck scheduling: a two-input AudioWorklet detects the maximum absolute key
sample across channels. Connect dialogue to its audible bus as well as `duck.sidechain`; the key
itself never reaches `duck.output`. Put the stage before the music bus input.

```ts
import { createSidechain } from 'margoengine/mixer/sidechain';
const context = new OfflineAudioContext(2, 48000, 48000);
using duck = await createSidechain(context, { amount: 12 });
const music = new ConstantSourceNode(context, { offset: 0.25 });
const dialogue = new ConstantSourceNode(context, { offset: 0.5 });
music.connect(duck.input);
dialogue.connect(duck.sidechain);
duck.output.connect(context.destination);
music.start(0); music.stop(1);
dialogue.start(0.2); dialogue.stop(0.5);
const rendered = await context.startRendering();
console.log(rendered.length);
```

Options: `amount` 12 dB (0..96), `threshold` -40 dBFS (-120..0), `attack` 0.01 s,
`release` 0.2 s, `hold` 0.05 s (all times 0..10 s), `channels` 2 (integer 1..32),
`signal` unset. Attack/release are one-pole gain time constants (63.2% of the move in one
constant); zero jumps. Above-threshold samples reset the hold. Channel conversion uses Web Audio's
explicit speaker layout. This is peak-triggered ducking, not speech recognition or lookahead;
noise above threshold also triggers it. Options are fixed; create another stage to change them.
Disposal is idempotent and stops processing, leaving caller sources and the context owned by you.

Renderer independent: identical audio beside WebGPU and WebGL2, both tested in Edge.
Requires secure-context AudioWorklet and `blob:` in CSP `script-src`. Unsupported environments
throw `MargoError` code `unsupported`; a registration failure throws `failed` with cause and a help
link. `signal` cancels waiting promptly; shared context registration can finish in the background.
Other browsers, real speech and latency/performance are unmeasured; tests use generated signals.

## Mixer snapshots

Capture bus fader targets, mute/solo flags and current numeric effect AudioParams with
`captureSnapshot(mixer)` from `margoengine/mixer/snapshots` (or `@margoengine/mixer/snapshots`).
The value is independent of the mixer and JSON serializable; silent faders use `gain: null`.
Recall a saved pause or underwater state on the audio clock:

```ts
import { Mixer } from 'margoengine/mixer';
import { captureSnapshot, recallSnapshot, blendSnapshots } from 'margoengine/mixer/snapshots';
const context = new OfflineAudioContext(2, 48000, 48000);
using mixer = new Mixer(context, { buses: {
  music: { effects: [{ type: 'filter', filter: 'lowpass', frequency: 20000 }] }
} });
const clear = captureSnapshot(mixer);
mixer.bus('music').setGain(-12, { seconds: 0 });
mixer.bus('music').effects[0].params.frequency.value = 400;
const underwater = JSON.parse(JSON.stringify(captureSnapshot(mixer)));
recallSnapshot(mixer, clear, { seconds: 0 });
recallSnapshot(mixer, underwater, { at: 0.2, seconds: 0.1 });
recallSnapshot(mixer, clear, { at: 0.7, seconds: 0.1 });
const halfway = blendSnapshots(clear, underwater, 0.5);
console.log(halfway.buses.length);
await context.startRendering();
```

`recallSnapshot` options: `at` defaults to `mixer.now` (must be finite and not in the past),
`seconds` defaults to 0.25 (0..3600). Fades follow the existing mixer exponential smoothing:
about 98% settled in `seconds`, never a promise of an exact-duration linear ramp. Zero jumps.
Capturing during a fade saves fader/mute/solo targets and the effects' current AudioParam values.
`blendSnapshots(a,b,t)` is a pure value blend for t 0..1: faders in linear amplitude, effect
parameters linearly, mute/solo from the nearer endpoint (b at 0.5). Both snapshots need the same
bus names and effect parameter layouts. Recall permits a subset of existing buses.

The entire payload and layout are checked before scheduling. Existing effects must match in order,
kind and parameter names. Routing, sends, filter types, delay times, convolution buffers, effect
creation/removal, active manual ducks and external worklets are not captured or replaced.
Native effect parameters keep their existing valid ranges, including the delay's 0.95 feedback cap.
WebGPU and WebGL2 use the same Web Audio path, tested beside both in Edge. Other browsers and real
recordings unmeasured. No timer, async wait or engine attachment is involved.

## Exact worklet dynamics

`createDynamics(context, options)` from `margoengine/mixer/worklet` (or
`@margoengine/mixer/worklet`) provides a package-owned AudioWorklet compressor/limiter.
The curve is defined by this package in every browser, with no native compressor or automatic
make-up gain. Channels share peak detection and gain. Compressor mode uses the published
soft-knee dB curve; a true-peak safety stage follows both modes.

```ts
import { createDynamics, measureTruePeak } from 'margoengine/mixer/worklet';
const context = new OfflineAudioContext(2, 48128, 48000);
using dynamics = await createDynamics(context, { mode: 'compressor', threshold: -24, ratio: 4, ceiling: -1 });
const source = new ConstantSourceNode(context, { offset: 0.5 });
source.connect(dynamics.input);
dynamics.output.connect(context.destination);
source.start(0); source.stop(1);
const result = await context.startRendering();
console.log(measureTruePeak([result.getChannelData(0), result.getChannelData(1)]));
```

Defaults: `mode: 'limiter'`; `ceiling: -1` dBTP (-96..0); `threshold: -24` dBFS (-96..0),
`knee: 6` dB (0..40), `ratio: 4` (1..100), `attack: 0.003` s (0..10), `release: 0.05` s
(0..10), `makeup: 0` dB (-24..24), `channels: 2` (integer 1..32), `signal` unset.
Threshold, knee, ratio and attack affect compressor mode. Release also smooths limiter recovery;
limiter attenuation is immediate when needed. Times are one-pole gain time constants; zero jumps.
Options are fixed. Input PCM must be finite. Disposal disconnects and stops owned processing.
Signal cancels module waiting, as for sidechain. AudioWorklet/CSP failures have a code and help link.

The ceiling is guaranteed for the ITU-R BS.1770-5 Annex 2 four-phase, 12-tap-per-phase FIR
reconstruction estimate and original samples, with an 11-sample lookahead. `latencyFrames` is 11;
`latency` is 11 / context.sampleRate seconds, excluding device/graph buffering. The absolute-sum
bound is conservative: it may reduce a signal already below its measured ceiling. No sample
clipping is used. The [proof and accepted difference](../../docs/architecture/mixer-true-peak.md)
explain why gain changes cannot escape that bound. This is not a promise about every DAC or codec.
`measureTruePeak(channels)` returns a linear peak, includes zero-padded boundaries, accepts 1..32
equal-length finite Float32Array channels, and is usable in Node without Web Audio. The FIR is the
published 48 kHz/4x design; other rates use the same relative reconstruction model, not separate
meter-certification profiles. Quiet input below the bound is an exact copy delayed by 11 samples.
WebGPU and WebGL2 use the same audio path, tested beside both in Edge. Generated signals prove
curve/envelope/ceiling; other browsers, real recordings, perceptual quality and speed are unmeasured.

## Early room reflections

`margoengine/mixer/reflections` (or `@margoengine/mixer/reflections`) combines six first-order
image-source wall reflections with the existing seeded late reverb tail. Geometry uses metres,
with width/height/depth along x/y/z. `roomReflections(options)` exposes arrival delay/gain per ear;
`roomImpulseResponse(sampleRate, options)` returns mono/stereo PCM; `createRoomReverb` returns
the usual disposable effect with input/output and wet/dry params.

```ts
import { createRoomReverb, roomReflections } from 'margoengine/mixer/reflections';
const context = new OfflineAudioContext(2, 144000, 48000);
using room = createRoomReverb(context, { room: [6,3,8], source: [1,1.5,2], listener: [3,1.5,5] });
const source = new ConstantSourceNode(context, { offset: 0.2 });
source.connect(room.input); room.output.connect(context.destination);
source.start(0); source.stop(0.05);
console.log(roomReflections().length); // 12: six paths for each of two ears
await context.startRendering();
```

Defaults and bounds: `room` [6,3,8], each 0.5..100 m; `source` [0.35*width,0.5*height,0.25*depth];
`listener` [0.6*width,0.5*height,0.7*depth]; positions and ears stay at least 0.01 m inside each wall.
`reflection` 0.7 (0..1 pressure coefficient); `channels` 2 (1 or 2); `earSpacing` 0.18 m (0..1,
stereo ears along x, ignored for mono); `speedOfSound` 343 m/s (200..400); late `seconds` 2
(0.05..20), `decay` seconds/2 (RT60, 0.01..20 s), `tailGain` 0.35 (0..1), integer `seed` 1
(0..4294967295), `mix` 0.25 (0..1). Pure PCM generation accepts integer sample rates 8000..192000.

Each wet arrival is delayed by (reflected path minus direct path) / speed, so the separate dry
signal stays undelayed. Gain is reflection / path length relative to one-metre source pressure;
close walls can boost the signal. Early gains are not normalized away. Fractional arrivals use
two adjacent samples with linear weights, preserving gain and delay centroid, with interpolation
colouration. The unit-energy noise tail starts 10 ms after the last early arrival, at least 30 ms
from input; total impulse length includes that offset plus the requested tail duration. `tailGain: 0`
omits noise and ends the buffer after the last reflection.

Static rectangular geometry, six specular paths only: no higher orders, diffraction, occlusion,
frequency-dependent absorption or HRTF/head rotation. Stereo models path differences, not binaural
head filtering. Recreate the effect when geometry changes. Convolution uses normalize=false and
can clip for loud inputs/close walls; lower levels or use the optional limiter. WebGPU and WebGL2
share the same audio graph, tested beside both in Edge. Missing Web Audio throws code `unsupported`
with a help link. Node geometry and real convolution use generated impulses, not measured rooms;
real room recordings, listening comparisons, other browsers and timing are unmeasured.

## LUFS loudness and normalisation

`margoengine/mixer/loudness` (or `@margoengine/mixer/loudness`) measures decoded PCM without
Web Audio or a renderer. `measureLoudness(channels, sampleRate = 48000)` applies the published
BS.1770 K-weighting, channel power weights and two-stage integrated gate. `normalizeLoudness`
returns new PCM arrays with a constant gain and measurements before/after; inputs stay unchanged.

```ts
import { measureLoudness, normalizeLoudness } from 'margoengine/mixer/loudness';
const rate = 48000;
const left = Float32Array.from({ length: rate * 4 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / rate));
const measured = measureLoudness([left, left], rate);
const adjusted = normalizeLoudness([left, left], rate, { target: -23, maxTruePeak: -1 });
console.log(measured.integrated, adjusted.after.integrated, adjusted.peakLimited);
```

Input is 1, 2 or 6 equal-length finite Float32Array channels. Six-channel order is Web Audio 5.1:
L, R, C, LFE, SL, SR; LFE is excluded from loudness, surrounds have 1.41 power weight, other
programme channels weight 1. True peak includes every channel, including LFE. Supported rates:
32000, 44100, 48000, 88200, 96000, 176400 and 192000 Hz. The 48 kHz filter coefficients are the
published tables; other rates bilinearly re-express that transfer function, with calibration tests.

Report fields: `integrated`, `momentary` (last full 400 ms window), `shortTerm` (last full 3 s
window), `maximumMomentary`, `maximumShortTerm`, `momentaryHistory` and `shortTermHistory`
(Float64Array LUFS, 10 ms step, first endpoint 0.4 s or 3 s), `blocks`, `gatedBlocks`, `duration`
and linear `truePeak`. Integrated uses 400 ms blocks every 100 ms, an absolute -70 LUFS gate
and a relative gate 10 LU below the absolute-gated mean. Incomplete windows are discarded.
Unavailable or silent loudness is -Infinity. True peak uses the optional worklet entry's published
four-phase FIR model, including zero-padded ends and original sample peaks, with no browser API.

Normalisation defaults: `target: -23` LUFS (above -70, at most 0), `maxTruePeak: -1` dBTP
(-96..0). Result fields: owned `channels`, applied `gainDb`, `peakLimited`, `before` and `after`.
The peak cap can prevent reaching the target. This is constant gain, with a float32 safety margin;
no compression or clipping. Absolute-gate membership may change after scaling; `after` reports
the achieved loudness. No complete block above the gate throws `MargoError` code `state` with
help link; use a measurable programme of at least 400 ms. This entry is synchronous PCM analysis,
not a file decoder, live AudioWorklet meter, UI, LRA implementation or EBU certification claim.
It stores 10 ms energy/history values and makes PCM copies for normalisation; large programmes
cost proportionate memory/CPU. WebGPU and WebGL2 use the same independent maths; real rendered
calibration and normalisation pass beside both in Edge. Generated EBU tone/offset cases are
stand-ins, not the downloaded compliance corpus or authentic programme recordings. Other
browsers, recorded programmes, full certification and performance are unmeasured.
