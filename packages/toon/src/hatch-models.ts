/// <reference lib="esnext.disposable" preserve="true" />
import type { PBRModel, PBRMaterial, PBRMaterialShading } from '@margoengine/gltf-pro';
import { setMaterialDraw, type MaterialDrawCall } from '@margoengine/gltf-pro/material-draw';
import { engineRuntime } from '@margoengine/core/extension';
import { fault } from '../../shared/errors.js';
import { retire, writeUniform } from '../../shared/frame-resources.js';
import { lightPBR } from '../../shared/pbr-hooks.js';
import { HatchStyle, hatchWGSL, type HatchingOptions } from './hatch-style.js';
export type { HatchingOptions } from './hatch-style.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

const binding = 146;
// Basic and matcap materials encode and return early. Wrap the encoder input rather than mixing encoded sRGB.
function earlyPaper(code: string): string {
  let cursor = code.indexOf('@fragment fn fragment(');
  if (cursor < 0) return code;
  for (;;) {
    const call = code.indexOf('mat_out(', cursor);
    if (call < 0) return code;
    let end = call + 8,
      depth = 1;
    while (end < code.length && depth) {
      if (code[end] === '(') depth++;
      if (code[end] === ')') depth--;
      end++;
    }
    if (depth)
      throw fault('unsupported', 'ModelHatching could not read the material encoder; use matching package versions');
    const painted = 'hatchPaper(' + code.slice(call + 8, end - 1) + ',i,s)';
    code = code.slice(0, call + 8) + painted + code.slice(end - 1);
    cursor = call + 8 + painted.length + 1;
  }
}
/**
 * Live hatching/halftone on a glTF-pro model or materials mesh, retaining its textures, deformation and lighting.
 * Pattern units/defaults match core Hatching. Borrowed model/materials remain caller-owned.
 */
export class ModelHatching extends HatchStyle {
  private dead = false;
  private removeDraw?: () => void;
  private unsubscribe?: () => void;
  private context?: MaterialDrawCall['context'];
  private readonly buffers = new Map<GPUDevice, GPUBuffer>();
  private readonly copies = new WeakMap<PBRMaterial, PBRMaterial>();
  /** True after disposal or after the borrowed model was disposed. */
  get disposed(): boolean {
    return this.dead;
  }
  constructor(
    readonly model: PBRModel,
    options: HatchingOptions = {},
  ) {
    super(options);
    if (!model || model.disposed || !Array.isArray(model.primitives) || typeof model.onDispose !== 'function')
      throw fault('disposed', 'ModelHatching needs a live PBRModel or materials mesh; load or create one first');
    if (!engineRuntime(model.root.engine).gpu)
      throw fault('unsupported', 'ModelHatching needs WebGPU or the full WebGL2 compatibility device');
    this.removeDraw = setMaterialDraw(model, (call) => this.draw(call));
    this.unsubscribe = model.onDispose(() => this.dispose());
  }
  /** Attach one pattern adapter to a live model or materials mesh. */
  static attach(model: PBRModel, options: HatchingOptions = {}): ModelHatching {
    return new ModelHatching(model, options);
  }
  private draw(call: MaterialDrawCall): void {
    if (this.dead || !['beauty', 'transparent', 'capture'].includes(call.mode)) {
      call.draw();
      return;
    }
    const previous = this.context;
    this.context = call.context;
    const saved = call.model.primitives.map((p) => p.material);
    try {
      call.model.primitives.forEach((p, i) => {
        p.material = this.material(saved[i]);
      });
      call.draw();
    } finally {
      call.model.primitives.forEach((p, i) => {
        p.material = saved[i];
      });
      this.context = previous;
    }
  }
  private material(original: PBRMaterial): PBRMaterial {
    let copy = this.copies.get(original);
    if (copy) return copy;
    const source = original.shading;
    const shading: PBRMaterialShading = {
      get replacesTextures() {
        return source?.replacesTextures;
      },
      get texturedTint() {
        return source?.texturedTint;
      },
      get shaderRevision() {
        return source?.shaderRevision ?? 0;
      },
      shader: (code, group) => {
        const hooks = source?.pbr?.(group);
        const own = hooks ? lightPBR(code, hooks) : (source?.shader?.(code, group) ?? code);
        return (
          hatchWGSL(binding, group) +
          own.replace('fn surface(i:Out,front:bool)->Surface {', 'fn surface(i:Out,front:bool)->Surface { _=hatch;')
        );
      },
      lit: (code) => {
        const own = earlyPaper(source?.lit?.(code) ?? code);
        const fragment = own.indexOf('@fragment fn fragment('),
          display = own.indexOf('if(f.settings.w<0.5)', fragment);
        if (fragment < 0 || display < 0)
          throw fault(
            'unsupported',
            'ModelHatching needs the standard PBR display hook; use matching package versions',
          );
        // Find a statement boundary, not a newline: built materials may write their whole fragment on one line.
        // An output/fog hook puts a tone-mapping assignment immediately before the display if. Ink precedes it.
        const boundary = (end: number): number =>
          Math.max(own.lastIndexOf(';', end - 1), own.lastIndexOf('}', end - 1), own.indexOf('{', fragment)) + 1;
        let line = boundary(display);
        const previous = boundary(line - 1);
        if (own.slice(previous, line).includes('pbrNeutral(max(color,')) line = previous;
        return (
          own.slice(0, line) +
          'color=hatchPaper(color,i,s);\n' +
          own.slice(line) +
          '\nfn hatchPaper(paper:vec3f,i:Out,s:Surface)->vec3f {return mix(paper,hatch.ink.rgb,hatchInk(i.clip.xy,max(dot(s.n,f.light.xyz),0.0)));}\n'
        );
      },
      bindings: () => {
        const c = this.context!,
          device = c.device;
        let buffer = this.buffers.get(device);
        if (!buffer) {
          this.buffers.set(
            device,
            (buffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })),
          );
          const owned = buffer;
          void device.lost?.then(() => {
            if (this.buffers.get(device) === owned) {
              retire(device, owned);
              this.buffers.delete(device);
            }
          });
        }
        const uniform = writeUniform(device, buffer, this.hatchValues() as Float32Array<ArrayBuffer>, c.view ?? c);
        return [...(source?.bindings() ?? []), { binding, resource: uniform ?? { buffer } }];
      },
    };
    copy = Object.create(original, { shading: { value: shading, enumerable: true } }) as PBRMaterial;
    this.copies.set(original, copy);
    return copy;
  }
  /** Remove the adapter and release only its uniforms. Idempotent; original records are never modified. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.removeDraw?.();
    this.unsubscribe?.();
    for (const [device, buffer] of this.buffers) retire(device, buffer);
    this.buffers.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
