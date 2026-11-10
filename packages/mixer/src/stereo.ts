/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { bounded } from './worklet-host.js';
import type { Bus, RampOptions } from './mixer.js';

/** Stereo settings. Width follows the normalized mid/side convention: 0 mid, 0.5 unchanged, 1 side. */
export interface StereoOptions {
  /** Equal-power pan, -1 left to 1 right, default 0. */
  pan?: number;
  /** Mid/side width 0..1, default 0.5. Extreme settings can require headroom. */
  width?: number;
}

/** Native audio-clock stereo stage, with independently automatable controls. */
export interface StereoStage extends Disposable {
  /** Speaker-layout stereo input (mono is duplicated). */
  readonly input: GainNode;
  /** Equal-power stereo output after width. */
  readonly output: StereoPannerNode;
  /** Native -1..1 panning AudioParam. */
  readonly pan: AudioParam;
  /** Normalized width AudioParam; schedule values in 0..1. */
  readonly width: AudioParam;
  /** Schedule pan with optional exponential fade, default immediate. */
  setPan(value: number, options?: RampOptions): void;
  /** Schedule width with optional exponential fade, default immediate. */
  setWidth(value: number, options?: RampOptions): void;
  /** Disconnect and stop owned controls. Idempotent. */
  dispose(): void;
}

/** Create a sum/difference width matrix followed by the specified Web Audio stereo panning law. */
export function createStereo(context: BaseAudioContext, options: StereoOptions = {}): StereoStage {
  const pan = bounded(options.pan ?? 0, -1, 1, 'Stereo pan');
  const width = bounded(options.width ?? 0.5, 0, 1, 'Stereo width');
  const input = context.createGain(), split = context.createChannelSplitter(2), merge = context.createChannelMerger(2);
  input.channelCount = 2; input.channelCountMode = 'explicit';
  const output = context.createStereoPanner(), control = context.createConstantSource(), scale = context.createGain();
  const cross = [context.createGain(), context.createGain()];
  output.pan.value = pan; control.offset.value = width; scale.gain.value = -2;
  input.connect(split); control.connect(scale);
  for (let c = 0; c < 2; c++) {
    split.connect(merge, c, c);
    split.connect(cross[c], c);
    cross[c].gain.value = 1;
    scale.connect(cross[c].gain);
    cross[c].connect(merge, 0, 1 - c);
  }
  merge.connect(output); control.start();
  let disposed = false;
  const schedule = (param: AudioParam, value: number, low: number, high: number, opts: RampOptions = {}) => {
    if (disposed) throw new MargoError('disposed', 'Stereo stage is disposed; create a new stereo stage');
    bounded(value, low, high, 'Stereo control');
    const at = bounded(opts.at ?? context.currentTime, context.currentTime, Number.MAX_VALUE, 'Stereo time');
    const seconds = bounded(opts.seconds ?? 0, 0, 3600, 'Stereo fade');
    param.cancelScheduledValues(at);
    if (seconds === 0) param.setValueAtTime(value, at);
    else param.setTargetAtTime(value, at, seconds / 4);
  };
  const stage: StereoStage = {
    input, output, pan: output.pan, width: control.offset,
    setPan: (value, opts) => schedule(output.pan, value, -1, 1, opts),
    setWidth: (value, opts) => schedule(control.offset, value, 0, 1, opts),
    dispose() {
      if (disposed) return;
      disposed = true; control.stop();
      for (const node of [input, split, merge, output, control, scale, ...cross]) node.disconnect();
    },
    [Symbol.dispose]() { stage.dispose(); },
  };
  return stage;
}

/** Attach stereo controls to any bus, including master. Bus disposal owns stage disposal; stage disposal restores the bus. */
export function createBusStereo(bus: Bus, options: StereoOptions = {}): StereoStage {
  const stage = createStereo(bus.input.context, options);
  let detach: (() => void) | undefined;
  const dispose = stage.dispose;
  stage.dispose = () => { detach?.(); dispose(); };
  try { detach = bus.insert(stage); }
  catch (error) { dispose(); throw error; }
  return stage;
}
