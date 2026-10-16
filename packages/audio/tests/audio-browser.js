import { Engine, PbrMaterial, box } from '@margoengine/core';
import {
  AudioListener,
  Audio,
  PositionalAudio,
  AudioAnalyser,
  loadAudioBuffer,
  distanceGain,
  coneGain,
} from '@margoengine/audio';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitAudioTime = async (context, seconds) => {
  const until = context.currentTime + seconds,
    deadline = performance.now() + 4000;
  while (context.currentTime < until) {
    assert(
      performance.now() < deadline,
      `Audio clock did not advance to ${until}: ${context.currentTime} (${context.state})`,
    );
    await sleep(10);
  }
};
const rate = 48000;

function noise(context, seconds) {
  const buffer = context.createBuffer(1, Math.round(seconds * context.sampleRate), context.sampleRate),
    data = buffer.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data[i] = (seed / 4294967296) * 2 - 1;
  }
  return buffer;
}
function constant(context, seconds, value = 0.5) {
  const buffer = context.createBuffer(1, Math.round(seconds * context.sampleRate), context.sampleRate);
  buffer.getChannelData(0).fill(value);
  return buffer;
}
function sine(context, seconds, frequency) {
  const buffer = context.createBuffer(1, Math.round(seconds * context.sampleRate), context.sampleRate),
    data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * frequency * i) / context.sampleRate) * 0.8;
  return buffer;
}
/** RMS of each channel over the second half of the render (past any start-up smoothing). */
function rms(rendered) {
  return [0, 1].map((channel) => {
    const data = rendered.getChannelData(channel),
      start = data.length >> 1;
    let total = 0;
    for (let i = start; i < data.length; i++) total += data[i] * data[i];
    return Math.sqrt(total / (data.length - start));
  });
}
async function renderPositional({ buffer, seconds = 0.25, position, direction, options }) {
  const context = new OfflineAudioContext(2, Math.round(seconds * rate), rate);
  const listener = new AudioListener({ context, autoResume: false });
  listener.setPose([0, 0, 0], [0, 0, -1]);
  const audio = new PositionalAudio(listener, options);
  if (direction) audio.setDirection(direction);
  audio.setPosition(...position);
  audio.setBuffer(buffer(context, seconds)).play();
  const rendered = await context.startRendering();
  listener.dispose();
  return rms(rendered);
}
function wav(samples, sampleRate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2),
    view = new DataView(bytes);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(sample * 32767), true));
  return new Blob([bytes], { type: 'audio/wav' });
}

