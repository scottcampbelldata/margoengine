import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { VoxelTraceImage } from '@margoengine/voxel-pathtracer';
import { waitForFeature } from './feature-wait.js';
import { DENOISE_ML } from './denoise-ml-shader.js';

declare const GPUBufferUsage: {STORAGE:number;COPY_DST:number;COPY_SRC:number;UNIFORM:number;MAP_READ:number};
declare const GPUMapMode: {READ:number};

/** A cancellation signal for a learned image reconstruction. */
export interface DenoiseMLOptions {
  /** Cancels queued work, readiness or readback. Default undefined. */
  signal?: AbortSignal;
}
function requestSignal(options:DenoiseMLOptions):AbortSignal|undefined {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('DenoiseML options must be an object; pass {signal} or omit it');
  const signal=options.signal;signal?.throwIfAborted();return signal;
}
function failure(code: 'unsupported' | 'disposed' | 'failed', message: string): MargoError {
  return new MargoError(code, `${message}; https://margoengine.com/errors#voxel-pathtracer`);
}
function snapshot(image: VoxelTraceImage): VoxelTraceImage {
  const count = image?.width * image?.height;
  if (!Number.isSafeInteger(count) || image.width < 1 || image.height < 1 ||
      !Number.isInteger(image.width) || !Number.isInteger(image.height) || count > 16_777_216)
    throw new RangeError('DenoiseML needs positive integer dimensions, at most 16,777,216 pixels');
  for (const [name, values] of [['color',image.color],['albedo',image.albedo],['normal',image.normal]] as const) {
    if (!(values instanceof Float32Array) || values.length !== count*3 || values.some(v => !Number.isFinite(v)))
      throw new TypeError(`DenoiseML needs finite RGB Float32Array ${name}; renderImage with aovs: true`);
    if (name === 'color' && values.some(v => v < 0 || v > Math.fround(1e16)))
      throw new RangeError('DenoiseML color must be in [0,Float32(1e16)]');
    if (name === 'albedo' && values.some(v => v < 0 || v > 1))
      throw new RangeError('DenoiseML albedo must be in [0,1]');
    if (name === 'normal' && values.some(v => v < -1 || v > 1))
      throw new RangeError('DenoiseML normal components must be in [-1,1]');
  }
  if (image.alpha && (!(image.alpha instanceof Float32Array) || image.alpha.length !== count || image.alpha.some(v => !Number.isFinite(v) || v < 0 || v > 1)))
    throw new RangeError('DenoiseML alpha must hold one coverage value in [0,1] per pixel');
  if (!Number.isFinite(image.samples) || image.samples < 1) throw new RangeError('DenoiseML samples must be positive');
  return structuredClone(image);
}

