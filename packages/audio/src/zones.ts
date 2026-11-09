/// <reference lib="esnext.disposable" preserve="true" />
import { rampParam } from '@margoengine/mixer';
import { createRoomReverb, type RoomReverbOptions } from '@margoengine/mixer/reflections';
import type { Effect } from '@margoengine/mixer';
import type { AudioListener } from './listener.js';
import type { Vec3 } from './math.js';
import { fault, rangeError } from '../../shared/errors.js';

/** One axis-aligned world-space reverb area. Overlap selects greatest priority, then first in the list. */
export interface ReverbZone {
  /** Unique nonempty zone name. */
  name: string;
  /** Inclusive world bounds in metres, copied at construction. */
  min: Vec3;
  /** Inclusive world bounds in metres, copied at construction. */
  max: Vec3;
  /** Finite overlap priority. Default 0. */
  priority?: number;
  /** Linear wet-send gain, 0..1. Default 0.25. Dry sound stays on its existing route. */
  gain?: number;
  /** Existing mixer room response settings. Default mixer room defaults; mix is always 1 (wet only). */
  reverb?: Omit<RoomReverbOptions, 'mix'>;
}

/** Settings for wet-send transitions. */
export interface AudioReverbZonesOptions {
  /** Mixer exponential fade seconds, about 98% settled. Default 0.1; 0 jumps. */
  fade?: number;
}

/** Listener-selected wet returns, reusing the mixer's room convolution without replacing dry routes. */
export class AudioReverbZones {
  /** Connect sound outputs here as extra wet sends. Keep their existing dry connections. */
  readonly input: GainNode;
  private readonly zones: {name:string; min:number[]; max:number[]; priority:number; gain:number; send:GainNode; effect:Effect}[] = [];
  private readonly fade: number;
  private selected = -1;
  private disposed = false;
  private readonly listener: AudioListener;

  constructor(listener: AudioListener, zones: readonly ReverbZone[], options: AudioReverbZonesOptions = {}) {
    this.listener = listener;
    this.fade = options.fade ?? 0.1;
    if (!Number.isFinite(this.fade) || this.fade < 0)
      throw rangeError('Reverb zone fade must be finite and nonnegative; use seconds or 0 for a jump', 'state');
    const names = new Set<string>();
    const specs = Array.from(zones, zone => {
      if (!zone || typeof zone.name !== 'string' || !zone.name || names.has(zone.name))
        throw fault('state', 'Reverb zones need unique nonempty names; name each zone once');
      names.add(zone.name);
      const {min,max} = zone;
      if (min?.length !== 3 || max?.length !== 3 || [0,1,2].some(i => !Number.isFinite(min[i]) || !Number.isFinite(max[i]) || min[i] > max[i]))
        throw rangeError('Reverb zone bounds need three finite ordered coordinates; pass min and max in world metres', 'state');
      const priority = zone.priority ?? 0, gain = zone.gain ?? 0.25;
      if (!Number.isFinite(priority) || !Number.isFinite(gain) || gain < 0 || gain > 1)
        throw rangeError('Reverb zone needs finite priority and gain in 0..1; choose valid overlap and wet levels', 'state');
      return {name:zone.name,min:Array.from(min),max:Array.from(max),priority,gain,reverb:zone.reverb};
    });
    const context = listener.context;
    this.input = context.createGain();
    try {
      for (const spec of specs) {
        const effect = createRoomReverb(context, {...spec.reverb,mix:1});
        const send = context.createGain();
        send.gain.value = 0;
        this.zones.push({...spec,send,effect});
        this.input.connect(send).connect(effect.input);
        effect.output.connect(listener.input);
      }
      listener.addSource(this);
      this.update();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Selected zone name, or null outside every area. */
  get active(): string | null { return this.zones[this.selected]?.name ?? null; }

  /** Select from the listener's current world position. Attached listeners call this each frame. */
  update(): void {
    if (this.disposed) throw fault('disposed', 'AudioReverbZones is disposed; create a new zone controller');
    const p = this.listener.position;
    let next = -1;
    this.zones.forEach((zone,i) => {
      if ((next < 0 || zone.priority > this.zones[next].priority) &&
        [0,1,2].every(axis => p[axis] >= zone.min[axis] && p[axis] <= zone.max[axis])) next = i;
    });
    if (next === this.selected) return;
    for (let i = 0; i < this.zones.length; i++)
      rampParam(this.listener.context,this.zones[i].send.gain,i === next ? this.zones[i].gain : 0,{seconds:this.fade});
    this.selected = next;
  }

  /** Disconnect wet returns immediately. Disconnect external sends into input if their source will outlive this controller. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listener.removeSource(this);
    this.input.disconnect();
    for (const zone of this.zones) { zone.send.disconnect(); zone.effect.dispose(); }
    this.zones.length = 0;
    this.selected = -1;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void { this.dispose(); }
}
