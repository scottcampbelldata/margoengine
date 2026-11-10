/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { bounded, loadProcessor } from './worklet-host.js';
import type { Bus, RampOptions } from './mixer.js';

/** Sample-clock delay-line pitch shift settings. */
export interface PitchOptions {
  /** Semitones -48..48, fractional values supported, default 0. */
  pitch?: number;
  /** Crossfade window seconds 0.005..1, fixed at construction, default 0.1. */
  windowSize?: number;
  /** Additional wet delay seconds 0..1, default 0. */
  delayTime?: number;
  /** Wet feedback -0.95..0.95, default 0. */
  feedback?: number;
  /** Wet proportion 0..1, default 1. */
  mix?: number;
  /** Fourth-order lowpass before upward transposition, default true. Not an alias-free guarantee. */
  antiAlias?: boolean;
  /** Explicit speaker channels integer 1..32, default 2. Read-head phase is linked across channels. */
  channels?: number;
  /** Cancels module registration waiting, default unset. */
  signal?: AbortSignal;
}

/** A continuous real-time transposer. One output frame per input frame; formants/transients are not preserved. */
export interface PitchShift extends Disposable {
  /** Program input. */
  readonly input: GainNode;
  /** Wet/dry output. */
  readonly output: AudioWorkletNode;
  /** Audio-rate pitch in semitones, mix, feedback and additional delayTime parameters. */
  readonly params: Readonly<Record<'pitch' | 'mix' | 'feedback' | 'delayTime', AudioParam>>;
  /** Crossfade window in frames. Variable wet delay lies within additional delay plus 1..windowFrames+1 frames. */
  readonly windowFrames: number;
  /** Schedule pitch on the audio clock; immediate by default, exponential fade when seconds > 0. */
  setPitch(semitones: number, options?: RampOptions): void;
  /** Disconnect and stop owned processing; idempotent. */
  dispose(): void;
}

const processor = `class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(){return [['pitch',0,-48,48],['mix',1,0,1],['feedback',0,-.95,.95],['delayTime',0,0,1]]
    .map(([name,defaultValue,minValue,maxValue])=>({name,defaultValue,minValue,maxValue,automationRate:'a-rate'}));}
  constructor(options){
    super();this.o=options.processorOptions;this.active=true;this.at=0;this.phase=0;
    this.rings=Array.from({length:this.o.channels},()=>new Float64Array(Math.ceil(sampleRate+this.o.windowFrames)+4));
    this.states=Array.from({length:this.o.channels},()=>[new Float64Array(4),new Float64Array(4)]);
    this.port.onmessage=()=>{this.active=false;};
  }
  read(ring,delay){
    const p=(this.at-delay+ring.length)%ring.length,a=Math.floor(p),f=p-a;
    return ring[a]*(1-f)+ring[(a+1)%ring.length]*f;
  }
  process(inputs,outputs,params){
    if(!this.active)return false;
    const input=inputs[0],out=outputs[0],o=this.o;
    const get=(name,i)=>{const p=params[name];return p.length===1?p[0]:p[i];};
    for(let i=0;i<out[0].length;i++){
      const semitones=get('pitch',i),ratio=2**(semitones/12),mix=get('mix',i),feedback=get('feedback',i),extra=get('delayTime',i)*sampleRate;
      const p=this.phase,q=(p+.5)%1,weight=Math.sin(Math.PI*p)**2;
      const filter=o.antiAlias&&ratio>1;
      const w=2*Math.PI*.45/Math.max(1,ratio),cs=Math.cos(w),alpha=Math.sin(w)/Math.SQRT2,a0=1+alpha;
      const b0=(1-cs)/(2*a0),b1=2*b0,a1=-2*cs/a0,a2=(1-alpha)/a0;
      for(let c=0;c<out.length;c++){
        const x=input[c]?.[i]??0,ring=this.rings[c];let filtered=x;
        if(filter)for(const s of this.states[c]){
          const y=b0*filtered+b1*s[0]+b0*s[1]-a1*s[2]-a2*s[3];s[1]=s[0];s[0]=filtered;s[3]=s[2];s[2]=y;filtered=y;
        }
        let wet;
        if(semitones===0)wet=extra===0&&feedback===0?x:this.read(ring,Math.max(1,extra));
        else wet=weight*this.read(ring,extra+1+p*o.windowFrames)+(1-weight)*this.read(ring,extra+1+q*o.windowFrames);
        ring[this.at]=filtered+feedback*wet;
        out[c][i]=mix===0?x:mix===1?wet:(1-mix)*x+mix*wet;
      }
      this.at=(this.at+1)%this.rings[0].length;
      this.phase=((p+(1-ratio)/o.windowFrames)%1+1)%1;
    }return true;
  }
}
registerProcessor('margo-pitch-v1',PitchProcessor);`;

