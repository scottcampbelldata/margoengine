/// <reference lib="esnext.disposable" preserve="true" />
import { invertMatrix } from '@margoengine/math/mat4';
import { Picking, type PickHit } from './picking.js';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type RenderView } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };
import type { PickSurface } from './surface.js';

/** GPU mesh hit with perspective-correct UV0 and a world normal and position. Core geometry has no UVs and returns [0, 0]. */
export interface DetailedPickHit extends PickHit {
  position: readonly [number, number, number];
  normal: readonly [number, number, number];
  distance: number;
  uv: readonly [number, number];
}

const normalCode = `fn surfaceNormal(m:mat4x4f,n:vec3f)->vec3f {
 let a=m[0].xyz;let b=m[1].xyz;let c=m[2].xyz;
 return (cross(b,c)*n.x+cross(c,a)*n.y+cross(a,b)*n.z)*sign(dot(a,cross(b,c)));
}`;

/** Extra GPU attributes share the ID pass, submission and asynchronous staging map. */
class Surface implements PickSurface {
  readonly targets: GPUColorTargetState[] = [{ format: 'rgba32float' }, { format: 'rg32float' }];
  views: GPUTextureView[] = [];
  private textures: GPUTexture[] = [];
  setup(device: GPUDevice): void {
    this.dispose();
    this.textures = this.targets.map(({ format }) => device.createTexture({
      size: [3, 3], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    }));
    this.views = this.textures.map(t => t.createView());
  }
  shader(code: string, kind: 'core' | 'model' | 'primitive'): string {
    const output = '@location(5) surfaceNormal:vec3f,@location(6) surfaceUV:vec2f,';
    if (kind === 'core') {
      code = code.replace('struct Output {', 'struct Output {' + output)
        .replace('return Output(', 'return Output(surfaceNormal(model,i.normal),vec2f(0),');
    } else if (kind === 'model') {
      code = code.replace('struct Out {', 'struct Out {' + output)
        .replace('@location(0) position:vec4f,', '@location(0) position:vec4f,@location(1) normal:vec4f,@location(2) uv:vec4f,')
        .replace('return Out(', 'return Out(surfaceNormal(d.model,normal.xyz),uv.xy,');
    } else {
      if (!code.includes('@location(1) normal:vec4f'))
        code = code.replace('struct PickInput {', 'struct PickInput {@location(1) normal:vec4f,');
      code = code.replace('struct Out {', 'struct Out {' + output)
        .replace('var o:Out;', 'var o:Out;o.surfaceNormal=surfaceNormal(f.model,i.normal.xyz);o.surfaceUV=i.uv.xy;');
    }
    code = code.replace(/->@location\(0\) u32\s*\{/, '->SurfacePixel {')
      .replace(/return (i\.id\+1u|i\.info\.x|u32\(f\.info\.x\));/, 'return SurfacePixel($1,vec4f(normalize(i.surfaceNormal),i.clip.z),i.surfaceUV);');
    return normalCode + '\nstruct SurfacePixel {@location(0) id:u32,@location(1) detail:vec4f,@location(2) uv:vec2f}\n' + code;
  }
  buffers(layouts: GPUVertexBufferLayout[], kind: 'core' | 'model' | 'primitive'): GPUVertexBufferLayout[] {
    if (kind === 'core') return layouts;
    return layouts.map((layout, i) => i ? layout : ({ ...layout, attributes: [
      ...Array.from(layout.attributes).filter(a => a.shaderLocation !== 1 && (kind !== 'model' || a.shaderLocation !== 2)),
      { shaderLocation: 1, offset: 16, format: 'float32x4' },
      ...(kind === 'model' ? [{ shaderLocation: 2, offset: 48, format: 'float32x4' as const }] : []),
    ] }));
  }
  copy(encoder: GPUCommandEncoder, buffer: GPUBuffer, offset: number, origin: number[], size: number[]): void {
    this.textures.forEach((texture, i) => encoder.copyTextureToBuffer(
      { texture, origin }, { buffer, offset: offset + 768 * (i + 1), bytesPerRow: 256 }, size,
    ));
  }
  decode(hit: PickHit, data: Uint32Array, offset: number, x: number, y: number, matrix: Float32Array, eye: readonly number[], origin: number[]): void {
    const floats = new Float32Array(data.buffer, data.byteOffset, data.length);
    const n = offset + 192 + y * 64 + x * 4, uv = offset + 384 + y * 64 + x * 2;
    const inverse = invertMatrix(matrix), px = (2 * (origin[0] + x + 0.5)) / 3 - 1, py = 1 - (2 * (origin[1] + y + 0.5)) / 3;
    if (!inverse) throw new MargoError('state', 'Pick camera is singular; use an invertible camera projection.');
    const q = [px, py, floats[n + 3], 1];
    const world = [0, 1, 2, 3].map(r => q.reduce((sum, v, c) => sum + inverse[c * 4 + r] * v, 0));
    const position = world.slice(0, 3).map(v => v / world[3]);
    const normal = [floats[n], floats[n + 1], floats[n + 2]], length = Math.hypot(...normal);
    Object.assign(hit, { position, normal: normal.map(v => v / length), uv: [floats[uv], floats[uv + 1]],
      distance: Math.hypot(...position.map((v, i) => v - eye[i])) });
  }
  dispose(): void {
    for (const texture of this.textures) texture.destroy();
    this.textures = []; this.views = [];
  }
}

/** Picking with GPU surface attributes. Ordinary mesh results gain DetailedPickHit fields; overlays and approximate proxies retain their own contracts. */
export class HitDetails extends Picking {
  constructor() {
    super({ capture: false });
    this.surface = new Surface();
  }
  /** Pick one CSS pixel. Abort rejects promptly; the submitted GPU read completes safely in the pick queue. */
  override pick(x: number, y: number, view?: RenderView, signal?: AbortSignal): Promise<PickHit | null> {
    signal?.throwIfAborted();
    return abortable(super.pick(x, y, view), signal);
  }
  /** Pick a batch with one staging map, including attributes on every mesh hit. */
  override pickMany(points: readonly (readonly [number, number])[], view?: RenderView, signal?: AbortSignal): Promise<(PickHit | null)[]> {
    signal?.throwIfAborted();
    return abortable(super.pickMany(points, view), signal);
  }

  /** Attach instead of Picking, with the same mesh, model, instance and pickMany support. */
  static override attach(engine: EngineKernel): HitDetails {
    const picker = new HitDetails();
    engineRuntime(engine).use(picker);
    return picker;
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
