/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/inspector/mesh-debug: draws the mesh data over (or in place of) each mesh's own picture, without
// touching its material or geometry. Every triangle corner is pulled from storage buffers by `vertex_index`, so skinned
// and morphed vertices are read live and no mesh is rewritten to unshared vertices.
// Edges: a fragment's screen distance to an edge is a barycentric coordinate over the length of its screen gradient
// (J. A. Bærentzen, S. Munk-Lund, M. Gjøl and B. D. Larsen, "Two methods for antialiased wireframe drawing with
// hidden line removal", Spring Conference on Computer Graphics 2008,
// https://orbit.dtu.dk/en/publications/two-methods-for-antialiased-wireframe-drawing-with-hidden-line-re/).
// The checker is box filtered over the pixel by integrating the square wave of each axis (A. Norton, A. P. Rockwood
// and P. T. Skolmoski, "Clamping: a method of antialiasing textured surfaces by bandwidth limiting in object space",
// SIGGRAPH 1982, https://doi.org/10.1145/800064.801252). The camera-lit shading is J. F. Blinn's highlight ("Models
// of light reflection for computer synthesized pictures", SIGGRAPH 1977, https://doi.org/10.1145/563858.563893) with
// the light at the eye. Generated material colours step the hue by the golden ratio, which keeps any run of hues well
// apart (S. Świerczkowski, "On successive settings of an arc on the circumference of a circle", Fundamenta
// Mathematicae 46, 1958, https://doi.org/10.4064/fm-46-2-187-189).
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type Geometry,
  type Mesh,
  type PassContext,
} from '@margoengine/core/extension';
import { geometrySurface, meshSource, type MeshDraw, type MeshSource } from '../../shared/mesh-source.js';
import { instanceLayout } from '../../shared/instances.js';
import { applyView, inView, viewRect } from '../../shared/view-rect.js';
import { currentFrame, retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
import { beginScenePass, sceneAttachments } from '../../shared/scene-pass.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { linearHdr } from '../../shared/hdr-format.js';
import { hexColor } from '../../shared/clear-color.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { VERTEX: number; UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** What a {@link MeshDebugView} shows. */
export type MeshDebugMode =
  | 'shaded'
  | 'wireframe'
  | 'vertices'
  | 'wireframe-vertices'
  | 'uv0'
  | 'uv1'
  | 'vertex-colors'
  | 'material-ids';
// The shader reads a mode as its place in this list.
const modes: readonly MeshDebugMode[] = [
  'shaded',
  'wireframe',
  'vertices',
  'wireframe-vertices',
  'uv0',
  'uv1',
  'vertex-colors',
  'material-ids',
];
/** `#rgb` or `#rrggbb` (sRGB), or linear `[r, g, b]` in 0..1. */
export type MeshDebugColor = string | readonly [number, number, number];
/** Options of {@link MeshDebugView}; every one is live through {@link MeshDebugView.set}. */
export interface MeshDebugViewOptions {
  /**
   * `'wireframe'` (every triangle edge), `'vertices'` (a dot on every vertex), `'wireframe-vertices'` (both), `'uv0'` or
   * `'uv1'` (a checker over that UV set), `'vertex-colors'`, `'material-ids'` (one colour per material) or `'shaded'`
   * (plain camera-lit shading). Default `'wireframe'`.
   */
  mode?: MeshDebugMode;
  /**
   * True keeps the mesh's own picture: lines and dots draw over it, and the checker, vertex colours, material colours
   * and shading multiply it. False replaces the picture: camera-lit shading under the lines and dots, a lit checker or
   * material colour, unlit vertex colours. `null` restores the default: true for the three wire and dot modes, false
   * for the others.
   */
  multiply?: boolean | null;
  /** Meshes to draw, from the view's scene; meshes without triangles are skipped. Default `null`: every mesh of it. */
  meshes?: Iterable<MeshHandle> | null;
  /** False draws nothing and frees the view's mesh buffers within two frames. Default true. */
  enabled?: boolean;
  /** Edge colour. Default `'#72e8cc'`. */
  wireColor?: MeshDebugColor;
  /** Edge width in drawing-buffer pixels, 0 to 64. Default 1. */
  wireWidth?: number;
  /** Vertex dot colour. Default `'#ffb326'`. */
  vertexColor?: MeshDebugColor;
  /** Vertex dot radius in drawing-buffer pixels, 0 to 64. Default 3. */
  vertexRadius?: number;
  /** Checker squares per UV unit along each axis, above 0 and at most 4096. Default 10. */
  uvScale?: number;
  /** The checker's two colours; the first covers the square at UV (0, 0). Default `['#f0f0f0', '#3a6ea5']`. */
  uvColors?: readonly [MeshDebugColor, MeshDebugColor];
  /** Surface colour of the camera-lit shading under `shaded`, wire and dot modes. Default `'#a0a0a0'`. */
  diffuseColor?: MeshDebugColor;
  /** Highlight colour of the camera-lit shading. Default `'#303030'`. */
  specularColor?: MeshDebugColor;
  /** Highlight exponent, 1 to 10000. Default 32. */
  specularPower?: number;
  /**
   * Colours of the first materials of `'material-ids'`, in the order the view first draws them (at most 4096); later
   * materials get generated hues. Default `[]`.
   */
  materialColors?: readonly MeshDebugColor[];
}

/** The settings in effect: every option filled in, `multiply` resolved for the mode. */
export type MeshDebugViewSettings = Readonly<
  Required<Omit<MeshDebugViewOptions, 'multiply' | 'meshes'>> & {
    multiply: boolean;
    meshes: readonly MeshHandle[] | null;
  }
>;
type Rgb = [number, number, number];

const help = 'mesh-debug-view';
const defaults = {
  mode: 'wireframe',
  multiply: null,
  meshes: null,
  enabled: true,
  wireColor: '#72e8cc',
  wireWidth: 1,
  vertexColor: '#ffb326',
  vertexRadius: 3,
  uvScale: 10,
  uvColors: ['#f0f0f0', '#3a6ea5'],
  diffuseColor: '#a0a0a0',
  specularColor: '#303030',
  specularPower: 32,
  materialColors: [],
} as const satisfies Required<MeshDebugViewOptions>;

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
function rgb(value: unknown, name: string): Rgb {
  if (typeof value === 'string') {
    const hex = hexColor(value);
    if (hex >= 0) return [16, 8, 0].map((shift) => toLinear(((hex >> shift) & 255) / 255)) as Rgb;
  } else if (Array.isArray(value) && value.length === 3 && value.every(unit)) return [value[0], value[1], value[2]];
  throw typeError(`MeshDebugView ${name} must be '#rgb', '#rrggbb' or three linear numbers in 0..1`, help);
}

/** Linear colour of the generated material hue `index` (0 up): golden-ratio hue steps, every second one darker. */
function materialHue(index: number): [number, number, number] {
  const hue = (index * 0.6180339887498949) % 1,
    value = index % 2 ? 0.75 : 0.95;
  return [5, 3, 1].map((n) => {
    const k = (n + hue * 6) % 6;
    return toLinear(value * (1 - 0.7 * Math.max(0, Math.min(k, 4 - k, 1))));
  }) as Rgb;
}

// Pass kinds: 0 replaces the picture (opaque), 1 multiplies it, 2 paints lines and dots over it.
// A corner behind the eye has no place on screen, so its dot is put far away. Derivatives come before any discard. The
// 2e-5 added to the checker coordinate puts a constant UV on a square's boundary (a mesh without that set reads 0) in the
// square after it. The light sits at the eye: the highlight's half vector is the view vector, and both faces light alike.
const code = `
struct View {camera:mat4x4f,model:mat4x4f,eye:vec4f,viewport:vec4f,wire:vec4f,dot:vec4f,checkA:vec4f,checkB:vec4f,
  base:vec4f,specular:vec4f,params:vec4f,offsets:vec4f,flags:vec4f}
@group(0) @binding(0) var<uniform> u:View;
@group(0) @binding(1) var<storage,read> vertices:array<f32>;
@group(0) @binding(2) var<storage,read> indices:array<u32>;
struct Out {@builtin(position) clip:vec4f,@location(0) bary:vec3f,@location(1) position:vec3f,@location(2) normal:vec3f,
  @location(3) uv:vec4f,@location(4) color:vec3f,@location(5) @interpolate(flat) ab:vec4f,
  @location(6) @interpolate(flat) c:vec3f}
fn read2(at:u32)->vec2f{return vec2f(vertices[at],vertices[at+1u]);}
fn read3(at:u32)->vec3f{return vec3f(vertices[at],vertices[at+1u],vertices[at+2u]);}
@vertex fn vertex(@builtin(vertex_index) id:u32,@location(5) m0:vec4f,@location(6) m1:vec4f,@location(7) m2:vec4f,
  @location(8) m3:vec4f)->Out{
  let model=u.model*mat4x4f(m0,m1,m2,m3);
  let stride=u32(u.offsets.x);let corner=id%3u;let first=id-corner;
  var screen=array<vec2f,3>();
  for(var k=0u;k<3u;k++){
    let q=u.camera*(model*vec4f(read3(indices[first+k]*stride),1.0));
    screen[k]=select(vec2f(-1e6),(q.xy/q.w*vec2f(0.5,-0.5)+0.5)*u.viewport.zw+u.viewport.xy,q.w>0.0);
  }
  let at=indices[id]*stride;
  let world=model*vec4f(read3(at),1.0);
  let a=model[0].xyz;let b=model[1].xyz;let c=model[2].xyz;
  var o:Out;
  o.clip=u.camera*world;
  o.bary=vec3f(f32(corner==0u),f32(corner==1u),f32(corner==2u));
  o.position=world.xyz;
  o.normal=mat3x3f(cross(b,c),cross(c,a),cross(a,b))*read3(at+u32(u.offsets.y));
  o.uv=vec4f(0.0);
  if(u.offsets.z>0.0){
    let t=at+u32(u.offsets.z);
    o.uv=vec4f(read2(t),0.0,0.0);
    if(u.offsets.w>0.0){o.uv=vec4f(o.uv.xy,read2(t+2u));}
  }
  o.color=vec3f(1.0);
  if(u.offsets.w>0.0){o.color=read3(at+u32(u.offsets.w));}
  o.ab=vec4f(screen[0],screen[1]);
  o.c=vec3f(screen[2],select(0.0,1.0,dot(a,cross(b,c))<0.0));
  return o;
}
fn encode(c:vec3f)->vec3f{
  if(u.flags.y>0.5){return c;}
  let v=clamp(c,vec3f(0.0),vec3f(1.0));
  return select(1.055*pow(v,vec3f(1.0/2.4))-0.055,v*12.92,v<=vec3f(0.0031308));
}
@fragment fn fragment(i:Out,@builtin(front_facing) facing:bool)->@location(0) vec4f{
  let mode=u32(u.params.w);let pass_=u32(u.flags.x);
  let gx=dpdx(i.bary);let gy=dpdy(i.bary);
  let uv=select(i.uv.xy,i.uv.zw,mode==5u)*u.params.z+2e-5;
  let w=max(fwidth(uv),vec2f(1e-5));
  let front=facing!=(i.c.z>0.5);
  if((u.flags.z==1.0&&!front)||(u.flags.z==2.0&&front)){discard;}
  var surface=u.base.rgb;
  if(mode==4u||mode==5u){
    let s=2.0*(abs(fract((uv-0.5*w)*0.5)-0.5)-abs(fract((uv+0.5*w)*0.5)-0.5))/w;
    surface=mix(u.checkA.rgb,u.checkB.rgb,clamp(0.5-0.5*s.x*s.y,0.0,1.0));
  }
  if(mode==6u){surface=i.color;}
  let view=u.eye.xyz-i.position*u.eye.w;
  let ndv=min(abs(dot(i.normal,view))/max(length(i.normal)*length(view),1e-20),1.0);
  if(mode!=6u&&(pass_==0u||mode==0u)){surface=surface*ndv+u.specular.rgb*pow(ndv,u.specular.w);}
  var wire=0.0;var point=0.0;
  if((mode==1u||mode==3u)&&u.params.x>0.0){
    let d=i.bary/max(sqrt(gx*gx+gy*gy),vec3f(1e-8));
    wire=clamp(u.params.x*0.5+0.5-min(d.x,min(d.y,d.z)),0.0,1.0);
  }
  if((mode==2u||mode==3u)&&u.params.y>0.0){
    let p=i.clip.xy;
    let d=min(distance(p,i.ab.xy),min(distance(p,i.ab.zw),distance(p,i.c.xy)));
    point=clamp(u.params.y+0.5-d,0.0,1.0);
  }
  if(pass_==2u){
    let alpha=point+wire*(1.0-point);
    if(alpha<=0.0){discard;}
    let color=(u.wire.rgb*wire*(1.0-point)+u.dot.rgb*point)/alpha;
    return vec4f(encode(color)*alpha,alpha);
  }
  return vec4f(encode(mix(mix(surface,u.wire.rgb,wire),u.dot.rgb,point)),1.0);
}`;

const identity = new Float32Array(24);
identity[0] = identity[5] = identity[10] = identity[15] = 1;
const FLOATS = 76,
  // Positive depth bias moves toward the eye under reversed Z; the mesh's own surface then never wins the tie.
  BIAS = 4;

/** An uploaded copy of a mesh array, kept while a draw reads it. */
interface Upload {
  buffer: GPUBuffer;
  tag: unknown;
  used: boolean;
}
/** One draw's uniform and bind groups. */
interface DrawRecord {
  uniform: GPUBuffer;
  vertex: GPUBuffer;
  offset: number;
  size: number;
  index: GPUBuffer;
  groups: { get(copy?: GPUBufferBinding): GPUBindGroup };
  used: boolean;
}
interface Item {
  key: object;
  matrix: ArrayLike<number>;
  vertex: GPUBuffer;
  offset: number;
  size: number;
  index: GPUBuffer;
  count: number;
  instances: GPUBuffer;
  copies: number;
  stride: number;
  uvAt: number;
  colorAt: number;
  side: number;
  material: object;
}

/**
 * A debug view of mesh data: wireframe, vertex dots, a UV checker, vertex colours, material colours or plain camera-lit
 * shading, over or in place of each mesh's picture. Draws core meshes and gltf/pbr nodes (also materials meshes), with
 * their live skinned or morphed vertices and instance matrices, after the transparent surfaces.
 *
 * `MeshDebugView.attach(engine, { mode: 'uv0' })`; WebGPU or the WebGL2 compatibility layer.
 * @throws TypeError or RangeError for an invalid option.
 * @throws MargoError `'unsupported'` on native WebGL2, `'disposed'` after `dispose()`.
 */
export class MeshDebugView implements EnginePlugin {
  readonly name = 'inspector:mesh-debug:' + next++;
  private settings!: MeshDebugViewSettings;
  /** The caller's `multiply`, null while the mode decides. */
  private multiplied: boolean | null = null;
  private colors!: { wire: Rgb; dot: Rgb; a: Rgb; b: Rgb; diffuse: Rgb; specular: Rgb; materials: Rgb[] };
  private ids = new WeakMap<object, number>();
  private nextId = 0;
  private frame = -1;
  private engine?: Engine;
  private disposed = false;
  private layout?: GPUBindGroupLayout;
  private module?: GPUShaderModule;
  private single?: GPUBuffer;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly records = new Map<object, DrawRecord>();
  private readonly uploads = new Map<object, Upload>();
  private readonly values = new Float32Array(FLOATS);
  private readonly attachments = sceneAttachments();

  constructor(options: MeshDebugViewOptions = {}) {
    this.set(options);
  }

  /** Creates the view and attaches it to the engine's active scene. */
  static attach(engine: EngineKernel, options?: MeshDebugViewOptions): MeshDebugView {
    const view = new MeshDebugView(options);
    engineRuntime(engine).use(view);
    return view;
  }

  /** The settings in effect, defaults filled in and `multiply` resolved for the mode. Frozen; change with `set`. */
  get options(): MeshDebugViewSettings {
    return this.settings;
  }

  /**
   * Changes settings from the next frame; omitted ones keep their value. All are checked before any changes.
   * @throws TypeError or RangeError for an unknown option or an invalid value; MargoError `'disposed'`.
   */
  set(options: MeshDebugViewOptions): this {
    if (this.disposed) throw fault('disposed', 'MeshDebugView was disposed; attach a new MeshDebugView', help);
    if (!options || typeof options !== 'object')
      throw typeError('MeshDebugView options must be an object; pass { mode: ... }', help);
    for (const key of Object.keys(options))
      if (!Object.hasOwn(defaults, key))
        throw typeError(`MeshDebugView has no option '${key}'; use ${Object.keys(defaults).join(', ')}`, help);
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
      s = { ...defaults, ...this.settings, ...given } as Required<MeshDebugViewOptions>,
      multiply = options.multiply === undefined ? this.multiplied : options.multiply;
    if (!modes.includes(s.mode)) throw typeError(`MeshDebugView mode must be one of ${modes.join(', ')}`, help);
    if (multiply !== null && typeof multiply !== 'boolean')
      throw typeError('MeshDebugView multiply must be true, false or null', help);
    if (typeof s.enabled !== 'boolean') throw typeError('MeshDebugView enabled must be true or false', help);
    const range = (key: 'wireWidth' | 'vertexRadius' | 'uvScale' | 'specularPower', low: number, high: number) => {
      const v = s[key];
      if (!(typeof v === 'number' && v >= low && v <= high))
        throw rangeError(`MeshDebugView ${key} must be a number from ${low} to ${high}`, help);
    };
    range('wireWidth', 0, 64);
    range('vertexRadius', 0, 64);
    range('uvScale', 1e-6, 4096);
    range('specularPower', 1, 10000);
    if (!Array.isArray(s.uvColors) || s.uvColors.length !== 2)
      throw typeError('MeshDebugView uvColors must be two colours', help);
    if (!Array.isArray(s.materialColors) || s.materialColors.length > 4096)
      throw typeError('MeshDebugView materialColors must be an array of at most 4096 colours', help);
    let meshes = s.meshes as MeshHandle[] | null;
    if (given.meshes !== undefined && given.meshes !== null) {
      const list = typeof given.meshes === 'object' && Symbol.iterator in (given.meshes as object);
      meshes = list ? [...(given.meshes as Iterable<MeshHandle>)] : null;
      if (!meshes || !meshes.every((m) => m && typeof m === 'object' && typeof (m as unknown as Mesh).id === 'number'))
        throw typeError('MeshDebugView meshes must be a list of meshes or null', help);
      Object.freeze(meshes);
    }
    const colors = {
      wire: rgb(s.wireColor, 'wireColor'),
      dot: rgb(s.vertexColor, 'vertexColor'),
      a: rgb(s.uvColors[0], 'uvColors[0]'),
      b: rgb(s.uvColors[1], 'uvColors[1]'),
      diffuse: rgb(s.diffuseColor, 'diffuseColor'),
      specular: rgb(s.specularColor, 'specularColor'),
      materials: s.materialColors.map((c, i) => rgb(c, `materialColors[${i}]`)),
    };
    this.colors = colors;
    this.multiplied = multiply;
    this.settings = Object.freeze({
      ...s,
      meshes,
      multiply: multiply ?? (s.mode === 'wireframe' || s.mode === 'vertices' || s.mode === 'wireframe-vertices'),
    });
    return this;
  }

  /** Forgets which material got which colour, so `'material-ids'` assigns them again in draw order. */
  resetMaterialIds(): void {
    this.ids = new WeakMap();
    this.nextId = 0;
  }

  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'MeshDebugView was disposed; attach a new MeshDebugView', help);
    const limits = engine.gpu?.limits as (GPUSupportedLimits & { maxStorageBuffersInVertexStage?: number }) | undefined;
    if (!limits || limits.maxStorageBuffersInVertexStage === 0)
      throw fault(
        'unsupported',
        'MeshDebugView reads vertices from storage buffers; create the engine on WebGPU or the WebGL2 compatibility layer',
        help,
      );
    this.engine = engine;
  }

  registerPasses(graph: FrameGraph): void {
    // After the opaque and transparent surfaces (1 to 2.95), before the effects at 3 and up.
    graph.add({
      name: this.name,
      order: 2.99,
      joins: true,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  /**
   * Frees what the last drawn frame did not use (removed meshes, replaced geometry). It runs from the pass, not from
   * `onPreUpdate`, which a pick runs between two frames too.
   */
  private sweep(device: GPUDevice): void {
    const frame = currentFrame(device);
    if (frame === this.frame) return;
    this.frame = frame;
    for (const [key, record] of this.records) {
      if (!record.used) {
        retire(device, record.uniform);
        this.records.delete(key);
      } else record.used = false;
    }
    for (const [key, upload] of this.uploads) {
      if (!upload.used) {
        retire(device, upload.buffer);
        this.uploads.delete(key);
      } else upload.used = false;
    }
  }

  /** The buffer holding `key`'s data, written when `tag` first differs. */
  private upload(device: GPUDevice, key: object, tag: unknown, data: () => Float32Array | Uint32Array): GPUBuffer {
    let held = this.uploads.get(key);
    if (!held || held.tag !== tag) {
      const bytes = data();
      if (bytes.byteLength > Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize))
        throw rangeError(
          `MeshDebugView needs a ${bytes.byteLength}-byte storage buffer, over this device's limit; split the mesh or leave it out of meshes`,
          help,
        );
      if (held) retire(device, held.buffer);
      const buffer = device.createBuffer({
        size: bytes.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, bytes as Float32Array<ArrayBuffer>);
      this.uploads.set(key, (held = { buffer, tag, used: true }));
    }
    held.used = true;
    return held.buffer;
  }

  /** The draws of this view of the frame. */
  private collect(c: Context): Item[] {
    const engine = this.engine!,
      device = c.device,
      scene = engine.sceneOf(this) ?? engine.scene,
      items: Item[] = [],
      // A model lists its draws for all its nodes at once: ask each model once.
      models = new Map<MeshSource['model'], Map<object, MeshDraw[]>>();
    const single = (this.single ??= (() => {
      const buffer = device.createBuffer({ size: 96, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, identity);
      return buffer;
    })());
    for (const handle of this.settings.meshes ?? scene.meshes.values()) {
      const mesh = handle as unknown as Mesh;
      if (scene.meshes.get(mesh.id) !== mesh || hiddenInTree(engine.store, mesh.id) || !inView(c, mesh)) continue;
      const geometry = mesh.geometry as Geometry | null;
      if (geometry) {
        if (!geometry.indices.length) continue;
        const uv = geometrySurface(geometry)?.uv,
          stride = uv ? 8 : 6,
          vertex = this.upload(device, geometry, uv, () => {
            if (!uv) return geometry.vertices;
            const count = geometry.vertices.length / 6,
              data = new Float32Array(count * 8);
            for (let i = 0; i < count; i++) {
              data.set(geometry.vertices.subarray(i * 6, i * 6 + 6), i * 8);
              data.set(uv.subarray(i * 2, i * 2 + 2), i * 8 + 6);
            }
            return data;
          });
        items.push({
          key: mesh,
          matrix: mesh.matrix,
          vertex,
          offset: 0,
          size: vertex.size,
          index: this.upload(device, geometry.indices, geometry.indices, () => geometry.indices),
          count: geometry.indices.length,
          instances: single,
          copies: 1,
          stride,
          uvAt: uv ? 6 : 0,
          colorAt: 0,
          side: mesh.material.data[6] ? 0 : 1,
          material: mesh.material,
        });
        continue;
      }
      const source = meshSource(handle);
      if (!source) continue;
      let nodes = models.get(source.model);
      if (!nodes) {
        models.set(source.model, (nodes = new Map()));
        for (const draw of source.model.pickingPrimitives) {
          const list = nodes.get(draw.node);
          if (list) list.push(draw);
          else nodes.set(draw.node, [draw]);
        }
      }
      for (const draw of nodes.get(mesh) ?? []) {
        const p = draw.primitive as MeshSource['primitives'][number] & {
            instances?: { count: number; upload(device: GPUDevice): GPUBuffer };
          },
          side = (draw as MeshDraw & { side?: string }).side;
        if (p.topology || !p.indices.length || p.instances?.count === 0) continue;
        // A deformer's buffer without storage usage cannot be read: its bind pose shows instead.
        const live = (draw.vertex.usage & GPUBufferUsage.STORAGE) !== 0;
        items.push({
          key: p,
          matrix: mesh.matrix,
          vertex: live ? draw.vertex : this.upload(device, p.vertices, p.vertices, () => p.vertices),
          offset: live ? (draw.vertexOffset ?? 0) : 0,
          size: p.vertices.byteLength,
          index: this.upload(device, p.indices, p.indices, () => p.indices),
          count: p.indices.length,
          instances: p.instances ? p.instances.upload(device) : single,
          copies: p.instances ? p.instances.count : 1,
          stride: 20,
          uvAt: 12,
          colorAt: 16,
          side: side === 'back' ? 2 : side === 'front' ? 1 : 0,
          material: p.material,
        });
      }
    }
    return items;
  }

  private pipeline(c: Context, kind: number): GPURenderPipeline {
    const depth = c.descriptor.depthStencil!,
      samples = c.descriptor.multisample?.count ?? 1,
      key = [c.format, samples, depth.format, depth.depthCompare, kind].join(':');
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;
    const device = c.device,
      reversed = depth.depthCompare?.startsWith('greater') ?? false,
      module = (this.module ??= device.createShaderModule({ code })),
      blend: GPUBlendState | undefined =
        kind === 1
          ? {
              color: { operation: 'add', srcFactor: 'dst', dstFactor: 'zero' },
              alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
            }
          : kind === 2
            ? {
                color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              }
            : undefined;
    pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout!] }),
      vertex: { module, entryPoint: 'vertex', buffers: [instanceLayout] },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend }] },
      // Sides are cut in the shader: instances of one draw may mirror each other.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: depth.format,
        depthCompare: reversed ? 'greater-equal' : 'less-equal',
        depthWriteEnabled: kind === 0,
        depthBias: reversed ? BIAS : -BIAS,
        depthBiasSlopeScale: reversed ? 1 : -1,
      },
      multisample: c.descriptor.multisample,
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private record(device: GPUDevice, item: Item): DrawRecord {
    let record = this.records.get(item.key);
    const stale =
      record &&
      (record.vertex !== item.vertex ||
        record.offset !== item.offset ||
        record.size !== item.size ||
        record.index !== item.index);
    if (record && stale) {
      retire(device, record.uniform);
      record = undefined;
    }
    if (!record) {
      const uniform = device.createBuffer({
          size: FLOATS * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        { vertex, offset, size, index } = item;
      record = {
        uniform,
        vertex,
        offset,
        size,
        index,
        used: true,
        groups: uniformGroups(uniform, (binding) =>
          device.createBindGroup({
            layout: this.layout!,
            entries: [
              { binding: 0, resource: binding },
              { binding: 1, resource: { buffer: vertex, offset, size } },
              { binding: 2, resource: { buffer: index } },
            ],
          }),
        ),
      };
      this.records.set(item.key, record);
    }
    record.used = true;
    return record;
  }

  private draw(c: Context): void {
    const s = this.settings,
      device = c.device;
    if (this.disposed) return;
    this.sweep(device);
    if (!s.enabled) return;
    this.layout ??= device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const items = this.collect(c);
    if (!items.length) return;
    const mode = modes.indexOf(s.mode),
      // Wire and dot modes multiply by nothing: with multiply on they only paint their lines over the picture.
      kind = !s.multiply ? 0 : mode >= 1 && mode <= 3 ? 2 : 1,
      pipeline = this.pipeline(c, kind),
      v = this.values,
      colors = this.colors,
      camera = c.camera,
      m = camera.matrix,
      parallel = m[3] === 0 && m[7] === 0 && m[11] === 0;
    v.set(m);
    for (let k = 0; k < 3; k++) v[32 + k] = camera.position[k] - (parallel ? camera.target[k] : 0);
    v[35] = parallel ? 0 : 1;
    v.set(viewRect(c) ?? [0, 0, c.width, c.height], 36);
    v.set(colors.wire, 40);
    v.set(colors.dot, 44);
    v.set(colors.a, 48);
    v.set(colors.b, 52);
    v.set(colors.specular, 60);
    v[63] = s.specularPower;
    v.set([s.wireWidth, s.vertexRadius, s.uvScale, mode], 64);
    v[72] = kind;
    v[73] = +(linearHdr(c.format) || c.format.endsWith('-srgb'));
    const groups: GPUBindGroup[] = items.map((item) => {
      const record = this.record(device, item);
      v.set(item.matrix, 16);
      let base = colors.diffuse;
      if (s.mode === 'material-ids') {
        let id = this.ids.get(item.material);
        if (id === undefined) this.ids.set(item.material, (id = this.nextId++));
        base = colors.materials[id] ?? materialHue(id);
      }
      v.set(base, 56);
      v[68] = item.stride;
      v[69] = item.stride === 20 ? 4 : 3;
      // An offset of 0 says the set is absent: offset 0 holds the position, never a UV or a colour.
      v[70] = item.uvAt;
      v[71] = item.colorAt;
      v[74] = item.side;
      return record.groups.get(writeUniform(device, record.uniform, v as Float32Array<ArrayBuffer>, c.view ?? c));
    });
    const pass = beginScenePass(c, this.attachments.color, this.attachments.depth);
    applyView(pass, c);
    pass.setPipeline(pipeline);
    items.forEach((item, i) => {
      pass.setBindGroup(0, groups[i]);
      pass.setVertexBuffer(0, item.instances);
      pass.draw(item.count, item.copies);
    });
    pass.end();
  }

  private release(): void {
    const device = this.engine?.gpu;
    if (device) {
      for (const record of this.records.values()) retire(device, record.uniform);
      for (const upload of this.uploads.values()) retire(device, upload.buffer);
      retire(device, this.single);
    }
    this.records.clear();
    this.uploads.clear();
    this.pipelines.clear();
    this.single = this.layout = this.module = undefined;
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  /** Removes the plugin and releases its buffers; repeat calls are safe. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
let next = 0;
