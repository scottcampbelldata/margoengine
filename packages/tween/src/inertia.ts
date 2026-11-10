/// <reference lib="esnext.disposable" />
import {Spring} from './spring.js';
import {MargoError} from '@margoengine/math/errors';

/** A bounded recent-window least-squares velocity estimate, in units per second. */
export class VelocityTracker {
  private readonly samples: {value:number;time:number}[]=[];
  /** Sampling window in seconds (default 0.1), and maximum retained samples (default 32). */
  constructor(readonly window=0.1,readonly capacity=32) {
    if(!Number.isFinite(window)||window<=0||!Number.isInteger(capacity)||capacity<2||capacity>1024)
      throw new RangeError('Use a positive finite window and capacity from 2 to 1024');
  }
  /** Number of retained samples, bounded by capacity. */
  get size():number {return this.samples.length;}
  /** Add a finite value at nondecreasing caller-supplied seconds; equal-time samples replace the last. */
  sample(value:number,time:number):this {
    if(!Number.isFinite(value)||!Number.isFinite(time)||time<0||time<(this.samples.at(-1)?.time??0))
      throw new RangeError('Samples need finite values and nondecreasing seconds >= 0');
    if(this.samples.at(-1)?.time===time)this.samples[this.samples.length-1]={value,time};
    else this.samples.push({value,time});
    while(this.samples.length>1&&(this.samples[0].time<time-this.window||this.samples.length>this.capacity))this.samples.shift();
    return this;
  }
  /** Latest measured velocity. Use velocityAt at release to account for an idle pointer. */
  get velocity():number {return this.velocityAt(this.samples.at(-1)?.time??0);}
  /** Estimate at release seconds. No recent samples yields zero; no hidden wall clock is read. */
  velocityAt(time:number):number {
    const last=this.samples.at(-1);
    if(!Number.isFinite(time)||time<0||(last&&time<last.time))throw new RangeError('Release time must be finite and >= the last sample time');
    if(!last||time-last.time>this.window)return 0;
    const first=this.samples.find(sample=>sample.time>=time-this.window)!;
    const span=last.time-first.time;
    if(!span)return 0;
    let n=0,st=0,sv=0,stt=0,stv=0;
    for(const sample of this.samples)if(sample.time>=time-this.window){
      const t=(sample.time-last.time)/span,v=sample.value-last.value;
      n++;st+=t;sv+=v;stt+=t*t;stv+=t*v;
    }
    const divisor=n*stt-st*st;
    const velocity=divisor>0?((n*stv-st*sv)/divisor)/span:0;
    if(!Number.isFinite(velocity))throw new RangeError('Velocity overflow; use well-scaled values and timestamps');
    return velocity;
  }
  /** Forget the current drag before starting another. */
  reset():void {this.samples.length=0;}
}

/** Release velocity, friction and endpoint constraints. All clocks are caller supplied. */
export interface InertiaOptions {
  /** Units per second, or measured recent samples. */
  velocity:number|VelocityTracker;
  /** Release seconds for a tracker; default its latest sample time. */
  releaseTime?:number;
  /** Exponential velocity decay rate per second, > 0. Default 6. */
  resistance?:number;
  /** Lower endpoint/range bound. Default unbounded. */
  min?:number;
  /** Upper endpoint/range bound. Default unbounded. */
  max?:number;
  /** Exact endpoint, nearest stop list, or function of the projected endpoint. Default natural endpoint. */
  end?:number|readonly number[]|((projected:number)=>number);
  /** Boundary/endpoint spring bounce in [0,1). Zero keeps range bounds hard. Default 0. */
  bounce?:number;
  /** Rest velocity in units/s, > 0. Default 0.01. */
  restSpeed?:number;
  /** Rest endpoint distance, > 0. Default 0.001. */
  restDelta?:number;
  /** Maximum simulated seconds before writing the exact endpoint. Default 10. */
  maxDuration?:number;
  /** Cancels and rejects finished with the exact reason. Default none. */
  signal?:AbortSignal;
  /** Called after writing value/velocity. Default none. */
  onUpdate?:(value:number,velocity:number)=>void;
  /** Called once after reaching the exact endpoint. Default none. */
  onComplete?:()=>void;
}
/** A release operation; update owns its clock and cancellation preserves its current value. */
export interface InertiaTween extends PromiseLike<void>,Disposable {
  /** Current value. */
  readonly value:number;
  /** Current physical velocity, in units/s before the local speed multiplier. */
  readonly velocity:number;
  /** Selected, bounded endpoint. */
  readonly end:number;
  /** Resolves at rest; rejects on cancellation or an update error. */
  readonly finished:Promise<void>;
  /** Local speed >= 0, default 1. */
  speed:number;
  /** Advance by finite seconds >= 0. */
  update(delta:number):void;
  /** Pause this operation. */
  pause():this;
  /** Resume unfinished work. */
  play():this;
  /** Reject unfinished work, with AbortError by default. */
  cancel(reason?:unknown):void;
}
/** Names of numeric properties on a target. */
export type NumericProperty<T extends object> = {[K in keyof T]: T[K] extends number ? K : never}[keyof T] & string;

