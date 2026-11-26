/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: stencil masking as the WebGPU specification defines its depth-stencil state (a mask writes a reference
// with 'replace', contents test it with 'equal' or 'not-equal'), after Kilgard's stencil-buffer techniques (1999) and
// the portal rendering of Luebke and Georges (1995). A second-scene portal is the same camera's picture of that scene,
// drawn on the mask surface in screen space. Sources are in the README.
import type { EngineKernel } from '@margoengine/core';
import { Camera, engineRuntime, type RenderView } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Material, Texture, type MaterialMesh } from './built-material.js';
import { StencilBuffer } from './stencil-buffer.js';
import { WgslMaterial } from './wgsl-material.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
const HELP = '; see https://margoengine.com/errors#materials-portal';
type Mesh = MaterialMesh<Material>;

/** What one portal pairs: the mask meshes that cut the window, and what draws through it. */
export interface PortalOptions {
  /** Meshes whose surface is the window. They draw no colour of their own (or the second scene's picture). */
  mask: Mesh | readonly Mesh[];
  /** Meshes drawn only inside the mask (outside with `inverse`). Default none. */
  contents?: readonly Mesh[];
  /** Draw the contents only outside the mask instead of inside. Default false. */
  inverse?: boolean;
  /** Another scene (`engine.createScene()`) seen through the mask, drawn by `Portals.render`. Default none. */
  scene?: RenderView['scene'];
  /** Camera for `scene`. Default the camera `Portals.render` draws the main view with. */
  camera?: Camera;
}
/** `Portals` settings. */
export interface PortalsOptions {
  /** First stencil reference handed out, 1 to 255. Default 1. */
  first?: number;
  /** Last stencil reference handed out, `first` to 255. Default 255. */
  last?: number;
}

interface Saved {
  material: Material;
  state: Partial<Record<(typeof FIELDS)[number], unknown>>;
}
const FIELDS = [
  'colorWrite',
  'depthWrite',
  'stencilWrite',
  'stencilRef',
  'stencilReadMask',
  'stencilWriteMask',
  'stencilFunc',
  'stencilFail',
  'stencilZFail',
  'stencilZPass',
] as const;
// The second scene's picture is display-encoded; the basic shading writes linear colour, so decode it first.
const SCREEN = `fn shade(i: Out, s: Surface) -> Surface {
  var o = s;
  let c = textureLoad(portalView, vec2i(i.clip.xy), 0).rgb;
  o.base = vec4f(select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)), 1.0);
  return o;
}`;

