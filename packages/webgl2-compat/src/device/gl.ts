// The WebGL2 context a compatibility device owns, its extensions, and a cache of the GL state the device sets, so
// replayed commands skip calls that change nothing. Written from the Khronos WebGL 2.0 and OpenGL ES 3.0
// specifications and the WebGL extension registry.

import { COMPRESSION_EXTENSIONS } from './formats.js';

/** The extensions a device uses, when the context has them. */
export interface Extensions {
  readonly clipControl: {
    clipControlEXT(origin: number, depth: number): void;
    LOWER_LEFT_EXT: number;
    ZERO_TO_ONE_EXT: number;
  } | null;
  readonly provoking: { provokingVertexWEBGL(mode: number): void; FIRST_VERTEX_CONVENTION_WEBGL: number } | null;
  readonly indexed: {
    enableiOES(target: number, index: number): void;
    disableiOES(target: number, index: number): void;
    blendEquationSeparateiOES(buf: number, rgb: number, alpha: number): void;
    blendFuncSeparateiOES(buf: number, sr: number, dr: number, sa: number, da: number): void;
    colorMaskiOES(buf: number, r: boolean, g: boolean, b: boolean, a: boolean): void;
  } | null;
  readonly anisotropic: { TEXTURE_MAX_ANISOTROPY_EXT: number; MAX_TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
  readonly parallel: { COMPLETION_STATUS_KHR: number } | null;
  readonly depthClamp: { DEPTH_CLAMP_EXT: number } | null;
  readonly polygonOffsetClamp: { polygonOffsetClampEXT(factor: number, units: number, clamp: number): void } | null;
  readonly stencilTexturing: {
    DEPTH_STENCIL_TEXTURE_MODE_WEBGL: number;
    STENCIL_INDEX_WEBGL: number;
  } | null;
  readonly colorBufferFloat: boolean;
  readonly floatBlend: boolean;
  readonly floatLinear: boolean;
  readonly lose: { loseContext(): void } | null;
  /** The compressed-texture extensions the context has (their objects hold the format enums). */
  readonly compressed: readonly Readonly<Record<string, unknown>>[];
}

/** Reads the extensions a device needs (enabling them, as getExtension does). */
export function extensions(gl: WebGL2RenderingContext): Extensions {
  const get = (name: string) => gl.getExtension(name) as never;
  return {
    clipControl: get('EXT_clip_control'),
    provoking: get('WEBGL_provoking_vertex'),
    indexed: get('OES_draw_buffers_indexed'),
    anisotropic: get('EXT_texture_filter_anisotropic'),
    parallel: get('KHR_parallel_shader_compile'),
    depthClamp: get('EXT_depth_clamp'),
    polygonOffsetClamp: get('EXT_polygon_offset_clamp'),
    stencilTexturing: get('WEBGL_stencil_texturing'),
    colorBufferFloat: !!get('EXT_color_buffer_float'),
    floatBlend: !!get('EXT_float_blend'),
    floatLinear: !!get('OES_texture_float_linear'),
    lose: get('WEBGL_lose_context'),
    compressed: Object.values(COMPRESSION_EXTENSIONS)
      .flat()
      .map((name) => gl.getExtension(name))
      .filter((e) => e !== null),
  };
}

/** The GL state the device sets, cached. Every setter is a no-op when the value is already set. */
export class GLState {
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private drawFbo: WebGLFramebuffer | null = null;
  private readFbo: WebGLFramebuffer | null = null;
  private readonly enabled = new Map<number, boolean>();
  private readonly keys = new Map<string, string>();
  private readonly ubo: string[] = [];
  private readonly units: { target: number; texture: WebGLTexture | null; sampler: WebGLSampler | null }[] = [];
  private active = -1;
  /** State changes asked for and those the cache found already in place (no GL call made), for the hit rate. */
  readonly counts = { requests: 0, hits: 0 };

