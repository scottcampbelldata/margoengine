import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type PassContext } from '@margoengine/core/extension';
import { viewSize } from '../../shared/view-rect.js';
import { Toon as WorldToon, type ToonPipelineOptions } from './index.js';
import { ModelOutlines as WorldModelOutlines, type ModelOutlineOptions } from './models.js';
export type { ToonPipelineOptions } from './index.js';
export type { ModelOutlineOptions, OutlineStyle } from './models.js';

// Differentiate homogeneous projection before division. Normalize in viewport pixels, then map the requested
// pixel displacement back to clip XY. Keep clip Z/W: only the silhouette expands, including orthographic views.
const projection = `
fn pixelHull(p:vec4f,n:vec4f,size:vec2f,width:f32)->vec4f{
  let direction=(n.xy*p.w-p.xy*n.w)*size;
  let magnitude=length(direction);
  var result=p;
  if(magnitude>1e-8&&p.w>0.0){result.x+=direction.x/magnitude*2.0*width/size.x*p.w;result.y+=direction.y/magnitude*2.0*width/size.y*p.w;}
  return result;
}`;

/** Core toon shading and inverted hulls in drawing-buffer pixels. Default outline 3; range 0-1024 pixels. */
export class Toon extends WorldToon {
  private readonly pixelValues = new Float32Array(8);
  protected override get maxOutline(): number {
    return 1024;
  }
  constructor(options: ToonPipelineOptions = {}) {
    super({ outline: 3, ...options });
  }
  static override attach(engine: EngineKernel, options: ToonPipelineOptions = {}): Toon {
    const effect = new Toon(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  protected override outlineData(context?: PassContext): Float32Array {
    this.pixelValues.set(this.values);
    this.pixelValues.set(context ? viewSize(context) : [1, 1], 4);
    return this.pixelValues;
  }
  protected override outlineShader(code: string): string {
    return (
      projection +
      code
        .replace('var<uniform> outline:vec4f;', 'var<uniform> screen:array<vec4f,2>;')
        .replaceAll('outline.', 'screen[0].')
        .replace(
          'let p=model*vec4f(i.position,1)+vec4f(normal*screen[0].w,0);return Output(frame.camera*p,',
          'let p=frame.camera*model*vec4f(i.position,1);let clip=pixelHull(p,frame.camera*vec4f(normal,0),screen[1].xy,screen[0].w);return Output(clip,',
        )
    );
  }
}

/** Model hulls in drawing-buffer pixels, including live per-material widths, vertex paint and deformed meshes. */
export class ModelOutlines extends WorldModelOutlines {
  protected override get maxOutline(): number {
    return 1024;
  }
  constructor(options: ModelOutlineOptions = {}) {
    super({ outline: 3, ...options });
  }
  static override attach(engine: EngineKernel, options: ModelOutlineOptions = {}): ModelOutlines {
    const effect = new ModelOutlines(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  protected override outlineFrame(values: Float32Array, context: Extract<PassContext, { backend: 'webgpu' }>): void {
    values.set(viewSize(context), 17);
  }
  protected override outlineShader(code: string): string {
    return (
      projection +
      code.replace(
        'return Out(u.camera*p,d.style.rgb*paint.rgb);',
        'let clip=u.camera*m*vec4f(position,1);return Out(pixelHull(clip,u.camera*vec4f(n,0),u.flags.yz,d.style.w*paint.a),d.style.rgb*paint.rgb);',
      )
    );
  }
}
