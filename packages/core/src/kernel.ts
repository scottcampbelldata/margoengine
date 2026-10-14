import { wasmBase64 } from './wasm.js';

interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  kernel_new(capacity: number): number;
  kernel_data(handle: number): number;
  kernel_flags(handle: number): number;
  kernel_tick(handle: number, culling: number): number;
  kernel_drop(handle: number): void;
}
let compiled: Promise<WebAssembly.Module> | undefined;

export class TransformStore {
  readonly transforms: Record<'x'|'y'|'z'|'qx'|'qy'|'qz'|'qw'|'sx'|'sy'|'sz', Float32Array>;
  readonly matrices: Float32Array;
  readonly parents: Float32Array;
  readonly bounds: Float32Array;
  readonly planes: Float32Array;
  readonly active: Uint8Array;
  readonly visible: Uint8Array;
  readonly rotations:Float32Array;
  readonly limits:Float32Array;
  readonly constrained:Uint8Array;
  readonly hidden:Uint8Array;
  private handle: number;

  static async create(capacity = 1024): Promise<TransformStore> {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) throw new RangeError('Capacity: 1..100000');
    compiled ??= (async()=>{const bytes=Uint8Array.from(atob(wasmBase64),c=>c.charCodeAt(0));return WebAssembly.compile(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());})().catch(error => { compiled = undefined; throw error; });
    const instance = await WebAssembly.instantiate(await compiled);
    return new TransformStore(instance.exports as Exports, capacity);
  }

  private constructor(private readonly api: Exports, readonly capacity: number) {
    this.handle = api.kernel_new(capacity);
    if (!this.handle) throw new Error('Transform allocation');
    const offset = api.kernel_data(this.handle), buffer = api.memory.buffer;
    const keys = ['x','y','z','qx','qy','qz','qw','sx','sy','sz'] as const;
    this.transforms = Object.fromEntries(keys.map((key, field) => [key, new Float32Array(buffer, offset + field*capacity*4, capacity)])) as typeof this.transforms;
    this.parents = new Float32Array(buffer, offset + 10*capacity*4, capacity);
    this.matrices = new Float32Array(buffer, offset + 11*capacity*4, 16*capacity);
    this.bounds = new Float32Array(buffer, offset + 27*capacity*4, 4*capacity);
    this.planes = new Float32Array(buffer, offset + 35*capacity*4, 24);
    this.rotations=new Float32Array(buffer,offset+(35*capacity+24)*4,capacity*3);
    this.limits=new Float32Array(buffer,offset+(38*capacity+24)*4,capacity*12);
    const flags = api.kernel_flags(this.handle);
    this.active = new Uint8Array(buffer, flags, capacity);
    this.visible = new Uint8Array(buffer, flags+capacity, capacity);
    this.constrained=new Uint8Array(buffer,flags+capacity*2,capacity);
    this.hidden=new Uint8Array(buffer,flags+capacity*3,capacity);
  }

  tick(culling = true): void {
    if (!this.handle) throw new Error('Transforms disposed');
    const error = this.api.kernel_tick(this.handle, +culling);
    if (error) throw new RangeError(error > this.capacity ? 'Invalid frustum' : `Invalid transform/bounds: ${error-1}`);
  }

  dispose(): void {
    if (this.handle) { this.api.kernel_drop(this.handle); this.handle = 0; }
  }
}