window.runOfflineTests = async () => {
  const checks = [],
    measurements = {};
  // Left/right: a source on the listener's right (+X when facing -Z) is louder in the right channel.
  for (const panningModel of ['HRTF', 'equalpower']) {
    const right = await renderPositional({ buffer: noise, position: [3, 0, 0], options: { panningModel } });
    const left = await renderPositional({ buffer: noise, position: [-3, 0, 0], options: { panningModel } });
    measurements[panningModel] = { right, left };
    assert(right[1] > right[0] * 2, `${panningModel}: source on the right is not louder on the right ${right}`);
    assert(left[0] > left[1] * 2, `${panningModel}: source on the left is not louder on the left ${left}`);
  }
  checks.push('HRTF and equal-power: a source on the right is louder in the right channel (and mirrored)');

  // Distance attenuation per model, relative to the gain at refDistance.
  measurements.distance = {};
  for (const distanceModel of ['linear', 'inverse', 'exponential']) {
    const options = {
      panningModel: 'equalpower',
      distanceModel,
      refDistance: 1,
      maxDistance: 10,
      rolloffFactor: distanceModel === 'linear' ? 1 : 1.5,
    };
    const level = async (distance) =>
      (await renderPositional({ buffer: constant, seconds: 0.1, position: [0, 0, -distance], options })).reduce(
        (a, b) => a + b,
      );
    const reference = await level(1),
      rows = [];
    for (const distance of [2, 4, 7]) {
      const measured = (await level(distance)) / reference,
        expected = distanceGain(distanceModel, distance, 1, 10, options.rolloffFactor);
      rows.push({ distance, measured, expected });
      assert(
        near(measured, expected, 0.01 + expected * 0.02),
        `${distanceModel} at ${distance}: ${measured} vs ${expected}`,
      );
    }
    measurements.distance[distanceModel] = rows;
  }
  checks.push('Distance attenuation follows the linear, inverse and exponential models within 2%');

  // Cone: inner 60, outer 120, outer gain 0.1. The source at z=-5 faces the listener or faces away.
  const cone = { panningModel: 'equalpower', coneInnerAngle: 60, coneOuterAngle: 120, coneOuterGain: 0.1 };
  const front = (
    await renderPositional({
      buffer: constant,
      seconds: 0.1,
      position: [0, 0, -5],
      direction: [0, 0, 1],
      options: cone,
    })
  ).reduce((a, b) => a + b);
  const behind = (
    await renderPositional({
      buffer: constant,
      seconds: 0.1,
      position: [0, 0, -5],
      direction: [0, 0, -1],
      options: cone,
    })
  ).reduce((a, b) => a + b);
  const side = (
    await renderPositional({
      buffer: constant,
      seconds: 0.1,
      position: [0, 0, -5],
      direction: [Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)],
      options: cone,
    })
  ).reduce((a, b) => a + b);
  measurements.cone = {
    front,
    behind,
    side,
    expectedSide: coneGain([0, 0, -5], [Math.SQRT1_2, 0, Math.SQRT1_2], [0, 0, 0], 60, 120, 0.1),
  };
  assert(near(behind / front, 0.1, 0.005), `Cone gain behind the source ${behind / front}`);
  assert(
    near(side / front, measurements.cone.expectedSide, 0.02),
    `Cone gain at 45 degrees ${side / front} vs ${measurements.cone.expectedSide}`,
  );
  checks.push('The cone reduces gain behind the source to coneOuterGain and interpolates between the cones');

  // Analyser on a 1 kHz tone, read mid-render through OfflineAudioContext.suspend.
  {
    const context = new OfflineAudioContext(2, rate / 2, rate),
      listener = new AudioListener({ context, autoResume: false });
    const audio = new Audio(listener),
      analyser = new AudioAnalyser(audio, { fftSize: 2048, smoothingTimeConstant: 0 });
    audio.setBuffer(sine(context, 0.5, 1000)).play();
    let reading;
    context.suspend(0.25).then(() => {
      reading = {
        dominant: analyser.getDominantFrequency(),
        average: analyser.getAverageFrequency(),
        waveform: Math.max(...analyser.getFloatWaveformData().map(Math.abs)),
        bytes: analyser.getWaveformData().length,
      };
      void context.resume();
    });
    await context.startRendering();
    measurements.analyser = reading;
    assert(near(reading.dominant, 1000, rate / 2048), `Analyser dominant frequency ${reading.dominant}`);
    assert(
      reading.average > 0 && near(reading.waveform, 0.8, 0.02) && reading.bytes === 2048,
      `Analyser data ${JSON.stringify(reading)}`,
    );
  }
  checks.push('Analyser reports the dominant frequency, a nonzero average and the waveform peak');

  // Offset, duration and loop points render where expected (a ramp buffer encodes the read position).
  {
    const seconds = 0.3,
      context = new OfflineAudioContext(1, seconds * rate, rate),
      listener = new AudioListener({ context, autoResume: false });
    const ramp = context.createBuffer(1, rate, rate);
    ramp.getChannelData(0).forEach((_, i, data) => {
      data[i] = i / rate;
    });
    const audio = new Audio(listener, { loop: true, loopStart: 0.5, loopEnd: 0.6, offset: 0.55 });
    audio.setBuffer(ramp).play();
    const out = (await context.startRendering()).getChannelData(0);
    // The master and volume gains are 1, so samples equal the source position in seconds.
    assert(
      near(out[0], 0.55, 1e-3) && near(out[Math.round(0.07 * rate)], 0.52, 2e-3),
      `Loop points ${out[0]} ${out[Math.round(0.07 * rate)]}`,
    );
    const context2 = new OfflineAudioContext(1, seconds * rate, rate),
      listener2 = new AudioListener({ context: context2, autoResume: false });
    let ended = 0;
    new Audio(listener2, { offset: 0.2, duration: 0.1, onEnded: () => ended++ }).setBuffer(ramp).play();
    const out2 = (await context2.startRendering()).getChannelData(0);
    for (let i = 0; i < 50 && !ended; i++) await sleep(10);
    assert(
      near(out2[10], 0.2 + 10 / rate, 1e-4) && out2[Math.round(0.15 * rate)] === 0 && ended === 1,
      `Offset/duration ${out2[10]} ${out2[Math.round(0.15 * rate)]} ended=${ended}`,
    );
  }
  checks.push('Offset, duration and loop points select the right samples; onEnded fires at the natural end');

  // Fade-in ramp from silence.
  {
    const context = new OfflineAudioContext(1, rate * 0.2, rate),
      listener = new AudioListener({ context, autoResume: false });
    new Audio(listener).setBuffer(constant(context, 0.2, 1)).fadeIn(0.1);
    const out = (await context.startRendering()).getChannelData(0);
    measurements.fade = [out[0], out[Math.round(0.05 * rate)], out[Math.round(0.15 * rate)]];
    assert(
      near(out[0], 0, 0.01) &&
        near(out[Math.round(0.05 * rate)], 0.5, 0.02) &&
        near(out[Math.round(0.15 * rate)], 1, 1e-3),
      `Fade-in ${measurements.fade}`,
    );
  }
  checks.push('fadeIn ramps linearly from silence');
  return { checks, measurements };
};