/** Small clean-room trained albedo/normal-guided network, evaluated by a WebGPU compute dispatch. */
export class DenoiseML {
  #engine: EngineKernel;
  #disposed = false;
  #lifetime = new AbortController();
  #signal(signal?:AbortSignal):AbortSignal{return signal?AbortSignal.any([signal,this.#lifetime.signal]):this.#lifetime.signal;}
  #device?: GPUDevice;
  #weights?: GPUBuffer;
  #pipeline?: Promise<GPUComputePipeline>;
  #queue: Promise<unknown> = Promise.resolve();
  private constructor(engine: EngineKernel) { this.#engine = engine; }
  /** Compile the optional network. No model or GPU allocation occurs on import. */
  static async create(engine: EngineKernel, options: DenoiseMLOptions = {}): Promise<DenoiseML> {
    const external=requestSignal(options),result = new DenoiseML(engine),signal=result.#signal(external);
    try { await waitForFeature(result.#prepare(),signal);return result; }
    catch(error){result.dispose();throw error;}
  }
  async #prepare(): Promise<GPUComputePipeline> {
    if (this.#disposed) throw failure('disposed','DenoiseML is disposed; create another denoiser');
    const device = engineRuntime(this.#engine).gpu;
    if (!device) throw failure('unsupported','DenoiseML requires a WebGPU compute device');
    if (this.#device !== device) {
      this.#weights?.destroy();this.#weights=undefined;this.#pipeline=undefined;this.#device=device;
    }
    if (!this.#pipeline) this.#pipeline = (async () => {
      const {WEIGHTS} = await import('./denoise-ml-weights.js');
      const pipeline = await device.createComputePipelineAsync({label:'Margo learned denoiser',layout:'auto',compute:{module:device.createShaderModule({code:DENOISE_ML}),entryPoint:'denoiseML'}});
      if (this.#disposed || this.#device !== device) throw failure('disposed','DenoiseML device changed during preparation');
      const weights = device.createBuffer({label:'Margo learned denoiser weights',size:WEIGHTS.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      device.queue.writeBuffer(weights,0,new Float32Array(WEIGHTS));this.#weights=weights;
      return pipeline;
    })().catch(error=>{if(error instanceof MargoError)throw error;throw Object.assign(failure('failed','DenoiseML pipeline creation failed; check the device and create another denoiser'),{cause:error});});
    return this.#pipeline;
  }
  /** Reconstruct an owned HDR image; input arrays and all guide/AOV arrays are preserved. */
  denoise(image: VoxelTraceImage, options: DenoiseMLOptions = {}): Promise<VoxelTraceImage> {
    let owned: VoxelTraceImage,signal:AbortSignal;
    try{const external=requestSignal(options);if(this.#disposed)throw failure('disposed','DenoiseML is disposed; create another denoiser');signal=this.#signal(external);owned=snapshot(image);}
    catch(error){return Promise.reject(error);}
    const result=this.#queue.then(()=>this.#run(owned,signal));
    this.#queue=result.catch(()=>{});return waitForFeature(result,signal);
  }
  async #run(image: VoxelTraceImage, signal?: AbortSignal): Promise<VoxelTraceImage> {
    signal?.throwIfAborted();
    const pipeline=await waitForFeature(this.#prepare(),signal),device=this.#device!,count=image.width*image.height,bytes=count*12;
    if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize)
      throw failure('unsupported','DenoiseML image exceeds this device binding limit; use a smaller image');
    if (Math.ceil(image.width/8)>device.limits.maxComputeWorkgroupsPerDimension || Math.ceil(image.height/8)>device.limits.maxComputeWorkgroupsPerDimension)
      throw failure('unsupported','DenoiseML dispatch exceeds this device grid limit; use a smaller image');
    const buffers:GPUBuffer[]=[];
    const allocate=(size:number,usage:number)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
    try{
      signal?.throwIfAborted();
      const uniform=allocate(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),params=new Uint32Array([image.width,image.height,0,0]);new Float32Array(params.buffer)[2]=image.samples;device.queue.writeBuffer(uniform,0,params);
      const inputs=[image.color,image.albedo!,image.normal!,image.alpha??new Float32Array(count).fill(1)].map(values=>{
        const buffer=allocate(values.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);device.queue.writeBuffer(buffer,0,values);return buffer;
      });
      const output=allocate(bytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),readback=allocate(bytes,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[uniform,this.#weights!,...inputs,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(image.width/8),Math.ceil(image.height/8));pass.end();encoder.copyBufferToBuffer(output,0,readback,0,bytes);device.queue.submit([encoder.finish()]);
      await waitForFeature(readback.mapAsync(GPUMapMode.READ),signal);
      if(this.#disposed||engineRuntime(this.#engine).gpu!==device)throw failure('disposed','DenoiseML device changed during reconstruction');
      const color=new Float32Array(readback.getMappedRange()).slice();readback.unmap();
      return {...image,color};
    }catch(error){
      if(signal?.aborted)throw signal.reason;
      if(error instanceof MargoError)throw error;
      throw Object.assign(failure('failed','DenoiseML reconstruction failed; check the device and create another denoiser'),{cause:error});
    }finally{for(const buffer of buffers)buffer.destroy();}
  }
  /** Wait until all queued reconstruction requests settle. */
  async whenIdle(): Promise<void> { await this.#queue; }
  /** Release weights and refuse pending/new work. Idempotent. */
  dispose(): void {if(this.#disposed)return;this.#disposed=true;this.#lifetime.abort(failure('disposed','DenoiseML is disposed; create another denoiser'));this.#weights?.destroy();this.#weights=undefined;}
  /** Deterministic using cleanup. */
  [Symbol.dispose](): void {this.dispose();}
}
