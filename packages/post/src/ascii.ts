import type { EngineKernel } from '@margoengine/core';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';
import { glyphAtlas } from './ascii-glyphs.js';

/** Character-cell rendering controls, read every frame. */
export interface ASCIIOptions {
  /** Ramp from least to most ink, 2..250 characters. Default ' .:-+=*%#@'. Printable ASCII unless `font` is set. */
  characters?: string;
  /** Drawing-buffer pixels per character: a square side or [width, height], whole numbers 4..64. Default [12, 16]. */
  cellSize?: number | readonly [number, number];
  /** CSS font family drawn through OffscreenCanvas, e.g. 'monospace'. Default unset: the built-in bitmap glyphs. */
  font?: string;
  /** Pixel size of `font`, above 0 up to 256. Default the cell height. The built-in glyphs ignore it. */
  fontSize?: number;
  /** Ink colour: '#rgb', '#rrggbb', or 'scene' for the cell's average colour. Default 'scene'. */
  color?: string;
  /** Paper colour, same forms; 'scene' paints colour blocks. Default '#000000'. */
  background?: string;
  /** Dense characters for dark cells instead of bright ones. Default false. */
  invert?: boolean;
  /** Draw a cell holding one strong edge with a character along it. Default false. */
  edges?: boolean;
  /** Four characters for vertical, rising, horizontal and falling edges. Default '|/-\\'. */
  edgeCharacters?: string;
  /** Luminance step, 0..1, a straight edge needs to count. Default 0.2. */
  edgeThreshold?: number;
  /** Mix over the scene, 0..1. Default 1. */
  intensity?: number;
  /** Default true. */
  enabled?: boolean;
}
const RAMP = ' .:-+=*%#@',
  EDGES = '|/-\\',
  CELL = [12, 16] as const,
  hex = /^#([0-9a-f]{3}){1,2}$/i;