window.runEngineTests = async () => {
  const checks = [],
    canvas = document.getElementById('view');
  const engine = await Engine.create(canvas, { camera: { position: [0, 1, 6], target: [0, 1, 0] } });
  const gpuErrors = [];
  engine.gpu?.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  const listener = new AudioListener({ smoothing: 0.01 });
  engine.use(listener);
  assert(!listener.hasContext, 'Attaching the listener must not create an AudioContext');
  const context = listener.context;
  if (context.state !== 'running') await listener.resume();
  assert(context.state === 'running', `Context state ${context.state}`);
  const mesh = engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: [0.8, 0.3, 0.2] }))
    .setPosition([2, 0, -1]);
  const audio = new PositionalAudio(listener, { mesh, muteWhenHidden: true, panningModel: 'equalpower' });
  audio.setNodeSource(new ConstantSourceNode(context, { offset: 0.1 })).play();
  audio.source.start();
  const analyser = new AudioAnalyser(audio, 256);
  engine.render();
  const l = context.listener;
  const read = () => ({
    position: [l.positionX.value, l.positionY.value, l.positionZ.value],
    forward: [l.forwardX.value, l.forwardY.value, l.forwardZ.value],
    up: [l.upX.value, l.upY.value, l.upZ.value],
  });
  await sleep(60);
  let pose = read();
  assert(
    pose.position.every((v, i) => near(v, [0, 1, 6][i], 1e-5)) &&
      pose.forward.every((v, i) => near(v, [0, 0, -1][i], 1e-5)) &&
      near(pose.up[1], 1, 1e-6),
    `Initial listener pose ${JSON.stringify(pose)}`,
  );
  engine.camera.position = [6, 3, 0];
  engine.camera.target = [0, 3, 0];
  mesh.setPosition([-1, 2, 4]);
  engine.render();
  assert(
    [...listener.position].join() === '6,3,0' && [...listener.forward].join() === '-1,0,0',
    'Listener did not take the new camera pose this frame',
  );
  await waitAudioTime(context, 0.25);
  pose = read();
  assert(
    pose.position.every((v, i) => near(v, [6, 3, 0][i], 1e-3)) &&
      pose.forward.every((v, i) => near(v, [-1, 0, 0][i], 1e-3)),
    `Listener did not follow the camera ${JSON.stringify(pose)}`,
  );
  const p = audio.panner;
  assert(
    near(p.positionX.value, -1, 1e-3) && near(p.positionY.value, 2, 1e-3) && near(p.positionZ.value, 4, 1e-3),
    `Panner did not follow the mesh ${p.positionX.value},${p.positionY.value},${p.positionZ.value}`,
  );
  checks.push(
    'Live engine: the listener follows the camera (position, forward to target, Y up) and the panner follows its mesh',
  );
  assert(
    analyser.getFloatWaveformData().some((v) => Math.abs(v) > 1e-3),
    'Positional sound is silent before hiding',
  );
  mesh.visible = false;
  engine.render();
  await waitAudioTime(context, 0.2);
  assert(
    audio.isMuted && audio.gain.gain.value < 1e-3 && analyser.getFloatWaveformData().every((v) => Math.abs(v) < 1e-3),
    `Hidden mesh did not mute: ${audio.gain.gain.value}`,
  );
  mesh.visible = true;
  engine.render();
  await waitAudioTime(context, 0.2);
  assert(!audio.isMuted && near(audio.gain.gain.value, 1, 1e-3), 'Showing the mesh did not unmute');
  checks.push('muteWhenHidden silences the sound smoothly while the mesh is hidden');

  // Loader with a real decode and cache, plus a media element source with onEnded.
  const samples = Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10) * 0.5);
  const url = URL.createObjectURL(wav(samples, 48000));
  const [a, b] = await Promise.all([listener.load(url), loadAudioBuffer(context, url)]);
  assert(a === b && near(a.duration, 0.1, 1e-3), `Decoded buffer ${a.duration}`);
  const aborted = new AbortController();
  aborted.abort();
  let abortName = '';
  await loadAudioBuffer(context, url + '#x', { signal: aborted.signal }).catch((error) => {
    abortName = error.name;
  });
  assert(abortName === 'AbortError', 'Aborted load did not reject with AbortError');
  const element = document.createElement('audio');
  element.src = url;
  const ended = new Promise((resolve, reject) => {
    const media = new Audio(listener, { onEnded: resolve });
    media.setMediaElementSource(element).play();
    setTimeout(() => reject(new Error('Media element onEnded did not fire')), 4000);
  });
  await ended;
  checks.push('loadAudioBuffer decodes and caches; AbortSignal rejects; media element sources play and report onEnded');

  assert(gpuErrors.length === 0, `WebGPU errors: ${gpuErrors.join('; ')}`);
  engine.dispose();
  await sleep(50);
  assert(context.state === 'closed', 'Disposing the engine did not close the listener-owned context');
  checks.push('Engine dispose removes the plugin and closes the owned context; zero WebGPU validation errors');
  return { checks, backend: engine.backend };
};

let gestureListener, gestureEngine;
window.prepareGesture = async () => {
  gestureEngine = await Engine.create(document.getElementById('view'));
  gestureListener = new AudioListener();
  gestureEngine.use(gestureListener);
  const context = gestureListener.context;
  if (context.state !== 'running') await context.resume();
  await gestureListener.suspend();
  return context.state;
};
window.checkGesture = async () => {
  for (let i = 0; i < 50 && gestureListener.context.state !== 'running'; i++) await sleep(10);
  const state = gestureListener.context.state;
  gestureEngine.dispose();
  return state;
};
