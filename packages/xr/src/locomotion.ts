import { margoError } from '../../shared/errors.js';
import { Locomotion, type XRLayersHost } from './layers.js';
import type { XRFrameState, XRInputSource, XRNativeSession } from './types.js';

import type { XREyeTarget } from './eye-target.js';
/** XR host accepted by the smooth locomotion controller. */
export interface SmoothLocomotionHost extends XRLayersHost {
  onEye(callback: (target: XREyeTarget) => void): () => void;
}
/** Comfort and movement options; speeds use metres and radians per second. */
export interface SmoothLocomotionOptions {
  /** Translation speed. Default 2 metres/second. */
  speed?: number;
  /** Turning speed. Default Math.PI / 2 radians/second. */
  turnSpeed?: number;
  /** Movement controller. Default 'left'. */
  moveHand?: 'left' | 'right';
  /** Turning controller. Default 'right'. */
  turnHand?: 'left' | 'right';
  /** Movement direction. Default 'head'; controller uses its grip or target ray. */
  direction?: 'head' | 'controller';
  /** Radial dead zone, 0 <= value < 1. Default 0.15. */
  deadZone?: number;
  /** Thumbstick axes [horizontal, vertical]. Default [2, 3], the xr-standard thumbstick. */
  axes?: readonly [number, number];
  /** Use a soft stereo angular field-of-view restrictor. Default true. */
  vignette?: boolean;
  /** Full angular opening at maximum movement. Default Math.PI / 2 (90 degrees). */
  fieldOfView?: number;
  /** Soft angular border in radians. Default 0.2. */
  feather?: number;
  /** Exponential fade response in seconds. Default 0.15. */
  fade?: number;
  /** Stop and release resources when aborted. */
  signal?: AbortSignal;
}
/** Smooth planar movement and turning alongside teleport, with a stereo comfort vignette. */
export class SmoothLocomotion {
  private readonly movement: Locomotion;
  private readonly stops: (() => void)[] = [];
  private readonly overlay = new ComfortVignette();
  private readonly options: Required<Omit<SmoothLocomotionOptions, 'signal'>>;
  private readonly session: XRNativeSession;
  private floor = 0;
  private amount = 0;
  private disposed = false;
  /** Enable thumbstick translation and turning. Default true. Teleport and snap turning remain available. */
  enabled = true;
  /** Current vignette strength, from zero to one. */
  get comfort(): number { return this.amount; }
  /** Attaches to an active XR session. Session end disposes it; attach again after entering the next session. */
  static attach(xr: SmoothLocomotionHost, options: SmoothLocomotionOptions = {}): SmoothLocomotion {
    return new SmoothLocomotion(xr, options);
  }
  private constructor(private readonly xr: SmoothLocomotionHost, options: SmoothLocomotionOptions) {
    const o = this.options = { speed: 2, turnSpeed: Math.PI / 2, moveHand: 'left', turnHand: 'right',
      direction: 'head', deadZone: 0.15, axes: [2, 3], vignette: true,
      fieldOfView: Math.PI / 2, feather: 0.2, fade: 0.15, ...options };
    for (const [name, value] of Object.entries({speed:o.speed, turnSpeed:o.turnSpeed, feather:o.feather, fade:o.fade}))
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative; pass a movement option such as { speed: 2 }`);
    if (!Number.isFinite(o.deadZone) || o.deadZone < 0 || o.deadZone >= 1 || !Number.isFinite(o.fieldOfView) || o.fieldOfView <= 0 || o.fieldOfView >= Math.PI)
      throw new RangeError('Use a deadZone in [0, 1) and a fieldOfView in (0, Math.PI); pass { deadZone: 0.15, fieldOfView: Math.PI / 2 }');
    if (o.axes.length !== 2 || o.axes.some(a => !Number.isSafeInteger(a) || a < 0) || o.axes[0] === o.axes[1])
      throw new RangeError('axes must be two distinct nonnegative integer indices; pass [2, 3] for xr-standard');
    if (!['left','right'].includes(o.moveHand) || !['left','right'].includes(o.turnHand) || !['head','controller'].includes(o.direction))
      throw new TypeError('Choose left/right hands and head/controller direction; pass { moveHand: "left", direction: "head" }');
    if (typeof xr?.onEye !== 'function' || typeof xr?.onFrame !== 'function')
      throw new TypeError('SmoothLocomotion needs an XR with stereo eye hooks; pass the XR from XR.create');
    if (!xr.session) throw margoError('state', 'SmoothLocomotion needs an active session; await xr.requestSession first');
    this.session = xr.session;
    o.axes = [o.axes[0], o.axes[1]];
    options.signal?.throwIfAborted();
    this.movement = Locomotion.attach(xr);
    const end = () => this.dispose();
    this.session.addEventListener('end', end);
    this.stops.push(() => this.session.removeEventListener('end', end));
    this.stops.push(xr.onFrame(state => this.update(state)), xr.onEye(target => {
      if (o.vignette && this.amount > 0.0001) this.overlay.draw(target, this.amount, o.fieldOfView, o.feather);
    }));
    if (options.signal) {
      const abort = () => this.dispose();
      options.signal.addEventListener('abort', abort, {once:true});
      this.stops.push(() => options.signal!.removeEventListener('abort', abort));
    }
  }
  /** Teleport to a floor point in the current reference space. Default yaw 0. */
  teleport(target: readonly [number,number,number], yaw = 0): void {
    this.live(); this.movement.teleport(target,yaw); this.floor=target[1];
  }
  /** Snap turn about the current tracked feet by yaw radians. */
  turn(yaw: number): void { this.live(); this.movement.turn(yaw); }
  private live(): void {
    if(this.disposed) throw margoError('disposed','SmoothLocomotion is disposed; attach a new controller');
    if(this.xr.session !== this.session) throw margoError('state','The XR session changed; attach a new locomotion controller');
  }
  private update(state: XRFrameState): void {
    if (state.frame.session !== this.session || this.xr.session !== this.session) return;
    const dt = Math.max(0,Math.min(Number.isFinite(state.delta) ? state.delta : 0,0.1));
    const viewer=state.viewer;
    let motion=0;
    if(this.enabled && viewer && dt > 0) {
      const input=state.inputs.find(i=>i.source.handedness===this.options.moveHand);
      const turn=state.inputs.find(i=>i.source.handedness===this.options.turnHand);
      const [x,z]=this.stick(input?.source), tx=this.turnAxis(turn?.source);
      const pose=this.options.direction==='head' ? viewer : input?.grip ?? input?.targetRay;
      let dx=0,dz=0;
      if(pose) {
        const m=pose.transform.matrix, len=Math.hypot(m[8],m[10]);
        if(len>1e-8) { dx=(m[10]*x+m[8]*z)/len*this.options.speed*dt;
          dz=(-m[8]*x+m[10]*z)/len*this.options.speed*dt; }
      }
      const yaw=-tx*this.options.turnSpeed*dt, p=viewer.transform.position;
      if(dx || dz || yaw) this.movement.teleport([p.x+dx,this.floor,p.z+dz],yaw);
      motion=Math.max(dx || dz ? Math.hypot(x,z) : 0, yaw ? Math.abs(tx) : 0);
    }
    this.amount += (motion-this.amount)*(this.options.fade===0 ? 1 : -Math.expm1(-dt/this.options.fade));
  }
  private turnAxis(source?: XRInputSource): number {
    const pad=source?.gamepad;
    if(!pad?.connected) return 0;
    const value=pad.axes[this.options.axes[0]] ?? 0, magnitude=Math.abs(value), dead=this.options.deadZone;
    return Number.isFinite(value) && magnitude>dead ? Math.sign(value)*(Math.min(1,magnitude)-dead)/(1-dead) : 0;
  }
  private stick(source?: XRInputSource): [number,number] {
    const pad=source?.gamepad, [a,b]=this.options.axes;
    if(!pad || !pad.connected) return [0,0];
    const x=pad.axes[a] ?? 0,z=pad.axes[b] ?? 0;
    if(!Number.isFinite(x) || !Number.isFinite(z)) return [0,0];
    const len=Math.hypot(x,z), dead=this.options.deadZone;
    const scale=len>dead ? (Math.min(1,len)-dead)/(1-dead)/len : 0;
    return [x*scale,z*scale];
  }
  /** Unsubscribe and release the vignette buffers. Idempotent. */
  dispose(): void {
    if(this.disposed)return;
    this.disposed=true; this.movement.dispose();
    for(const stop of this.stops)stop();
    this.stops.length=0; this.overlay.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}

/** Private per-device stereo angular overlay, encoded after scene color and depth. */
class ComfortVignette {
  private device?: GPUDevice;
  private pipeline?: GPURenderPipeline;
  private format?: GPUTextureFormat;
  private readonly eyes = new Map<number,{buffer:GPUBuffer;group:GPUBindGroup}>();
  draw(target: XREyeTarget, amount:number, fov:number, feather:number): void {
    const {device,encoder,image,view}=target, format=image.colorTexture.format;
    if(this.device!==device || this.format!==format) {
      this.dispose(); this.device=device; this.format=format;
      const module=device.createShaderModule({code:`
struct Params { viewport:vec4f, projection:vec4f, comfort:vec4f }
@group(0) @binding(0) var<uniform> u:Params;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1); }
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
let ndc=(p.xy-u.viewport.xy)/u.viewport.zw*2.0-1.0;
let ray=vec2f((ndc.x+u.projection.z)/u.projection.x,(-ndc.y+u.projection.w)/u.projection.y);
let angle=atan(length(ray));
let a=smoothstep(u.comfort.y,u.comfort.y+max(u.comfort.z,0.00001),angle)*u.comfort.x;
return vec4f(0,0,0,a); }`});
      this.pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},
        fragment:{module,entryPoint:'fragment',targets:[{format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'}});
    }
    let eye=this.eyes.get(target.index);
    if(!eye) {
      const buffer=device.createBuffer({size:48,usage:0x48 /* UNIFORM | COPY_DST */});
      eye={buffer,group:device.createBindGroup({layout:this.pipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}}]})};
      this.eyes.set(target.index,eye);
    }
    const {x,y,width,height}=image.viewport,p=view.projectionMatrix;
    device.queue.writeBuffer(eye.buffer,0,new Float32Array([x,y,width,height,p[0],p[5],p[8],p[9],amount,fov/2,feather,0]));
    const pass=encoder.beginRenderPass({colorAttachments:[{view:image.colorTexture.createView(image.getViewDescriptor()),loadOp:'load',storeOp:'store'}]});
    pass.setViewport(x,y,width,height,0,1);pass.setScissorRect(x,y,width,height);
    pass.setPipeline(this.pipeline!);pass.setBindGroup(0,eye.group);pass.draw(3);pass.end();
  }
  dispose(): void {for(const eye of this.eyes.values())eye.buffer.destroy();this.eyes.clear();this.pipeline=undefined;this.device=undefined;}
}


