import type {Engine,EnginePlugin} from '@margoengine/core/extension';
import {Kinematics} from './kinematics.js';
import {machineryMemory} from './runtime.js';
export interface TelemetryOptions {delay?:number;onError?:(error:unknown)=>void}
export class TelemetryChannel implements EnginePlugin {
  readonly name='telemetry-channel';private engine?:Engine;private frames=0;private timestamp=0;private localOrigin=0;private elapsed=0;private span=0;private socket?:WebSocket;
  private readonly seen:Uint8Array;private readonly incoming:Float32Array;private readonly output:Float32Array;
  private constructor(readonly kinematics:Kinematics,readonly options:TelemetryOptions,private readonly memory:Awaited<ReturnType<typeof machineryMemory>>,private readonly ring:Float32Array){this.seen=new Uint8Array(kinematics.jointCount);this.incoming=new Float32Array(kinematics.jointCount);this.output=ring.subarray(4*kinematics.jointCount);}
  static async create(kinematics:Kinematics,options:TelemetryOptions={}):Promise<TelemetryChannel> {if(!kinematics.jointCount||!Number.isFinite(options.delay??100)||(options.delay??100)<0)throw new RangeError('Invalid telemetry options');const memory=await machineryMemory(kinematics.jointCount*20);return new TelemetryChannel(kinematics,options,memory,new Float32Array(memory.buffer,memory.ptr,kinematics.jointCount*5));}
  setup(engine:Engine):void {if(!engine.hasPlugin(this.kinematics.name)||!this.kinematics.attachedTo(engine))throw new Error('Attach Kinematics before telemetry');for(let i=0;i<this.kinematics.jointCount;i++)this.kinematics.value(i);this.kinematics.setExternalControl(engine);this.engine=engine;}
  push(input:ArrayBuffer|ArrayBufferView,receivedAt=performance.now()):boolean {
    if(!this.engine||!this.kinematics.attachedTo(this.engine))throw new Error('Telemetry is not attached');if(!Number.isFinite(receivedAt))throw new RangeError('Invalid receive time');
    const view=input instanceof ArrayBuffer?new DataView(input):new DataView(input.buffer,input.byteOffset,input.byteLength);if(view.byteLength<6)throw new RangeError('Truncated telemetry frame');const time=view.getUint32(0,true),count=view.getUint16(4,true),n=this.kinematics.jointCount;
    if(count>n||view.byteLength!==6+count*6)throw new RangeError('Invalid telemetry frame length');this.seen.fill(0);
    for(let i=0;i<n;i++)this.incoming[i]=this.frames?this.ring[n+i]:this.kinematics.value(i);
    for(let i=0;i<count;i++){const id=view.getUint16(6+i*6,true),value=view.getFloat32(8+i*6,true);if(id>=n||this.seen[id])throw new RangeError('Invalid or duplicate telemetry joint');this.kinematics.checkValue(id,value);this.seen[id]=1;this.incoming[id]=value;}
    const delta=(time-this.timestamp)>>>0;if(this.frames&&(delta===0||delta>=0x80000000))return false;
    this.kinematics.validateValues(this.incoming);
    if(!this.frames){this.localOrigin=receivedAt;for(let i=0;i<n;i++){this.ring[i]=this.ring[n+i]=this.incoming[i];}this.frames=1;}
    else {this.span=delta;this.elapsed+=delta;for(let i=0;i<n;i++){const previous=this.ring[n+i],next=this.incoming[i],slope=Math.max(-3.402823e38,Math.min(3.402823e38,(next-previous)/(delta/1000))),old=this.ring[3*n+i];this.ring[i]=previous;this.ring[n+i]=next;this.ring[2*n+i]=old*slope<=0?0:Math.sign(slope)*Math.min(Math.abs(old),3*Math.abs(slope));this.ring[3*n+i]=slope;}this.frames=2;}
    this.timestamp=time;return true;
  }
  sample(now=performance.now()):void {if(!this.engine||!this.kinematics.attachedTo(this.engine)||!Number.isFinite(now))throw new RangeError('Invalid telemetry sample');if(!this.frames)return;const t=this.frames===1?1:(now-this.localOrigin-(this.options.delay??100)-(this.elapsed-this.span))/this.span;this.memory.api.telemetry_sample(this.memory.ptr,this.kinematics.jointCount,t,this.span/1000);this.kinematics.setValues(this.output);}
  private readonly message=(event:MessageEvent):void=>{try{if(!(event.data instanceof ArrayBuffer))throw new TypeError('Telemetry requires binary ArrayBuffer messages');this.push(event.data);}catch(error){(this.options.onError??((error:unknown)=>{throw error;}))(error);}};
  reset():void {this.frames=0;this.elapsed=this.span=0;this.ring.fill(0);}
  connect(socket:WebSocket):void {this.socket?.removeEventListener('message',this.message);this.reset();socket.binaryType='arraybuffer';socket.addEventListener('message',this.message);this.socket=socket;}
  onPreUpdate():void {this.sample();}
  dispose():void {this.socket?.removeEventListener('message',this.message);this.socket=undefined;if(this.engine&&this.kinematics.attachedTo(this.engine))this.kinematics.setExternalControl(null);this.engine=undefined;this.reset();}
}
