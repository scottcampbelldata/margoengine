import { AudioListener, PositionalAudio, AudioAnalyser } from '../../packages/audio/dist/index.js';
import { controls } from './ui-scene.js';

export function createWorkload(count = 4, options = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new RangeError('Audio source count must be 1..9');
  options.signal?.throwIfAborted();
  const points = new Float32Array(count * 4),
    sounds = [],
    analysers = [];
  let context,
    listener,
    audio,
    ui,
    button,
    time = 0,
    frames = 0,
    enabled = false,
    disposed = false,
    analyserReads = 0,
    average = 0,
    dominantHz = 0,
    setupCpuMilliseconds = 0,
    playbackError = null;
  const status = () => {
    if (button) {
      button.textContent = enabled ? 'Disable sound' : 'Enable sound';
      button.setAttribute('aria-pressed', String(enabled));
    }
  };
  const silence = () => {
    enabled = false;
    if (listener) {
      listener.volume = 0;
      void listener.suspend().catch((error) => {
        if (!disposed) playbackError = String(error.message).slice(0, 160);
      });
    }
    status();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    analysers.forEach((analyser) => analyser.dispose());
    if (listener) context?.engine.removePlugin(listener.name);
    ui?.dispose();
    context = null;
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  const step = (delta) => {
    if (disposed) return;
    if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid audio frame delta');
    time += delta;
    frames++;
    if (analysers[0]) {
      average = analysers[0].getAverageFrequency();
      dominantHz = analysers[0].getDominantFrequency();
      analyserReads++;
    }
    for (let i = 0; i < count; i++) {
      const angle = time * 0.45 + (i * Math.PI * 2) / count;
      points[i * 4] = Math.cos(angle) * 2;
      points[i * 4 + 1] = 0.5 + average / 255;
      points[i * 4 + 2] = Math.sin(angle) * 2;
      points[i * 4 + 3] = i % 3;
    }
  };
  step(0);
  return {
    points,
    sounds,
    get listener() {
      return listener;
    },
    bounds: { min: [-2.5, 0, -2.5], max: [2.5, 1.8, 2.5] },
    description:
      'Actual positional Web Audio sources follow the moving cube emitters through the package listener pass, with inverse-distance/cone attenuation and retained FFT analysis. Buffers contain generated loop tones, not decoded files. Sound stays silent until Enable sound; cube heights show the first source analyser. Listener/panner updates are included in render CPU; audio DSP executes outside synchronous JS.',
    step,
    pause: silence,
    mount(value) {
      if (disposed) throw new Error('Audio workload is disposed');
      if (context) throw new Error('Audio workload is already mounted');
      context = value;
      const start = performance.now();
      try {
        listener = new AudioListener({ volume: 0, autoResume: false });
        value.engine.use(listener);
        audio = listener.context;
        for (let i = 0; i < count; i++) {
          const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate / 2), audio.sampleRate),
            samples = buffer.getChannelData(0),
            frequency = 220 + i * 40;
          for (let sample = 0; sample < samples.length; sample++)
            samples[sample] = Math.sin((sample * Math.PI * 2 * frequency) / audio.sampleRate);
          const sound = new PositionalAudio(listener, {
            mesh: value.meshes[i],
            loop: true,
            volume: 0.4 / count,
            refDistance: 3,
            rolloffFactor: 0.5,
            coneInnerAngle: 120,
            coneOuterAngle: 300,
            coneOuterGain: 0.5,
            muteWhenHidden: true,
          });
          sounds.push(sound);
          sound.setBuffer(buffer).play();
          analysers.push(new AudioAnalyser(sound, 1024));
        }
        ui = controls(value.parent, count, () => {});
        ui.actor.parentElement.remove();
        button = ui.button('Enable sound', async () => {
          if (disposed) return;
          if (enabled) {
            silence();
            return;
          }
          try {
            await listener.resume();
            if (disposed) return;
            enabled = audio.state === 'running';
            listener.volume = enabled ? 0.25 : 0;
            status();
          } catch (error) {
            if (!disposed) playbackError = String(error.message).slice(0, 160);
          }
        });
        button.dataset.uiAudio = '';
        status();
        setupCpuMilliseconds = performance.now() - start;
      } catch (error) {
        dispose();
        throw error;
      }
    },
    details: () => ({
      sources: sounds.length,
      playingSources: sounds.filter((sound) => sound.isPlaying).length,
      frames,
      analyserReads,
      averageFrequencyByte: average,
      dominantHz,
      enabled,
      contextState: audio?.state ?? 'uninitialized',
      contextSeconds: audio?.currentTime ?? null,
      firstSourceX: sounds[0]?.worldPosition[0] ?? null,
      firstSourceZ: sounds[0]?.worldPosition[2] ?? null,
      fftSize: 1024,
      generatedToneHz: 220,
      setupCpuMilliseconds,
      playbackError,
    }),
    dispose,
  };
}