/** Create dual-read-head, complementary Hann-window pitch transposition without changing the output clock or frame count. */
export async function createPitchShift(context: BaseAudioContext, options: PitchOptions = {}): Promise<PitchShift> {
  const parameterData = { pitch: bounded(options.pitch ?? 0, -48, 48, 'Pitch semitones'),
    mix: bounded(options.mix ?? 1, 0, 1, 'Pitch mix'), feedback: bounded(options.feedback ?? 0, -0.95, 0.95, 'Pitch feedback'),
    delayTime: bounded(options.delayTime ?? 0, 0, 1, 'Pitch delayTime') };
  const windowFrames = Math.round(bounded(options.windowSize ?? 0.1, 0.005, 1, 'Pitch windowSize') * context.sampleRate);
  const channels = bounded(options.channels ?? 2, 1, 32, 'Pitch channels');
  if (!Number.isInteger(channels)) throw new RangeError('Pitch channels needs an integer; use channels 2');
  if (options.antiAlias !== undefined && typeof options.antiAlias !== 'boolean')
    throw new TypeError('Pitch antiAlias needs a boolean; pass true or false');
  await loadProcessor(context, 'margo-pitch-v1', processor, options.signal); options.signal?.throwIfAborted();
  const output = new AudioWorkletNode(context, 'margo-pitch-v1', { numberOfInputs: 1, numberOfOutputs: 1,
    outputChannelCount: [channels], channelCount: channels, channelCountMode: 'explicit', parameterData,
    processorOptions: { channels, windowFrames, antiAlias: options.antiAlias ?? true },
  });
  const input = context.createGain(); input.connect(output);
  const params = Object.fromEntries(Object.keys(parameterData).map(k => [k, output.parameters.get(k)!])) as unknown as PitchShift['params'];
  let disposed = false;
  const stage: PitchShift = { input, output, params, windowFrames,
    setPitch(value, settings = {}) {
      if (disposed) throw new MargoError('disposed', 'Pitch stage is disposed; create a new pitch stage');
      bounded(value, -48, 48, 'Pitch semitones');
      const at = bounded(settings.at ?? context.currentTime, context.currentTime, Number.MAX_VALUE, 'Pitch time');
      const seconds = bounded(settings.seconds ?? 0, 0, 3600, 'Pitch fade');
      params.pitch.cancelScheduledValues(at);
      if (seconds === 0) params.pitch.setValueAtTime(value, at); else params.pitch.setTargetAtTime(value, at, seconds / 4);
    },
    dispose() { if (disposed) return; disposed = true; input.disconnect(); output.disconnect();
      output.port.postMessage('dispose'); output.port.close(); },
    [Symbol.dispose]() { stage.dispose(); },
  };
  return stage;
}

/** Insert owned pitch transposition on any bus. Disposal restores routing; bus teardown also stops the worklet. */
export async function createBusPitchShift(bus: Bus, options: PitchOptions = {}): Promise<PitchShift> {
  const stage = await createPitchShift(bus.input.context, options); let detach: (() => void) | undefined; const dispose = stage.dispose;
  stage.dispose = () => { detach?.(); dispose(); };
  try { options.signal?.throwIfAborted(); detach = bus.insert(stage); } catch (error) { dispose(); throw error; }
  return stage;
}