  constructor(readonly gl: WebGL2RenderingContext) {}
  /** Counts one request; true (a hit) when `same`. */
  private hit(same: boolean): boolean {
    this.counts.requests++;
    if (same) this.counts.hits++;
    return same;
  }

  useProgram(p: WebGLProgram | null): void {
    if (!this.hit(this.program === p)) this.gl.useProgram((this.program = p));
  }
  bindVertexArray(v: WebGLVertexArrayObject | null): void {
    if (!this.hit(this.vao === v)) this.gl.bindVertexArray((this.vao = v));
  }
  bindDrawFramebuffer(f: WebGLFramebuffer | null): void {
    if (!this.hit(this.drawFbo === f)) this.gl.bindFramebuffer(this.gl.DRAW_FRAMEBUFFER, (this.drawFbo = f));
  }
  bindReadFramebuffer(f: WebGLFramebuffer | null): void {
    if (!this.hit(this.readFbo === f)) this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, (this.readFbo = f));
  }
  /** Forget framebuffer bindings (after a framebuffer is deleted). */
  forgetFramebuffers(): void {
    this.drawFbo = this.readFbo = null;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }
  forgetVertexArray(v: WebGLVertexArrayObject): void {
    if (this.vao === v) this.bindVertexArray(null);
  }
  forgetProgram(p: WebGLProgram): void {
    if (this.program === p) this.useProgram(null);
  }
  enable(cap: number, on: boolean): void {
    if (this.hit(this.enabled.get(cap) === on)) return;
    this.enabled.set(cap, on);
    if (on) this.gl.enable(cap);
    else this.gl.disable(cap);
  }
  /** Runs `set` when `value` differs from the last value stored under `key`. */
  set(key: string, value: string, set: () => void): void {
    if (this.hit(this.keys.get(key) === value)) return;
    this.keys.set(key, value);
    set();
  }
  /** Drops a cached key, so the next `set` of it runs. */
  forget(key: string): void {
    this.keys.delete(key);
  }
  uniformBuffer(point: number, buffer: WebGLBuffer, id: number, offset: number, size: number): void {
    const key = `${id}:${offset}:${size}`;
    if (this.hit(this.ubo[point] === key)) return;
    this.ubo[point] = key;
    this.gl.bindBufferRange(this.gl.UNIFORM_BUFFER, point, buffer, offset, size);
  }
  /** Binds a texture and sampler to a unit. */
  unit(index: number, target: number, texture: WebGLTexture | null, sampler: WebGLSampler | null): void {
    let u = this.units[index];
    if (!u) u = this.units[index] = { target: 0, texture: null, sampler: null };
    if (!this.hit(u.target === target && u.texture === texture)) {
      this.activeUnit(index);
      if (u.target && u.target !== target) this.gl.bindTexture(u.target, null);
      this.gl.bindTexture(target, texture);
      u.target = target;
      u.texture = texture;
    }
    if (!this.hit(u.sampler === sampler)) {
      this.gl.bindSampler(index, sampler);
      u.sampler = sampler;
    }
  }
  activeUnit(index: number): void {
    if (!this.hit(this.active === index)) this.gl.activeTexture(this.gl.TEXTURE0 + (this.active = index));
  }
  /** Forget a texture's unit bindings (after it is deleted or bound outside the cache). */
  forgetTexture(texture: WebGLTexture): void {
    for (const u of this.units) if (u?.texture === texture) u.texture = null;
  }
  /** Binds `texture` on a scratch unit for uploads and parameter changes (unit 0 is as good as any: draws rebind). */
  scratch(target: number, texture: WebGLTexture | null): void {
    this.unit(0, target, texture, this.units[0]?.sampler ?? null);
    // unit() selects the unit only when its binding changes; uploads and parameter calls act on the active unit, so
    // without this they would reach whatever texture another unit holds when unit 0 already had this one.
    this.activeUnit(0);
  }
}

/** The WebGL object kinds a device makes: each has `create<Kind>` and `delete<Kind>` (a Sync: fenceSync, deleteSync). */
const KINDS = ['Buffer', 'Texture', 'Framebuffer', 'Renderbuffer', 'Sampler', 'Program', 'Shader', 'VertexArray', 'Query', 'Sync'];