/** [r, g, b, 0] of a hex colour, or [0, 0, 0, 1] for 'scene'. */
const paint = (value: string): number[] => {
  if (value === 'scene') return [0, 0, 0, 1];
  const long = value.length === 4 ? value.replace(/[^#]/g, '$&$&') : value;
  return [1, 3, 5].map((i) => parseInt(long.slice(i, i + 2), 16) / 255).concat(0);
};
const head = `${fullscreen}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var<uniform> u:array<vec4f,4>;`;
// One fragment per texel of a (2 * columns) x rows target: even texels hold the cell's mean premultiplied colour, odd
// texels its character index / 255. Edges: the structure tensor of central luminance differences summed over the cell.
const choose = `${head}
fn luma(c:vec3f)->f32{return dot(c,vec3f(0.2126,0.7152,0.0722));}
fn lit(p:vec2i)->f32{return luma(textureLoad(scene,clamp(p,vec2i(0),vec2i(textureDimensions(scene))-1),0).rgb);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let q=vec2i(p.xy);let size=vec2i(u[0].xy);let origin=vec2i(q.x/2,q.y)*size;
 let end=min(origin+size,vec2i(textureDimensions(scene)));let glyph=(q.x&1)==1;let edges=glyph&&u[1].y>0.0;
 var sum=vec4f(0);var j=vec3f(0);
 for(var y=origin.y;y<end.y;y++){for(var x=origin.x;x<end.x;x++){
  let t=vec2i(x,y);sum+=textureLoad(scene,t,0);
  if(edges){let g=0.5*vec2f(lit(t+vec2i(1,0))-lit(t-vec2i(1,0)),lit(t+vec2i(0,1))-lit(t-vec2i(0,1)));j+=vec3f(g*g,g.x*g.y);}
 }}
 let mean=sum/f32(max((end.x-origin.x)*(end.y-origin.y),1));
 if(!glyph){return mean;}
 let count=u[0].z;var i=min(floor(clamp(luma(mean.rgb),0.0,1.0)*count),count-1.0);
 if(u[1].x>0.0){i=count-1.0-i;}
 let energy=j.x+j.y;
 if(edges&&energy>u[1].z){
  let d=vec2f(j.x-j.y,2.0*j.z);
  if(length(d)>=0.5*energy){i=count+f32((i32(round(atan2(d.y,d.x)*0.636619772))+4)%4);}
 }
 return vec4f(i/255.0,0.0,0.0,1.0);
}`;
const compose = `${head}
@group(0) @binding(2) var cells:texture_2d<f32>;
@group(0) @binding(3) var atlas:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let q=vec2i(p.xy);let s=textureLoad(scene,q,0);if(u[0].w<=0.0){return s;}
 let size=vec2i(u[0].xy);let cell=q/size;
 let mean=textureLoad(cells,vec2i(cell.x*2,cell.y),0);
 let i=i32(round(textureLoad(cells,vec2i(cell.x*2+1,cell.y),0).r*255.0));
 let ink=textureLoad(atlas,vec2i(i%16,i/16)*size+q-cell*size,0).r;
 let own=min(mean.rgb/max(mean.a,1e-6),vec3f(1));
 let colour=mix(mix(u[3].rgb,own,u[3].a),mix(u[2].rgb,own,u[2].a),ink);
 return mix(s,vec4f(colour*mean.a,mean.a),u[0].w);
}`;

/**
 * Redraws the frame as a grid of characters picked by each cell's average luminance, with optional characters along
 * strong edges. An LDR PostStack stage.
 */
export class ASCII extends ScreenEffect {
  readonly name = 'ascii';
  protected readonly kind = 'ldr';
  private readonly values = new Float32Array(16);
  private atlas?: { key: string; view: GPUTextureView };
  private cells?: GPUTextureView;
  private grid?: { columns: number; rows: number; glyphs: string[] };
  constructor(readonly options: ASCIIOptions = {}) {
    super();
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: ASCIIOptions = {}): ASCII {
    const effect = new ASCII(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  protected check(): void {
    const o = this.options;
    for (const key of ['invert', 'edges', 'enabled'] as const)
      if (o[key] !== undefined && typeof o[key] !== 'boolean') throw new TypeError(`Use ASCII ${key} as true or false`);
    for (const key of ['characters', 'edgeCharacters', 'font', 'color', 'background'] as const)
      if (o[key] !== undefined && typeof o[key] !== 'string') throw new TypeError(`Use ASCII ${key} as a string`);
    const ramp = [...(o.characters ?? RAMP)],
      edge = [...(o.edgeCharacters ?? EDGES)];
    if (ramp.length < 2 || ramp.length > 250 || edge.length !== 4)
      throw new RangeError('Use 2 to 250 ASCII characters and 4 edgeCharacters');
    if (o.font === undefined && ![...ramp, ...edge].every((c) => c >= ' ' && c <= '~'))
      throw new RangeError('Use printable ASCII characters, or set an ASCII font that has the others');
    if (o.font !== undefined && !o.font.trim()) throw new RangeError('Use a CSS font family as the ASCII font');
    const size = o.cellSize ?? CELL,
      pair = typeof size === 'number' ? [size, size] : size;
    if (!(pair.length === 2 && pair.every((v) => Number.isInteger(v) && v >= 4 && v <= 64)))
      throw new RangeError('Use ASCII cellSize as whole pixels from 4 to 64, one number or [width, height]');
    if (o.fontSize !== undefined && !(Number.isFinite(o.fontSize) && o.fontSize > 0 && o.fontSize <= 256))
      throw new RangeError('Use ASCII fontSize above 0 up to 256');
    for (const key of ['color', 'background'] as const)
      if (o[key] !== undefined && o[key] !== 'scene' && !hex.test(o[key]!))
        throw new RangeError(`Use ASCII ${key} as 'scene', '#rgb' or '#rrggbb'`);
    for (const key of ['intensity', 'edgeThreshold'] as const)
      if (o[key] !== undefined && !(Number.isFinite(o[key]) && o[key]! >= 0 && o[key]! <= 1))
        throw new RangeError(`Use ASCII ${key} from 0 to 1`);
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      size = o.cellSize ?? CELL,
      [width, height] = typeof size === 'number' ? [size, size] : size,
      ramp = o.characters ?? RAMP,
      edge = o.edgeCharacters ?? EDGES,
      on = o.enabled !== false;
    const key = JSON.stringify([ramp, edge, width, height, o.font, o.fontSize]);
    if (this.atlas?.key !== key) {
      const image = glyphAtlas([...ramp, ...edge], width, height, o.font, o.fontSize);
      this.textures[0]?.destroy();
      const texture = (this.textures[0] = c.device.createTexture({
        size: [image.width, image.height],
        format: 'r8unorm',
        usage: 0x4 | 0x2,
      }));
      c.device.queue.writeTexture({ texture }, image.data, { bytesPerRow: image.width }, [image.width, image.height]);
      this.atlas = { key, view: texture.createView() };
    }
    const columns = Math.ceil(c.width / width),
      rows = Math.ceil(c.height / height);
    if (this.textures[1]?.width !== columns * 2 || this.textures[1].height !== rows) {
      this.textures[1]?.destroy();
      this.textures[1] = c.device.createTexture({
        size: [columns * 2, rows],
        format: 'rgba8unorm',
        usage: 0x10 | 0x4 | 0x1,
      });
      this.cells = this.textures[1].createView();
    }
    this.values.set([
      width,
      height,
      [...ramp].length,
      on ? (o.intensity ?? 1) : 0,
      +(o.invert ?? false),
      +(o.edges ?? false),
      // A straight step of contrast t across a cell sums to about t^2 (width + height) / 4 of squared differences.
      ((o.edgeThreshold ?? 0.2) ** 2 * (width + height)) / 4,
      0,
      ...paint(o.color ?? 'scene'),
      ...paint(o.background ?? '#000000'),
    ]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    this.grid = on ? { columns, rows, glyphs: [...ramp, ...edge] } : undefined;
    // The cell grid has its own size, so it never takes this view's viewport.
    if (on)
      this.draw(
        { ...c, view: undefined },
        choose,
        { view: this.cells!, format: 'rgba8unorm', multisample: { count: 1 }, hdr: false },
        [input, { buffer: this.uniform! }],
      );
    this.draw(c, compose, output, [input, { buffer: this.uniform! }, this.cells!, this.atlas.view]);
  }
  /**
   * The characters of the last drawn frame, one line per cell row from the top, read back from the GPU.
   * @throws MargoError `'state'` before a frame has drawn with the effect enabled.
   */
  async text(controls: { signal?: AbortSignal } = {}): Promise<string> {
    const { signal } = controls;
    signal?.throwIfAborted();
    const grid = this.grid,
      device = this.engine?.gpu;
    if (!grid || !device) throw margoError('state', 'ASCII.text needs a drawn frame with the effect enabled');
    const bytesPerRow = Math.ceil(grid.columns / 32) * 256,
      buffer = device.createBuffer({ size: bytesPerRow * grid.rows, usage: 0x1 | 0x8 }),
      stop = () => buffer.destroy();
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: this.textures[1] }, { buffer, bytesPerRow }, [
        grid.columns * 2,
        grid.rows,
      ]);
      device.queue.submit([encoder.finish()]);
      signal?.addEventListener('abort', stop, { once: true });
      await buffer.mapAsync(0x1);
      signal?.throwIfAborted();
      const bytes = new Uint8Array(buffer.getMappedRange());
      return Array.from({ length: grid.rows }, (_, y) =>
        Array.from({ length: grid.columns }, (_, x) => grid.glyphs[bytes[y * bytesPerRow + x * 8 + 4]]).join(''),
      ).join('\n');
    } catch (error) {
      // An abort destroys the buffer, which rejects the map: report the caller's reason instead.
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop);
      buffer.destroy();
    }
  }
  protected override release(): void {
    super.release();
    this.atlas = undefined;
    this.cells = undefined;
    this.grid = undefined;
  }
}