/** One mask-and-contents pair with its own stencil reference. Remove it to restore its meshes. */
export class Portal {
  /** The stencil reference the mask writes and the contents test. */
  readonly ref: number;
  /** Contents draw outside the mask. Live. */
  get inverse(): boolean {
    return this.flip;
  }
  set inverse(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Portal inverse must be a boolean; set true or false' + HELP);
    this.flip = v;
    for (const mesh of this.contents) mesh.material.stencilFunc = v ? 'not-equal' : 'equal';
  }
  /** The second scene, or undefined for a same-scene portal. */
  readonly scene?: RenderView['scene'];
  /** Camera for the second scene; undefined follows the main view's camera. */
  camera?: Camera;
  /** @internal */ texture?: GPUTexture;
  /** @internal */ screen?: WgslMaterial;
  private flip: boolean;
  private readonly saved: Saved[] = [];
  private readonly orders = new Map<Mesh, number>();
  private readonly swapped = new Map<Mesh, Material>();
  private removed = false;
  constructor(
    private readonly owner: Portals,
    ref: number,
    readonly mask: readonly Mesh[],
    readonly contents: readonly Mesh[],
    options: PortalOptions,
  ) {
    this.ref = ref;
    this.flip = options.inverse ?? false;
    this.scene = options.scene;
    this.camera = options.camera;
    const write = (mesh: Mesh, state: Partial<Record<(typeof FIELDS)[number], unknown>>, order: number) => {
      const material = mesh.material;
      this.saved.push({ material, state: Object.fromEntries(FIELDS.map((k) => [k, material[k]])) });
      Object.assign(material, state);
      this.orders.set(mesh, mesh.renderOrder);
      mesh.renderOrder = order;
    };
    // The mask draws after opaque meshes of order 0, so what stands in front of it keeps its stencil clear; the
    // contents follow the mask.
    const base = 1000 + ref * 2;
    if (this.scene) {
      for (const mesh of mask) {
        this.swapped.set(mesh, mesh.material);
        this.orders.set(mesh, mesh.renderOrder);
        mesh.renderOrder = base;
      }
    } else
      for (const mesh of mask)
        write(
          mesh,
          {
            colorWrite: false,
            depthWrite: false,
            stencilWrite: true,
            stencilRef: ref,
            stencilFunc: 'always',
            stencilZPass: 'replace',
            stencilWriteMask: 0xff,
          },
          base,
        );
    for (const mesh of contents)
      write(
        mesh,
        {
          stencilWrite: true,
          stencilRef: ref,
          stencilReadMask: 0xff,
          stencilWriteMask: 0,
          stencilFunc: this.flip ? 'not-equal' : 'equal',
        },
        base + 1,
      );
  }
  /** @internal Second-scene target at the canvas size; returns the texture to draw into. */
  target(device: GPUDevice, width: number, height: number, format: GPUTextureFormat): GPUTexture {
    const t = this.texture;
    if (t && t.width === width && t.height === height && t.format === format && this.device === device) return t;
    const next = device.createTexture({
      size: [width, height],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const view = new Texture(next);
    if (!this.screen) {
      this.screen = new WgslMaterial({ shading: 'basic', wgsl: SCREEN, textures: { portalView: view } });
      for (const mesh of this.mask) mesh.material = this.screen;
    } else this.screen.textures.portalView = view;
    t?.destroy();
    this.device = device;
    return (this.texture = next);
  }
  private device?: GPUDevice;
  /** Restore the meshes' materials, state and order, and free the reference. Safe to call more than once. */
  remove(): void {
    if (this.removed) return;
    this.removed = true;
    for (const { material, state } of this.saved.reverse()) Object.assign(material, state);
    for (const [mesh, material] of this.swapped) mesh.material = material;
    for (const [mesh, order] of this.orders) mesh.renderOrder = order;
    this.texture?.destroy();
    this.texture = undefined;
    this.owner['release'](this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.remove();
  }
}

/**
 * Stencil portals for one engine: each `add` pairs mask meshes with contents that draw only inside them (or outside),
 * under its own stencil reference. A portal onto another scene draws that scene with the same camera and shows it on
 * the mask's surface; call `render` from the frame loop for those.
 */
export class Portals {
  /** Portals for `engine`, attaching a `StencilBuffer` to its scene when none is there. */
  static attach(engine: EngineKernel, options: PortalsOptions = {}): Portals {
    return new Portals(engine, options);
  }
  /** The live portals, in the order added. */
  readonly portals: Portal[] = [];
  private readonly first: number;
  private readonly last: number;
  private readonly materials = new Set<Material>();
  private stencil?: StencilBuffer;
  private disposed = false;
  constructor(
    private readonly engine: EngineKernel,
    options: PortalsOptions = {},
  ) {
    const { first = 1, last = 255 } = options;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 255 || last < first)
      throw new RangeError('Invalid portal references; pass integers 1 <= first <= last <= 255' + HELP);
    this.first = first;
    this.last = last;
  }
  /** Add one portal. Each mesh's material must be its own: the portal edits that material's stencil state. */
  add(options: PortalOptions): Portal {
    if (this.disposed) throw new MargoError('disposed', 'Portals are disposed; create new Portals' + HELP);
    const mask = (Array.isArray(options?.mask) ? options.mask : [options?.mask]) as Mesh[],
      contents = [...(options.contents ?? [])] as Mesh[],
      meshes = [...mask, ...contents];
    if (!mask.length || meshes.some((m) => !(m?.material instanceof Material)))
      throw new TypeError(
        'Portal mask and contents must be material meshes (createMesh); pass at least one mask' + HELP,
      );
    if (options.inverse !== undefined && typeof options.inverse !== 'boolean')
      throw new TypeError('Portal inverse must be a boolean; set true or false' + HELP);
    if (options.camera !== undefined && !(options.camera instanceof Camera))
      throw new TypeError('Portal camera must be a Camera; pass one or leave it out' + HELP);
    if (options.scene && contents.length)
      throw new TypeError('A second-scene portal draws that scene; put its contents in the scene, not contents' + HELP);
    const owned = meshes.map((m) => m.material);
    if (new Set(owned).size !== owned.length || owned.some((m) => this.materials.has(m)))
      throw new MargoError(
        'state',
        'Portal meshes share a material with each other or another portal; give each mesh its own material' + HELP,
      );
    const used = new Set(this.portals.map((p) => p.ref));
    let ref = this.first;
    while (ref <= this.last && used.has(ref)) ref++;
    if (ref > this.last)
      throw new MargoError(
        'state',
        `Portal stencil references ${this.first}-${this.last} are all in use; remove a portal or widen first and last` +
          HELP,
      );
    if (!options.scene) this.ensureStencil();
    const portal = new Portal(this, ref, mask, contents, options);
    owned.forEach((m) => this.materials.add(m));
    this.portals.push(portal);
    return portal;
  }
  private ensureStencil(): void {
    const runtime = engineRuntime(this.engine);
    if (runtime.plugins.has('materials:stencil-buffer')) return;
    this.stencil = StencilBuffer.attach(this.engine);
  }
  private release(portal: Portal): void {
    const i = this.portals.indexOf(portal);
    if (i >= 0) this.portals.splice(i, 1);
    for (const m of [...portal.mask, ...portal.contents]) this.materials.delete(m.material);
    portal.screen && this.materials.delete(portal.screen);
  }
  /**
   * Draw a frame: each second-scene portal's scene into its picture, then the main view. Use it in place of
   * engine.render when any portal shows another scene. `camera` defaults to engine.camera.
   */
  render(delta = 0, camera: Camera = this.engine.camera): void {
    if (this.disposed) throw new MargoError('disposed', 'Portals are disposed; create new Portals' + HELP);
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid portal delta; pass finite seconds >= 0' + HELP);
    const runtime = engineRuntime(this.engine),
      device = runtime.gpu,
      canvas = this.engine.canvas,
      views: RenderView[] = [];
    if (this.portals.some((p) => p.scene)) {
      if (this.engine.backend !== 'webgpu' || !device)
        throw new MargoError(
          'unsupported',
          'Second-scene portals need WebGPU or the WebGL2 compatibility layer' + HELP,
        );
      for (const p of this.portals)
        if (p.scene)
          views.push({
            id: 'portal:' + p.ref,
            camera: p.camera ?? camera,
            viewport: [0, 0, 1, 1],
            scene: p.scene,
            target: { color: p.target(device, canvas.width, canvas.height, runtime.renderTarget!.format) },
          });
    }
    views.push({ camera, viewport: [0, 0, 1, 1] });
    this.engine.render({ delta, views });
  }
  /** Remove every portal (restoring its meshes) and the stencil buffer this attached. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of [...this.portals]) p.remove();
    this.stencil?.dispose();
    this.stencil = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