/** Marks the objects of a device dirty when a resource that owns some of them is collected (see {@link GLObjects.own}). */
const collected =
  typeof FinalizationRegistry === 'function' && typeof WeakRef === 'function'
    ? new FinalizationRegistry<WeakRef<GLObjects>>((objects) => {
        const o = objects.deref();
        if (o) o.dirty = true;
      })
    : null;

/**
 * Every WebGL object the device's context makes, held until the device deletes it: the browser deletes a WebGL object
 * whose JS wrapper it collects, at a moment of its own, possibly in the middle of a replay (ANGLE on Vulkan has been
 * seen to corrupt a live program's colour output 7 for about half a second after such a deletion). An object goes when
 * the device deletes it (a resource's destroy()), at the first collect() after the resource that owns it was collected
 * (WebGPU buffers, textures, samplers, bind groups and pipelines may be dropped without destroy()), or when the device
 * is destroyed. Deletes asked for while a submission replays wait for the end of the replay. `created` and `deleted`
 * count both per kind.
 */
export class GLObjects {
  readonly created: Record<string, number> = {};
  readonly deleted: Record<string, number> = {};
  /** Set when an owner was collected: the next collect() deletes its objects. */
  dirty = false;
  /** Above 0 while a submission replays: deletes wait in `later`. */
  replaying = 0;
  private readonly live = new Map<object, [kind: string, owner: WeakRef<object> | null]>();
  private readonly owners = new WeakMap<object, WeakRef<object>>();
  private readonly later: object[] = [];
  private readonly remove: Record<string, (o: object) => void> = {};
  private readonly self = collected && new WeakRef(this);

  constructor(gl: WebGL2RenderingContext) {
    const g = gl as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const kind of KINDS) {
      const make = kind === 'Sync' ? 'fenceSync' : `create${kind}`,
        free = `delete${kind}`,
        create = g[make],
        del = g[free];
      if (typeof create !== 'function' || typeof del !== 'function') continue;
      this.created[kind] = this.deleted[kind] = 0;
      this.remove[kind] = (o) => del.call(gl, o);
      g[make] = (...a) => {
        const o = create.apply(gl, a) as object | null;
        if (o) {
          this.live.set(o, [kind, null]);
          this.created[kind]++;
        }
        return o;
      };
      g[free] = (o) => {
        if (!this.live.has(o as object)) del.call(gl, o);
        else if (this.replaying) this.later.push(o as object);
        else this.free(o as object);
      };
    }
  }

  /** A weak reference to `owner`, watched for collection (null without FinalizationRegistry). */
  watch(owner: object): WeakRef<object> | null {
    if (!this.self || !collected) return null;
    let r = this.owners.get(owner);
    if (!r) {
      this.owners.set(owner, (r = new WeakRef(owner)));
      collected.register(owner, this.self);
    }
    return r;
  }

  /** Ties `o` to `owner`: deleted at the first collect() after `owner` was collected. Returns `o`. */
  own<T>(owner: object, o: T): T {
    const entry = o && this.live.get(o as object);
    if (entry) entry[1] = this.watch(owner);
    return o;
  }

  /** Deletes the objects whose owner was collected and those deleted during a replay. */
  collect(): void {
    if (this.dirty) {
      this.dirty = false;
      for (const [o, [, owner]] of this.live) if (owner && !owner.deref()) this.free(o);
    }
    for (const o of this.later.splice(0)) this.free(o);
  }

  /** Deletes every object left (the device is being destroyed). */
  destroy(): void {
    this.replaying = 0;
    for (const o of [...this.live.keys()]) this.free(o);
  }

  private free(o: object): void {
    const entry = this.live.get(o);
    if (!entry) return;
    this.live.delete(o);
    this.deleted[entry[0]]++;
    this.remove[entry[0]](o);
  }
}