class Release implements InertiaTween {
  readonly finished:Promise<void>;
  private resolve!:()=>void;
  private reject!:(reason:unknown)=>void;
  private settled=false;
  private running=true;
  private updating=false;
  private rate=1;
  private elapsed=0;
  private current:number;
  private currentVelocity:number;
  private readonly aborted=()=>this.cancel(this.options.signal!.reason);
  constructor(private readonly write:(value:number)=>void,private readonly start:number,private readonly initialVelocity:number,readonly end:number,
    private readonly resistance:number,private readonly min:number,private readonly max:number,private readonly spring:Spring|undefined,private readonly options:InertiaOptions) {
    this.current=start;this.currentVelocity=initialVelocity;
    this.finished=new Promise<void>((yes,no)=>{this.resolve=yes;this.reject=no;});
    if(options.signal?.aborted)this.cancel(options.signal.reason);
    else options.signal?.addEventListener('abort',this.aborted,{once:true});
  }
  get value():number{return this.current;}
  get velocity():number{return this.currentVelocity;}
  get speed():number{return this.rate;}
  set speed(value:number){if(!Number.isFinite(value)||value<0)throw new RangeError('speed must be finite and >= 0');this.rate=value;}
  pause():this{this.running=false;return this;}
  play():this{if(!this.settled)this.running=true;return this;}
  private detach():void{this.options.signal?.removeEventListener('abort',this.aborted);}
  cancel(reason:unknown=new DOMException('Inertia cancelled','AbortError')):void {
    if(this.settled)return;
    this.settled=true;this.running=false;this.detach();this.reject(reason);
  }
  update(delta:number):void {
    if(!Number.isFinite(delta)||delta<0||!Number.isFinite(delta*this.rate))throw new RangeError('Scaled delta must be finite and >= 0');
    if(this.updating)throw new MargoError('state','Recursive inertia update; update after the callback returns');
    if(this.settled||!this.running||this.rate===0)return;
    this.updating=true;
    try {
      const limit=this.options.maxDuration??10;
      this.elapsed=Math.min(limit,this.elapsed+delta*this.rate);
      if(this.spring){
        this.spring.value=this.start;this.spring.velocity=this.initialVelocity;
        this.current=this.spring.update(this.elapsed);this.currentVelocity=this.spring.velocity;
      }else{
        this.current=this.start+(this.initialVelocity/this.resistance)*-Math.expm1(-this.resistance*this.elapsed);
        this.currentVelocity=this.initialVelocity*Math.exp(-this.resistance*this.elapsed);
      }
      let done=this.elapsed>=limit||(Math.abs(this.current-this.end)<=(this.options.restDelta??0.001)&&Math.abs(this.currentVelocity)<=(this.options.restSpeed??0.01));
      if(!(this.options.bounce??0)&&(this.current<this.min||this.current>this.max)){
        this.current=Math.max(this.min,Math.min(this.max,this.current));this.currentVelocity=0;
        if(!this.spring||this.current===this.end)done=true;
      }
      if(done){this.current=this.end;this.currentVelocity=0;}
      if(!Number.isFinite(this.current)||!Number.isFinite(this.currentVelocity))throw new RangeError('Inertia overflow; use well-scaled velocity, resistance and bounds');
      this.write(this.current);this.options.onUpdate?.(this.current,this.currentVelocity);
      if(done&&!this.settled){
        this.options.onComplete?.();
        if(!this.settled){this.settled=true;this.running=false;this.detach();this.resolve();}
      }
    }catch(error){this.cancel(error);throw error;}
    finally{this.updating=false;}
  }
  then<TResult1=void,TResult2=never>(onfulfilled?:((value:void)=>TResult1|PromiseLike<TResult1>)|null,onrejected?:((reason:unknown)=>TResult2|PromiseLike<TResult2>)|null):Promise<TResult1|TResult2>{return this.finished.then(onfulfilled,onrejected);}
  [Symbol.dispose]():void{this.cancel();}
}

