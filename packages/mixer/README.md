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
- **Mute and solo**: `bus.setMuted(true)`, `bus.setSolo(true)`. While anything is soloed, only soloed buses, their ancestors (which carry the sound on), their descendants (which feed them) and `soloSafe` buses such as reverb returns stay audible. `audibleBuses(states)` is that rule as a pure function.
- **Sends**: `bus.send(other, {gain, pre})` copies part of a bus to another (after the gate by default, so muting the bus mutes the send; `pre` taps before the fader). A send that would make a loop throws `RangeError`.
- **Ducking**: `bus.duck({amount, attack, at})` lowers a bus and returns a handle; `handle.release({at, seconds})` brings it back. Overlapping ducks hold the deepest one. You decide when to duck (when a voice starts); there is no automatic sidechain.
- **Routing**: `mixer.route(source, bus)` connects an AudioNode, or anything with `getOutput()` such as `Audio` and `PositionalAudio` from `margoengine/audio`, to a bus after removing its other connections. Configure the sound's filters first.
- **Scheduling** uses AudioContext time: every `at` is `context.currentTime` seconds (default now), and `mixer.now` reads the clock.
- `bus.peak()` reads the current output peak (it adds an AnalyserNode on first use).

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

Filter `q` follows the Web Audio specification: decibels of resonance for `lowpass` and `highpass` (default -3.01, a Butterworth response), a plain quality factor for the rest. A bad value throws `RangeError`, a wrong type `TypeError`. Every effect has `input`, `output`, named `params` you can automate, `dispose()` and `using` support; delay and reverb also have `setMix(0..1, at)`.

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

- Compressor and limiter use the browser's DynamicsCompressorNode. The Web Audio specification leaves its curve to the browser and adds an automatic make-up gain, so results differ between browsers; the limiter lowers peaks hard but is not a sample-accurate brick wall. `compressorCurve` is a design aid, not a model of the node.
- Web Audio cannot be interrupted mid-render: an aborted `renderOffline` rejects when the render ends and drops the result.
- Web Audio cannot loop faster than 128 samples (2.7 ms at 48 kHz), so that is the shortest delay `time`, and it is fixed when the effect is created; build a new effect to change it.
- Ducking is scheduled by you; nothing listens to a bus and ducks another automatically.
- The reverb is a synthetic noise tail (no early reflections) unless you give it a recorded impulse. It runs on the audio thread as a convolution, so a long `seconds` costs CPU.
- Offline checks run in a browser (`npm run test:browser` in this package). The Node tests cover the maths and the graph wiring and scheduling through a fake context, not rendered sound.

Apache-2.0. Optional, tree-shakable package; no core dependency.

Build and unit tests: npm test --workspace @margoengine/mixer
