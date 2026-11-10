// Real Web Audio renders (OfflineAudioContext) checked against the package's own reference maths. Run by
// scripts/test-browser.js in headless Chrome.
import {
  Mixer,
  biquadCoefficients,
  biquadMagnitude,
  biquadProcess,
  dbToGain,
  gainToDb,
  impulseResponse,
  measure,
  renderOffline,
} from '@margoengine/mixer';
import { createSidechain } from '@margoengine/mixer/sidechain';
import { captureSnapshot, recallSnapshot } from '@margoengine/mixer/snapshots';
import { createDynamics, measureTruePeak } from '@margoengine/mixer/worklet';
import { createRoomReverb, roomImpulseResponse } from '@margoengine/mixer/reflections';
import { measureLoudness, normalizeLoudness } from '@margoengine/mixer/loudness';
import { createBusStereo } from '@margoengine/mixer/stereo';
import { createBusAnalyser } from '@margoengine/mixer/analyser';
import { createFX, createBusFX } from '@margoengine/mixer/fx';

const rate = 48000;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (a, b, tolerance, message) =>
  assert(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b} (tolerance ${tolerance})`);

function buffer(context, data) {
  const b = context.createBuffer(1, data.length, context.sampleRate);
  b.getChannelData(0).set(data);
  return b;
}
function play(context, data, loop = false) {
  const source = new AudioBufferSourceNode(context, { buffer: buffer(context, data), loop });
  source.start(0);
  return source;
}
const sine = (frequency, seconds, amplitude = 0.5) =>
  Float32Array.from(
    { length: Math.round(seconds * rate) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate),
  );
const constant = (seconds, value) => new Float32Array(Math.round(seconds * rate)).fill(value);
const impulse = (seconds) => {
  const data = new Float32Array(Math.round(seconds * rate));
  data[0] = 1;
  return data;
};
/** Mean level of the left channel between two times. */
const level = (rendered, from, to) => {
  const data = rendered.getChannelData(0);
  let sum = 0;
  const a = Math.round(from * rate),
    b = Math.round(to * rate);
  for (let i = a; i < b; i++) sum += data[i];
  return sum / (b - a);
};

async function chain(seconds, bus, input, setup) {
  return renderOffline(
    { seconds, sampleRate: rate, channels: 2, mixer: { buses: { x: bus } } },
    ({ context, mixer }) => {
      mixer.route(play(context, input), 'x');
      setup?.(mixer, context);
    },
  );
}

export async function runChecks() {
  const backend = new URL(location.href).searchParams.get('backend') ?? 'webgpu';
  let device;
  if (backend === 'webgpu') {
    const adapter = await navigator.gpu.requestAdapter();
    assert(adapter, 'WebGPU adapter is available beside Web Audio');
    device = await adapter.requestDevice();
  } else {
    const gl = document.createElement('canvas').getContext('webgl2');
    assert(gl, 'WebGL2 context is available beside Web Audio');
    gl.clear(gl.COLOR_BUFFER_BIT);
    assert(gl.getError() === gl.NO_ERROR, 'WebGL2 clear succeeds');
  }
  const checks = [];
  const check = async (name, fn) => {
    await fn();
    checks.push(name);
  };

  await check('equaliser bands match the biquad formulas (gain at 1 kHz, +6 dB bell)', async () => {
    const out = await chain(
      0.6,
      { effects: [{ type: 'eq', bands: [{ frequency: 1000, q: 1, gain: 6 }] }] },
      sine(1000, 0.6),
    );
    const { rms } = measure(out.getChannelData(0), 14400, 28800);
    near(gainToDb((rms * Math.SQRT2) / 0.5), 6, 0.05, 'peaking +6 dB at the centre');
  });

  await check('filters match the formulas across the spectrum (lowpass, highpass, shelf, notch)', async () => {
    const cases = [
      { filter: 'lowpass', frequency: 2000, q: -3.0103 },
      { filter: 'highpass', frequency: 500 },
      { filter: 'lowshelf', frequency: 300, gain: 7 },
      { filter: 'highshelf', frequency: 4000, gain: -6 },
      { filter: 'notch', frequency: 1200, q: 3 },
    ];
    for (const spec of cases) {
      for (const probe of [100, 1000, 3000, 9000]) {
        const out = await chain(0.5, { effects: [{ type: 'filter', ...spec }] }, sine(probe, 0.5, 0.4));
        const { rms } = measure(out.getChannelData(0), 12000, 24000);
        const c = biquadCoefficients(spec.filter, rate, spec.frequency, spec.q, spec.gain ?? 0);
        const expected = biquadMagnitude(c, probe, rate);
        near(
          gainToDb((rms * Math.SQRT2) / 0.4),
          gainToDb(expected),
          0.1 + (expected < 0.01 ? 6 : 0),
          `${spec.filter} at ${probe} Hz`,
        );
      }
    }
  });

  await check('an impulse through a lowpass matches the reference biquad sample by sample', async () => {
    const out = await chain(
      0.2,
      { effects: [{ type: 'filter', filter: 'lowpass', frequency: 3000, q: 4 }] },
      impulse(0.2),
    );
    const expected = biquadProcess(biquadCoefficients('lowpass', rate, 3000, 4), impulse(0.2));
    let worst = 0;
    const data = out.getChannelData(0);
    for (let i = 0; i < 4000; i++) worst = Math.max(worst, Math.abs(data[i] - expected[i]));
    assert(worst < 2e-5, `largest sample difference ${worst}`);
  });

  await check('delay echoes land on the exact samples with the feedback decay', async () => {
    const out = await chain(1.2, { effects: [{ type: 'delay', time: 0.25, feedback: 0.5, mix: 0.4 }] }, impulse(1.2));
    const data = out.getChannelData(0);
    near(data[0], 0.6, 1e-5, 'dry');
    near(data[12000], 0.4, 1e-5, 'first echo');
    near(data[24000], 0.2, 1e-5, 'second echo');
    near(data[36000], 0.1, 1e-5, 'third echo');
    near(data[6000], 0, 1e-6, 'between echoes');
  });

  await check('reverb of an impulse is the impulse response, and renders are bit-identical', async () => {
    const spec = { type: 'reverb', seconds: 0.4, decay: 0.2, mix: 1, seed: 7 };
    const a = await chain(0.6, { effects: [spec] }, impulse(0.6));
    const b = await chain(0.6, { effects: [spec] }, impulse(0.6));
    const reference = impulseResponse(rate, { seconds: 0.4, decay: 0.2, seed: 7 });
    let worst = 0;
    for (let ch = 0; ch < 2; ch++) {
      const got = a.getChannelData(ch);
      for (let i = 0; i < 19200; i++) worst = Math.max(worst, Math.abs(got[i] - reference[ch][i]));
    }
    assert(worst < 2e-4, `largest difference from the impulse response ${worst}`);
    for (let ch = 0; ch < 2; ch++)
      assert(
        a.getChannelData(ch).every((v, i) => v === b.getChannelData(ch)[i]),
        'two renders differ',
      );
  });

  await check('fader, mute and solo set the level', async () => {
    const run = (setup) =>
      renderOffline(
        { seconds: 0.3, sampleRate: rate, mixer: { buses: { music: { gain: -6 }, sfx: {} } } },
        ({ context, mixer }) => {
          mixer.route(play(context, constant(0.3, 0.5)), 'music');
          mixer.route(play(context, constant(0.3, 0.25)), 'sfx');
          setup(mixer);
        },
      );
    near(level(await run(() => {}), 0.1, 0.3), 0.5 * dbToGain(-6) + 0.25, 1e-4, 'sum of both buses');
    near(level(await run((m) => m.bus('music').setMuted(true)), 0.1, 0.3), 0.25, 1e-4, 'music muted');
    near(level(await run((m) => m.bus('sfx').setSolo(true)), 0.1, 0.3), 0.25, 1e-4, 'sfx soloed');
    near(
      level(await run((m) => m.master.setGain(-20)), 0.1, 0.3),
      (0.5 * dbToGain(-6) + 0.25) * 0.1,
      1e-4,
      'master -20 dB',
    );
  });

  await check('a send adds the aux path at the set gain', async () => {
    const out = await renderOffline(
      { seconds: 0.3, sampleRate: rate, mixer: { buses: { voice: {}, aux: { gain: -6 } } } },
      ({ context, mixer }) => {
        mixer.route(play(context, constant(0.3, 0.5)), 'voice');
        mixer.bus('voice').send('aux', { gain: -6 });
      },
    );
    near(level(out, 0.1, 0.3), 0.5 + 0.5 * dbToGain(-6) * dbToGain(-6), 1e-4, 'direct plus send');
  });

  await check('ducking follows the scheduled exponential attack and release on the audio clock', async () => {
    const out = await renderOffline(
      { seconds: 1.2, sampleRate: rate, mixer: { buses: { music: {} } } },
      ({ context, mixer }) => {
        mixer.route(play(context, constant(1.2, 0.5)), 'music');
        const duck = mixer.bus('music').duck({ amount: 12, attack: 0.04, at: 0.2 });
        duck.release({ at: 0.7, seconds: 0.2 });
      },
    );
    const floor = dbToGain(-12);
    near(level(out, 0.1, 0.19), 0.5, 1e-4, 'before the duck');
    const tc = 0.04 / 4;
    near(
      out.getChannelData(0)[Math.round((0.2 + tc) * rate)],
      0.5 * (floor + (1 - floor) * Math.exp(-1)),
      2e-3,
      'one time constant into the attack',
    );
    near(level(out, 0.45, 0.69), 0.5 * floor, 2e-3, 'held');
    near(level(out, 1.1, 1.2), 0.5, 2e-3, 'released');
  });

  await check('limiter and compressor reduce a loud sine; the limiter reduces more', async () => {
    const loud = sine(500, 0.6, 2);
    const raw = await chain(0.6, {}, loud);
    const limited = await chain(0.6, { effects: [{ type: 'limiter', ceiling: -6 }] }, loud);
    const squeezed = await chain(0.6, { effects: [{ type: 'compressor', threshold: -24, ratio: 4 }] }, loud);
    const peak = (b) => measure(b.getChannelData(0), 14400).peak;
    assert(peak(limited) < peak(raw) * 0.75, `limiter ${peak(limited)} vs raw ${peak(raw)}`);
    assert(peak(squeezed) < peak(raw) * 0.9, `compressor ${peak(squeezed)} vs raw ${peak(raw)}`);
    assert(peak(limited) < peak(squeezed), 'limiter reduces more than a 4:1 compressor');
  });

  await check('an emitter pans toward its side and falls off with distance', async () => {
    const render = (position) =>
      renderOffline({ seconds: 0.4, sampleRate: rate, mixer: { buses: { sfx: {} } } }, ({ context, mixer }) => {
        const emitter = mixer.emitter('sfx', { position, panningModel: 'equalpower', refDistance: 1 });
        play(context, constant(0.4, 0.5)).connect(emitter.input);
      });
    const left = await render([-4, 0, -4]),
      right = await render([4, 0, -4]);
    const L = (b) => level({ getChannelData: () => b.getChannelData(0) }, 0.1, 0.4),
      R = (b) => level({ getChannelData: () => b.getChannelData(1) }, 0.1, 0.4);
    assert(L(left) > R(left) * 2, `source on the left: L ${L(left)} R ${R(left)}`);
    near(L(left), R(right), 1e-4, 'mirror image');
    const near2 = await render([0, 0, -2]),
      far8 = await render([0, 0, -8]);
    near((L(near2) + R(near2)) / (L(far8) + R(far8)), 4, 0.1, 'inverse distance from 2 m to 8 m');
  });

  await check('an aborted render rejects with the signal reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    let message = '';
    try {
      await renderOffline({ seconds: 1, signal: controller.signal }, () => {});
    } catch (error) {
      message = error.message;
    }
    assert(message === 'stopped', `got "${message}"`);
  });

  await check('mixer works on a live AudioContext too (nodes build, ducks and gates schedule)', async () => {
    const context = new AudioContext();
    try {
      using mixer = new Mixer(context, {
        buses: { a: { effects: [{ type: 'reverb', seconds: 0.2 }, { type: 'limiter' }] } },
      });
      mixer.bus('a').setGain(-3).setMuted(true).setMuted(false);
      mixer
        .bus('a')
        .duck({ at: context.currentTime + 0.1 })
        .release({ at: context.currentTime + 0.2 });
      mixer.emitter('a', { position: [1, 0, 0] }).setPosition(2, 0, 0);
    } finally {
      await context.close();
    }
  });

  await check('automatic sidechain ducks only while the dialogue key is active, then recovers', async () => {
    const context = new OfflineAudioContext(2, rate, rate);
    using duck = await createSidechain(context, { amount: 20, attack: 0.01, release: 0.03, hold: 0.02 });
    using mixer = new Mixer(context, { buses: { music: {}, voice: {} } });
    play(context, constant(1, 0.5)).connect(duck.input);
    const key = constant(1, 0);
    key.fill(0.3, Math.round(rate * 0.2), Math.round(rate * 0.5));
    play(context, key).connect(duck.sidechain);
    duck.output.connect(mixer.bus('music').input);
    const out = await context.startRendering();
    near(level(out, 0.05, 0.15), 0.5, 1e-6, 'before voice');
    near(level(out, 0.35, 0.45), 0.05, 1e-5, 'ducked without key leaking');
    near(level(out, 0.9, 1), 0.5, 1e-5, 'released without a scheduling call');
    near(out.getChannelData(0)[Math.round(0.21 * rate)], 0.5 * (0.1 + 0.9 * Math.exp(-((0.01 * rate + 1) / (rate * 0.01)))), 2e-5, 'attack time constant');
    assert(out.getChannelData(0).every((v, i) => v === out.getChannelData(1)[i]), 'stereo gain is linked');
  });
  await check('snapshots fade music and underwater filter on the audio clock and restore them', async () => {
    const context = new OfflineAudioContext(2, rate, rate);
    using mixer = new Mixer(context, { buses: { music: { effects: [{ type: 'filter', filter: 'lowpass', frequency: 10000 }] } } });
    const music = mixer.bus('music');
    const clear = captureSnapshot(mixer);
    music.setGain(-20, { seconds: 0 });
    music.effects[0].params.frequency.value = 400;
    const underwater = JSON.parse(JSON.stringify(captureSnapshot(mixer)));
    recallSnapshot(mixer, clear, { seconds: 0 });
    recallSnapshot(mixer, underwater, { at: 0.2, seconds: 0.05 });
    recallSnapshot(mixer, clear, { at: 0.7, seconds: 0.05 });
    play(context, sine(1000, 1)).connect(music.input);
    const out = await context.startRendering();
    const data = out.getChannelData(0);
    const rms = (a, b) => measure(data, Math.round(a * rate), Math.round(b * rate)).rms;
    assert(rms(0.4, 0.6) < rms(0.05, 0.15) * 0.025, 'underwater snapshot lowers and lowpasses');
    near(rms(0.9, 1), rms(0.05, 0.15), 1e-4, 'clear snapshot restores sound');
    const mid = rms(0.21, 0.22);
    assert(mid > rms(0.4, 0.6) && mid < rms(0.05, 0.15), 'intermediate mix is a fade');
  });
  await check('exact worklet compressor uses its fixed curve, and limiter contains inter-sample peaks', async () => {
    const render = async (data, settings) => {
      const context = new OfflineAudioContext(2, data.length + 128, rate);
      using stage = await createDynamics(context, settings);
      play(context, data).connect(stage.input);
      stage.output.connect(context.destination);
      // Await before leaving the using scope so the stage survives the render.
      return await context.startRendering();
    };
    const compressed = await render(constant(0.1, 0.25), { mode: 'compressor', threshold: -24, knee: 0, ratio: 4, attack: 0, release: 0, ceiling: 0 });
    const expected = dbToGain(-24 + (20 * Math.log10(0.25) + 24) / 4);
    near(compressed.getChannelData(0)[1000], expected, 3e-8, 'fixed compressor curve, no native make-up');
    const loud = Float32Array.from({ length: 12000 }, (_, i) => 3 * Math.sin(Math.PI * i / 2 + Math.PI / 4));
    assert(measureTruePeak([loud]) > measure(loud).peak * 1.38, 'fixture has inter-sample overs');
    const limited = await render(loud, { ceiling: -6, release: 0.02 });
    const peak = measureTruePeak([limited.getChannelData(0), limited.getChannelData(1)]);
    assert(peak <= dbToGain(-6), `true peak ${peak} exceeds ceiling`);
    assert(peak > 0.05, 'limiter is audible');
    assert(limited.getChannelData(0).slice(0, 11).every((v) => v === 0), '11-sample lookahead');
  });
  await check('room early reflections and seeded late tail render as the computed stereo impulse', async () => {
    const context = new OfflineAudioContext(2, 12000, rate);
    const settings = { room: [6,3,8], source: [1,1.5,2], listener: [3,1.5,5], seconds: 0.1, mix: 1, seed: 17 };
    using reverb = createRoomReverb(context, settings);
    play(context, impulse(0.25)).connect(reverb.input);
    reverb.output.connect(context.destination);
    const out = await context.startRendering();
    const reference = roomImpulseResponse(rate, settings);
    for (let c = 0; c < 2; c++) {
      let worst = 0;
      for (let i = 0; i < reference[c].length; i++) worst = Math.max(worst, Math.abs(out.getChannelData(c)[i] - reference[c][i]));
      assert(worst < 2e-5, `convolution error ${worst}`);
      assert(measure(out.getChannelData(c), 0, Math.round(0.03 * rate)).peak > 0.01, 'discrete early arrivals precede the tail');
    }
  });
  await check('LUFS measures real rendered stereo calibration audio and normalises it by gain', async () => {
    const context = new OfflineAudioContext(2, rate * 4, rate);
    play(context, sine(1000, 4, dbToGain(-23))).connect(context.destination);
    const buffer = await context.startRendering();
    const pcm = [buffer.getChannelData(0), buffer.getChannelData(1)];
    const report = measureLoudness(pcm, rate);
    for (const field of ['integrated', 'momentary', 'shortTerm']) near(report[field], -23, 0.1, `EBU calibration ${field}`);
    const adjusted = normalizeLoudness(pcm, rate, { target: -20 });
    near(adjusted.after.integrated, -20, 1e-5, 'normalised LUFS');
    assert(!adjusted.peakLimited, 'ordinary target is reachable by gain');
    assert(adjusted.after.truePeak <= dbToGain(-1), 'normalisation respects its peak cap');
  });
  await check('bus stereo follows normalized mid/side width and the specified equal-power stereo pan', async () => {
    for (const width of [0, 0.25, 0.5, 0.75, 1]) for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const context = new OfflineAudioContext(2, 128, rate);
      using mixer = new Mixer(context, { buses: { x: {} } });
      using stage = createBusStereo(mixer.bus('x'), { width, pan });
      const b = context.createBuffer(2, 128, rate);
      b.getChannelData(0).fill(0.2); b.getChannelData(1).fill(-0.1);
      const source = new AudioBufferSourceNode(context, { buffer: b });
      source.connect(mixer.bus('x').input); source.start();
      const out = await context.startRendering();
      const l = 0.2 + (1 - 2 * width) * -0.1, r = -0.1 + (1 - 2 * width) * 0.2;
      const x = pan <= 0 ? pan + 1 : pan;
      const expected = pan <= 0 ? [l + r * Math.cos(x * Math.PI / 2), r * Math.sin(x * Math.PI / 2)]
        : [l * Math.cos(x * Math.PI / 2), r + l * Math.sin(x * Math.PI / 2)];
      for (let c = 0; c < 2; c++) near(out.getChannelData(c)[64], expected[c], 1e-7, `width ${width}, pan ${pan}, channel ${c}`);
    }
  });
  await check('live bus analysis keeps anti-phase stereo, FFT bins, waveform and audio-clock RMS/LUFS', async () => {
    const context = new OfflineAudioContext(2, rate * 4, rate);
    using mixer = new Mixer(context, { buses: { x: {} } });
    using stage = await createBusAnalyser(mixer.bus('x'), { fftSize: 2048, smoothing: 0 });
    const b = context.createBuffer(2, rate * 4, rate);
    const signal = sine(750, 4, 0.1);
    b.getChannelData(0).set(signal); b.getChannelData(1).set(signal.map(v => -v));
    const source = new AudioBufferSourceNode(context, { buffer: b }); source.connect(mixer.bus('x').input); source.start();
    const reported = new Promise(resolve => stage.output.port.addEventListener('message', e => {
      if (e.data.frames >= rate * 4) resolve();
    }));
    const suspended = context.suspend(0.25);
    const rendered = context.startRendering();
    await suspended;
    for (let c = 0; c < 2; c++) {
      const spectrum = stage.spectrum(c), waveform = stage.waveform(c);
      const max = spectrum.reduce((best, v, i) => v > spectrum[best] ? i : best, 0);
      near(stage.frequency(max), 750, 0, 'per-channel FFT retains anti-phase tone');
      near(measure(waveform).peak, 0.1, 1e-7, 'waveform peak');
    }
    await context.resume(); const out = await rendered; await reported;
    const reading = stage.read(), reference = measureLoudness([signal, signal.map(v => -v)], rate);
    near(reading.rms[0], 0.1 / Math.sqrt(2), 1e-7, 'live RMS');
    near(reading.momentary, reference.momentary, 1e-6, 'live momentary LUFS');
    near(reading.shortTerm, reference.shortTerm, 1e-6, 'live short-term LUFS');
    for (let c = 0; c < 2; c++) assert(out.getChannelData(c).every((v, i) => v === b.getChannelData(c)[i]), 'analysis output preserves samples');
  });
  await check('JSON modulation and colour effects render analytic signals on the audio thread', async () => {
    for (const spec of [{type:'chorus',depth:0,time:0.01,mix:1}, {type:'flanger',depth:0,time:0.001,mix:1},
      {type:'vibrato',depth:0,time:0.005,mix:1}, {type:'phaser',depth:0,mix:0}, {type:'auto-filter',mix:0},
      {type:'tremolo',rate:0,phase:90,depth:1,spread:0}, {type:'bitcrusher',bits:4},
      {type:'auto-pan',rate:0,phase:90,depth:1}]) {
      const context = new OfflineAudioContext(2, 4800, rate);
      using mixer = new Mixer(context);
      using stage = await createBusFX(mixer.master, JSON.parse(JSON.stringify([spec])));
      play(context,constant(.1,.3)).connect(mixer.master.input);
      const out = await context.startRendering();
      const expected = spec.type==='bitcrusher'?.25:spec.type==='auto-pan'?.6:.3;
      near(out.getChannelData(spec.type==='auto-pan'?1:0)[3000],expected,1e-6,`${spec.type} wet signal`);
      if(spec.type==='auto-pan')near(out.getChannelData(0)[3000],0,1e-7,'auto-pan left');
    }
    for (const oversample of ['none','2x','4x']) {
      const context = new OfflineAudioContext(1, 4800, rate);
      using stage = await createFX(context,{type:'distortion',amount:.4,oversample});
      play(context,constant(.1,.25)).connect(stage.input);stage.output.connect(context.destination);
      const out = await context.startRendering();
      near(out.getChannelData(0)[3000],41*.25/(1+40*.25),1e-5,`rational distortion ${oversample}`);
    }
    const context = new OfflineAudioContext(1, 4800, rate);
    using shaper = await createFX(context,{type:'waveshaper',curve:[-1,0,1]});
    const data=sine(1000,.1,.2);play(context,data).connect(shaper.input);shaper.output.connect(context.destination);
    const out = await context.startRendering();
    out.getChannelData(0).forEach((v,i)=>near(v,data[i],1e-7,'authored identity curve'));
  });
  device?.destroy();
  return { checks, backend };
}
window.runChecks = runChecks;