/** Continue a dragged numeric property with measured velocity, friction and optional snapping/range bounds. */
export function inertia<T extends object>(target:T,key:NumericProperty<T>,options:InertiaOptions):InertiaTween {
  const record=target as Record<string,unknown>,start=record[key];
  const velocity=options.velocity instanceof VelocityTracker ? options.releaseTime===undefined ? options.velocity.velocity : options.velocity.velocityAt(options.releaseTime) : options.velocity;
  const resistance=options.resistance??6,min=options.min??-Infinity,max=options.max??Infinity,bounce=options.bounce??0;
  if(typeof start!=='number'||!Number.isFinite(start)||!Number.isFinite(velocity)||!Number.isFinite(resistance)||resistance<=0||min>max||
    (options.min!==undefined&&!Number.isFinite(min))||(options.max!==undefined&&!Number.isFinite(max))||!Number.isFinite(bounce)||bounce<0||bounce>=1)
    throw new RangeError('Inertia needs finite values, resistance > 0, ordered finite bounds and bounce in [0,1)');
  for(const [name,value]of Object.entries({restSpeed:options.restSpeed??0.01,restDelta:options.restDelta??0.001,maxDuration:options.maxDuration??10}))
    if(!Number.isFinite(value)||value<=0)throw new RangeError(`${name} must be finite and > 0`);
  if((options.onUpdate!==undefined&&typeof options.onUpdate!=='function')||(options.onComplete!==undefined&&typeof options.onComplete!=='function'))throw new TypeError('Inertia callbacks must be functions');
  const projected=start+velocity/resistance;
  if(!Number.isFinite(projected))throw new RangeError('Projected endpoint overflow; reduce velocity or increase resistance');
  let end=projected;
  if(typeof options.end==='function')end=options.end(projected);
  else if(Array.isArray(options.end)){
    const valid=options.end.filter(value=>Number.isFinite(value)&&value>=min&&value<=max);
    if(valid.length!==options.end.length||!valid.length)throw new RangeError('End stops need finite values inside the bounds; provide at least one stop');
    end=valid.reduce((best,value)=>Math.abs(value-projected)<Math.abs(best-projected)?value:best);
  }else if(options.end!==undefined)end=options.end as number;
  if(!Number.isFinite(end))throw new RangeError('Selected endpoint must be finite');
  end=Math.max(min,Math.min(max,end));
  let spring:Spring|undefined;
  if(options.end!==undefined||start<min||start>max||bounce>0){
    const span=end-start;
    const omega=!bounce&&span&&velocity*span>0?Math.max(resistance,Math.abs(velocity/span)):resistance;
    if(!Number.isFinite(start+end+velocity)||!Number.isFinite(omega*omega))throw new RangeError('Spring scale overflow; use smaller velocity/coordinates or a wider endpoint span');
    spring=new Spring({value:start,target:end,velocity,stiffness:omega*omega,damping:2*(1-bounce)*omega,precision:0});
  }
  return new Release(value=>{record[key]=value;},start,velocity,end,resistance,min,max,spring,{...options});
}
