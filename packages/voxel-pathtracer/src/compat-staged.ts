// The path loop of `trace` cut into fragment programs for the WebGL2 compatibility layer (compat.ts), so that no
// program holds more than one traversal: Direct3D's shader compiler (ANGLE's default backend on Windows) takes time that
// grows several times faster than the code it inlines, and the whole loop in one program never finished compiling
// (docs/known-bugs.md, docs/limits.md). The programs are cut from the shader text itself, the one the tracer (or a
// subclass's edit of it) runs on WebGPU: every statement runs once, in the same order, with the same random numbers, so a
// staged path is the same path. Between programs the path's state is kept in rgba32uint pages, LAYERS layers (28 words)
// a page, read by every program and written, page by page, by the programs that change it.
//
// One iteration of the path loop is: `hit` (the closest hit along the path or shadow walk ray), `vertex` (what the hit
// does, up to next-event estimation), then for each light kind (five, seven with triangle meshes) `sample` (the light sample and the BSDF value),
// `shadow` (its shadow ray) and `gather` (its share and the shadow-walk candidates), then `post` (the rest of the loop
// body). `start` runs the code before the loop (the camera ray) and `finish` the code after it, adding the samples in the
// order `trace` adds them.
import { MargoError } from '@margoengine/math/errors';

const stale = (what: string) =>
  new MargoError(
    'unsupported',
    `VoxelPathTracer on WebGL2 stages the path loop of the shader it was written for (${what}); update voxel-pathtracer/src/compat-staged.ts`,
  );

/**
 * The order of the path state's field groups after the control words (`start` words, on page 0, written by every
 * program) that rewrites the fewest pages an iteration. A program draws once for each page it writes (one page is all
 * the outputs a draw has), and each draw runs the whole program, so an iteration's passes are, summed over the
 * programs, the passes a program makes an iteration (`runs`) times the pages its groups' words touch, page 0 included.
 * The groups are laid out one after another, a page every PAGE_WORDS words, so the pages are as few as the words
 * allow. A local search moves one group at a time to wherever it lowers that sum (first improvement), from the order
 * given and from seeded shuffles of it, and keeps the first best: the same order on every run, never more passes than
 * the order given (the base tracer: 47 to 42 passes an iteration, KB-L5a-10). The problem is a linear arrangement of a
 * hypergraph (Diaz, Petit and Serna, "A survey of graph layout problems", ACM Computing Surveys 34(3), 2002,
 * https://doi.org/10.1145/568522.568523).
 */
export function packOrder(
  start: number,
  groups: readonly { readonly size: number; readonly writers: readonly string[] }[],
  runs: Readonly<Record<string, number>>,
  restarts = 32,
): number[] {
  const stages = Object.keys(runs),
    writes = groups.map((g) => stages.map((s) => g.writers.includes(s))),
    passes = (order: readonly number[]) => {
      const touched = stages.map(() => 1);
      let at = start;
      for (const i of order) {
        const g = groups[i];
        if (g.size) {
          let pages = 0;
          for (let p = Math.floor(at / PAGE_WORDS); p <= Math.floor((at + g.size - 1) / PAGE_WORDS); p++) pages |= 1 << p;
          for (let s = 0; s < stages.length; s++) if (writes[i][s]) touched[s] |= pages;
        }
        at += g.size;
      }
      let n = 0;
      for (let s = 0; s < stages.length; s++) {
        let bits = touched[s];
        while (bits) {
          n += runs[stages[s]];
          bits &= bits - 1;
        }
      }
      return n;
    },
    descend = (from: number[]): [number, number[]] => {
      let order = from,
        n = passes(order),
        moved = true;
      while (moved) {
        moved = false;
        for (let i = 0; i < order.length; i++)
          for (let j = 0; j < order.length; j++) {
            if (i === j) continue;
            const next = order.slice(),
              [g] = next.splice(i, 1);
            next.splice(j, 0, g);
            const m = passes(next);
            if (m < n) [order, n, moved] = [next, m, true];
          }
      }
      return [n, order];
    };
  let best = descend([...groups.keys()]),
    seed = 0x9e3779b9;
  // mulberry32 (Tommy Ettinger, 2017), a fixed seed, so the layout never changes from run to run.
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let r = 0; r < restarts; r++) {
    const order = [...groups.keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const found = descend(order);
    if (found[0] < best[0]) best = found;
  }
  return best[1];
}

/** The programs of one sample, in the order they run. */
export type Stage =
  | 'start'
  | 'hit'
  | 'vertex'
  | 'shading'
  | 'material'
  | 'surface'
  | 'sample'
  | 'emit'
  | 'shadow'
  | 'gather'
  | 'post'
  | 'finish';

export interface StagedTrace {
  /**
   * Each program's WGSL (a fill-triangle vertex entry `fill` and a fragment entry `stage`). `shading` and `material`
   * only for a shader with mesh PBR materials (see SURFACE_CALLS), `emit` only for a shader with mesh emitters (see
   * EMITTER); every other stage always.
   */
  readonly modules: Readonly<Partial<Record<Stage, string>>>;
  /** Pages of path state (LAYERS layers of 4 words each). */
  readonly pages: number;
  /** The pages each program writes (`finish` writes the five sums instead). */
  readonly writes: Readonly<Partial<Record<Stage, readonly number[]>>>;
  /** Words of path state. */
  readonly words: number;
  /** Light kinds a sample runs `sample`, `shadow` and `gather` for (kinds past the shader's bound do nothing). */
  readonly kinds: number;
  /**
   * The light kind of each pass of `sample`, `shadow` and `gather` in one iteration, in order: every kind once, except
   * the kind a shader repeats (`const KIND_REPEAT=vec2u(kind,passes);`, the resampled proposals), that many times.
   */
  readonly steps: readonly number[];
  /** The light kinds whose passes draw `emit` (those that can reach sampleMeshEmitter); none without it. */
  readonly emits: readonly number[];
  /**
   * The census program: a fragment per path that passes (is not discarded) once the path finished before iteration
   * `k - 1` began, so both copies of every page hold its final state. compat.ts draws it with stencil writes to mark
   * those paths, which every later program then skips by the stencil test, and counts the paths left unmarked with an
   * occlusion query to stop the part's loop once none is.
   */
  readonly census: string;
  /**
   * Per light kind, the frame tests that switch it off for every path: the kind does nothing when every test of any
   * one entry holds (an empty list: never). compat.ts then draws none of its passes (`liveSteps`).
   */
  readonly idle: readonly (readonly (readonly FrameTest[])[])[];
}

/**
 * A test of one word of the frame uniform (the WGSL `f`): 'zero' holds when the word is 0, 'none' when it has none of
 * `mask`'s bits, 'positive' when the word read as f32 is above 0.
 */
export interface FrameTest {
  readonly word: number;
  readonly test: 'zero' | 'none' | 'positive';
  readonly mask?: number;
}

/**
 * The passes of `staged.steps` a dispatch draws for the frame uniform `frame` (as written for it): every step but
 * those of a light kind the frame switches off. Such a kind's first statement is a `continue` that only the frame
 * decides, before it draws a random number or changes the path, so its `sample`, `shadow` and `gather` programs leave
 * every value `finish` reads as it was (only the kind's scratch words, which the next kind's `sample` writes before
 * anything reads them). Without `frame` every step is drawn.
 */
export function liveSteps(staged: StagedTrace, frame?: ArrayBufferLike): readonly number[] {
  if (!frame) return staged.steps;
  const u = new Uint32Array(frame),
    f = new Float32Array(frame),
    holds = (t: FrameTest) =>
      t.test === 'zero' ? u[t.word] === 0 : t.test === 'none' ? (u[t.word] & t.mask!) === 0 : f[t.word] > 0;
  return staged.steps.filter((q) => !staged.idle[q]?.some((all) => all.every(holds)));
}

/** Iterations of the path loop for `maxBounces` (its `limit`, which the generator checks against the shader). */
export { loopLimit } from './dispatch.js';

const LIMIT = 'let limit=f.config.x*4u+16u+(f.config.x+1u)*16u;';
const RADIANCE = 'fn radiance(px:vec2u)->Path {';
const LOOP = 'for(var it=0u;it<limit;it++){';
const HIT_END = 'if(walking){walkAdvance=false;}else{mediaAdvance=false;}';
const CALL = 'let add=thr*direct(';
const ARGS = 'select(0u,1u,scatter),m,n,-d,p+off,medium,mInst,&walk,lobes';
const DIRECT =
  'fn direct(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f,medium:u32,mInst:u32,w:ptr<function,Walk>,mask:u32)->vec3f {';
// The light kinds' loop; its bound is `5u`, or an expression a feature puts there (triangle meshes add two kinds).
const LIGHTS = /for\(var q=0u;q<([^;{}]+);q\+\+\)\{/g;
// Light kinds the route runs when the bound is not a literal: the stages skip kinds at or past the bound, so any bound
// up to this runs every kind it names (the mesh feature's is 5, or 7 with its light header, src/mesh-light-build.ts;
// tests/route-work.test.js holds them to it). 8 before 2026-11-15: kind 7 drew 5 passes an iteration that did nothing.
export const MAX_LIGHT_KINDS = 7;
// Layers a page holds, one fragment output each: 7, so no program writes output location 7. ANGLE's Vulkan back end on
// an NVIDIA RTX A6000 (driver 617.42) writes other words through location 7 for about 0.3 s at a time, a few seconds
// after the layer moves from one tracer's programs to another's, which made 1 to 4 of every 64 images dark
// (KB-VPT-GUIDE-COMPAT, docs/known-bugs.md); with 7 outputs 0 of 512 were, and every value is the same.
export const LAYERS = 7;
const PAGE_WORDS = LAYERS * 4;
// A light kind the shader runs several passes of in a row (resampled.ts: one pass per proposal).
const REPEAT = /\bconst KIND_REPEAT=vec2u\((\d+)u,(\d+)u\);/;
// Where the vertex program ends and the surface program begins (the hoisted `var n=vec3f(0.0);`).
const VERTEX_CUT = 'n=vec3f(0.0);';
// The surface's two mesh PBR calls, each evaluated in a program of its own before `surface` (KB5451). Inlined they were
// 10,800 of the surface program's 17,900 statements, and Direct3D's compiler took 124 s for it at its first draw; the
// rest alone takes 12 s. Both read the path state only (`pbrMaterial` changes nothing private but `pbrLayer`, which its
// program keeps and hands on), so a program earlier in the iteration computes the same values under a guard that
// holds wherever the call runs, keeps them in the state, and the call site reads them: the same values, in the same
// order, with no random number drawn. Each guard is the conjunction of the branches around its call in `radiance`.
const SURFACE_CALLS = {
  shading: {
    call: 'if(h.inst==TRIANGLE){n=triangleShading(h);}',
    kept: 'if(h.inst==TRIANGLE){n=z_tn;}',
    run: 'if(!z_skip&&!scatter&&h.inst==TRIANGLE){z_tn=triangleShading(h);}',
  },
  material: {
    call: 'if(!inner&&!skinOut){m=pbrMaterial(h,lp,m);}',
    kept: 'if(!inner&&!skinOut){m=z_pm;pbrLayer=z_pl;}',
    // `m` is material(h.value) where the call runs, and lp is p moved into the instance's local frame.
    run:
      'if(!z_skip&&!scatter&&h.value!=0u&&h.inst!=NONE&&h.inst!=AREA&&h.inst!=GROUND){var lp=p;' +
      'if(h.inst!=TRIANGLE){lp=xpoint(localX(h.inst),p);}let z_keep=pbrLayer;' +
      'z_pm=pbrMaterial(h,lp,material(h.value));z_pl=pbrLayer;pbrLayer=z_keep;}',
  },
} as const;
// A mesh emitter's radiance, evaluated in a program of its own (`emit`, between `sample` and `shadow` of the light kind
// that samples mesh emitters) and not inside sampleMeshEmitter (KB5451). Inlined into `sample` with mesh PBR it was
// 11,200 of the program's statements, and Direct3D's compiler took 83 s for it at its first draw. sampleMeshEmitter
// draws its three random numbers first (the face, then the point on it); everything after them depends on those, the
// shading point `o` and private words alone. So on this route it returns, in place of the radiance, the face's record
// and its two draws (the record offset with bit 30 set, so the word is a normal f32 that every move keeps: the scene
// buffer holds under 2^30 words), and `emit` runs the same code after the draws on the same values,
// `z_meshEmitted`, for the radiance. The record goes through the light kind's own `radiance` words, which `sample`
// copies it into and never reads again, so the path state keeps its size: 4 words more took mesh PBR's state from 10
// to 11 pages, and every program's state load and store with it (a cold first image 20 to 40 s slower). The radiance
// reaches the light sum only in `gather`, under the shadow ray; the checks below hold the rest.
const EMITTER = {
  fn: 'fn sampleMeshEmitter(o:vec3f)->LightPoint {',
  pick: 'let r=records+lo*24u;let root=sqrt(rand());let v=rand();let bary=vec2f(root*(1.0-v),root*v);',
  kept: 'result.radiance=vec3f(bitcast<f32>(r|0x40000000u),root,v);',
  call: 'result.radiance=meshEmitterRadiance(h,result.p,wo);',
  after:
    'fn z_meshEmitted(o:vec3f,r:u32,root:f32,v:f32)->LightPoint {var result:LightPoint;' +
    'let bary=vec2f(root*(1.0-v),root*v);',
  use: 'ls=sampleMeshEmitter(o);',
  copy: 'radiance=ls.radiance;',
  run: 'if(z_shadow){let z_r=radiance;radiance=z_meshEmitted(o,bitcast<u32>(z_r.x)&0x3fffffffu,z_r.y,z_r.z).radiance;}',
} as const;
// Mesh PBR's texel fetch in one tap loop on this route (KB5451): pbrTexture wrote its nearest tap and its four
// bilinear taps as five calls of pbrPixel, each with its two pbrAddress wraps and its sRGB decode, and Direct3D's
// compiler inlined all five into every pbrTexture copy (emit holds four: 20 pbrPixel and 40 pbrAddress copies). The
// loop runs the same taps in the same order, decodes each as before and mixes them in the same expressions, so every
// value is the same; its bound comes from the texture's record, so the compiler keeps one copy of the tap.
const TEXEL = {
  from:
    'let p=wrapped*vec2f(f32(scene[t]),f32(scene[t+1u]));var value:vec4f;' +
    'if(scene[t+6u]==0u){value=pbrPixel(t,vec2i(floor(p)));}' +
    'else{let x=p-0.5;let a=vec2i(floor(x));let k=fract(x);' +
    'var c0=pbrPixel(t,a);var c1=pbrPixel(t,a+vec2i(1,0));' +
    'var c2=pbrPixel(t,a+vec2i(0,1));var c3=pbrPixel(t,a+vec2i(1,1));' +
    'if(srgb){' +
    'c0=vec4f(select(c0.rgb/12.92,pow((c0.rgb+0.055)/1.055,vec3f(2.4)),c0.rgb>vec3f(0.04045)),c0.a);' +
    'c1=vec4f(select(c1.rgb/12.92,pow((c1.rgb+0.055)/1.055,vec3f(2.4)),c1.rgb>vec3f(0.04045)),c1.a);' +
    'c2=vec4f(select(c2.rgb/12.92,pow((c2.rgb+0.055)/1.055,vec3f(2.4)),c2.rgb>vec3f(0.04045)),c2.a);' +
    'c3=vec4f(select(c3.rgb/12.92,pow((c3.rgb+0.055)/1.055,vec3f(2.4)),c3.rgb>vec3f(0.04045)),c3.a);' +
    '}return mix(mix(c0,c1,k.x),mix(c2,c3,k.x),k.y);}' +
    'if(srgb){value=vec4f(select(value.rgb/12.92,pow((value.rgb+0.055)/1.055,vec3f(2.4)),value.rgb>vec3f(0.04045)),value.a);}' +
    'return value;',
  // Nearest: one tap at floor(p) (x is p); bilinear: taps a, a+(1,0), a+(0,1), a+(1,1) at floor(p-0.5).
  to:
    'let p=wrapped*vec2f(f32(scene[t]),f32(scene[t+1u]));let linear=scene[t+6u]!=0u;' +
    'let x=select(p,p-0.5,linear);let a=vec2i(floor(x));let k=fract(x);var lo:vec4f;var r0:vec4f;var r1:vec4f;' +
    'for(var i=0u;i<select(1u,4u,linear);i++){var c=pbrPixel(t,a+vec2i(i32(i&1u),i32(i>>1u)));' +
    'if(srgb){c=vec4f(select(c.rgb/12.92,pow((c.rgb+0.055)/1.055,vec3f(2.4)),c.rgb>vec3f(0.04045)),c.a);}' +
    'if((i&1u)==0u){lo=c;}else if(i==1u){r0=mix(lo,c,k.x);}else{r1=mix(lo,c,k.x);}}' +
    'if(!linear){return lo;}return mix(r0,r1,k.y);',
} as const;
const SHADOW_IF = 'if(any(e.f>vec3f(0.0))&&(air||!far)){';
const SHADOW = 'var v=shadow(o,wi,dist);';
const SUN_OFF = 'sunCell=false;';
const ENTRY = '@compute @workgroup_size(8,8) fn trace(@builtin(global_invocation_id) gid:vec3u) {';
const SEED = 'rng=hash((pixel*0x9e3779b1u)^hash(f.tile.z+s+hash(f.config.y)));';
const SAMPLE = 'let r=radiance(px);';
// How radiance ends: `res` (a `Seen`: what the loop noted as it went) joined to the sums as `got`, so a path's state
// holds the sums once (L, C and D) and not a second time in its stored result; and its return before the loop.
const RETURN = 'return got;',
  EARLY = 'return Path(vec3f(0.0),vec3f(0.0),vec3f(0.0),res);';
const SPLIT_FLAG = 'let split=(f.config.z&SPLIT)!=0u;',
  // The direct part is summed apart too (a fifth sum).
  DIRECT_FLAG = 'let two=(f.config.z&DIRECT)!=0u;';
const IMAGES = /@group\(0\) @binding\((6|7|8|10)\) var<storage,read_write> \w+:array<vec4f>;\n/g;
// Declarations whose type the initializer does not show.
const HINTS: Record<string, string> = {
  limit: 'u32',
  p: 'vec3f',
  fogged: 'bool',
  sunOnly: 'bool',
  lobes: 'u32',
  skinIn: 'bool',
};

function unique(text: string, marker: string, from = 0): number {
  const i = text.indexOf(marker, from);
  if (i < 0 || text.indexOf(marker, i + 1) >= 0) throw stale(marker);
  return i;
}
function matching(text: string, open: number, a = '{', b = '}'): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === a) depth++;
    else if (text[i] === b && --depth === 0) return i;
  }
  throw stale('unbalanced ' + a + b);
}
function depthOf(text: string): number {
  let d = 0;
  for (const c of text) d += c === '{' ? 1 : c === '}' ? -1 : 0;
  return d;
}

// The statements of a block's text at its top level: a compound statement (`{...}`, `if(...){...}else{...}`) is one.
function statements(text: string): string[] {
  const out: string[] = [];
  let start = 0,
    paren = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === ';' && paren === 0) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (c === '{' && paren === 0) {
      let end = matching(text, i);
      // An else (if) carries on the same statement.
      for (let m = /^\s*else\b[^{]*\{/.exec(text.slice(end + 1)); m; m = /^\s*else\b[^{]*\{/.exec(text.slice(end + 1)))
        end = matching(text, end + m[0].length);
      out.push(text.slice(start, end + 1));
      start = end + 1;
      i = end;
    }
  }
  if (text.slice(start).trim()) throw stale('a statement without its end');
  return out;
}
// A statement's blocks (the bodies of `{...}` and of each branch of an if), as [open, close] brace indices.
function blocks(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (let j = s.indexOf('{'); j >= 0; j = s.indexOf('{', out[out.length - 1][1] + 1)) out.push([j, matching(s, j)]);
  return out;
}
// A loop or switch statement: its `break` and `continue` are its own.
const ownsExits = (s: string) => /^\s*(loop|for|while|switch)\b/.test(s);
// Whether a statement leaves the enclosing one-pass loop.
function exits(s: string): boolean {
  if (/^\s*(break|continue);$/.test(s)) return true;
  if (ownsExits(s) || !/\b(break|continue);/.test(s)) return false;
  return blocks(s).some(([a, b]) => statements(s.slice(a + 1, b)).some(exits));
}
// The body of a one-pass loop (`for(once){...}`) without the loop: every `break` and `continue` leaves the body, so each
// sets z_skip and the statements after it in its enclosing blocks run only while z_skip is false. Direct3D's shader
// compiler (fxc) has to unroll the one-pass loop and gives up on the larger stages (error X3511), which lost the
// WebGL2 context on ANGLE's Direct3D 11 back end at the stage's first draw (docs/known-bugs.md).
export function unloop(text: string): string {
  const list = statements(text);
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!exits(s)) {
      out += s;
      continue;
    }
    if (/^\s*(break|continue);$/.test(s)) return out + 'z_skip=true;';
    // The blocks of the compound statement (an if or a bare block), each without its exits.
    let from = 0;
    for (const [a, b] of blocks(s)) {
      out += s.slice(from, a + 1) + unloop(s.slice(a + 1, b)) + '}';
      from = b + 1;
    }
    out += s.slice(from);
    const rest = list.slice(i + 1).join('');
    return rest.trim() ? `${out}if(!z_skip){${unloop(rest)}}` : out;
  }
  return out;
}
const once = (text: string) => `{var z_skip=false;${unloop(text)}}`;

interface Types {
  structs: Map<string, [string, string][]>;
  fns: Map<string, string>;
}
const VEC = /^vec([234])(?:([fiu])|<(f32|i32|u32|bool)>)$/;
const scalarOf = (c: string) => ({ f: 'f32', i: 'i32', u: 'u32' })[c] ?? c;
function words(t: string, T: Types): number {
  if (t === 'f32' || t === 'u32' || t === 'i32' || t === 'bool') return 1;
  const v = VEC.exec(t);
  if (v) return Number(v[1]);
  const s = T.structs.get(t);
  if (!s) throw stale('type ' + t);
  return s.reduce((n, [, ft]) => n + words(ft, T), 0);
}
function pack(e: string, t: string, T: Types, out: string[]): void {
  if (t === 'u32') out.push(e);
  else if (t === 'f32' || t === 'i32') out.push(`bitcast<u32>(${e})`);
  else if (t === 'bool') out.push(`select(0u,1u,${e})`);
  else {
    const v = VEC.exec(t);
    if (v) for (let k = 0; k < Number(v[1]); k++) pack(`${e}.${'xyzw'[k]}`, scalarOf(v[2] ?? v[3]), T, out);
    else for (const [name, ft] of T.structs.get(t)!) pack(`${e}.${name}`, ft, T, out);
  }
}
function unpack(t: string, T: Types, take: () => string): string {
  if (t === 'u32') return take();
  if (t === 'f32' || t === 'i32') return `bitcast<${t}>(${take()})`;
  if (t === 'bool') return `(${take()}!=0u)`;
  const v = VEC.exec(t);
  if (v) {
    const s = scalarOf(v[2] ?? v[3]);
    return `vec${v[1]}<${s}>(${Array.from({ length: Number(v[1]) }, () => unpack(s, T, take)).join(',')})`;
  }
  return `${t}(${T.structs
    .get(t)!
    .map(([, ft]) => unpack(ft, T, take))
    .join(',')})`;
}

interface Decl {
  name: string;
  type: string;
  init?: string;
}
// The type of `name` declared as `init`, from the initializer's form, the known variables and the functions' results.
function typeOf(name: string, init: string, known: Map<string, string>, T: Types): string {
  const e = init.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(vec[234](?:[fiu]|<\w+>))\(/.exec(e))) return m[1].replace(/<(f32|i32|u32)>/, (_, s) => s[0]);
  if (/^(true|false)$/.test(e)) return 'bool';
  if (/^(\d+u|NONE|GROUND|AREA|STEP)$/.test(e)) return 'u32';
  if (/^-?(\d+\.\d*|\.\d+)(e[-+]?\d+)?$|^INF$/.test(e)) return 'f32';
  if ((m = /^bitcast<(\w+)>\(/.exec(e))) return m[1];
  if (known.has(e)) return known.get(e)!;
  if ((m = /^(\w+)\.(\w+)$/.exec(e)) && known.has(m[1])) {
    const field = T.structs.get(known.get(m[1])!)?.find(([n]) => n === m![2]);
    if (field) return field[1];
  }
  if ((m = /^(\w+)\(/.exec(e)) && T.fns.has(m[1]) && matching(e, m[1].length, '(', ')') === e.length - 1)
    return T.fns.get(m[1])!;
  if (HINTS[name]) return HINTS[name];
  throw stale(`the type of ${name}`);
}
// Turns the declarations at the top level of `text` (not inside a block) into assignments: they become path state.
function hoist(text: string, known: Map<string, string>, T: Types): { text: string; decls: Decl[] } {
  const decls: Decl[] = [],
    re = /\b(var|let)\s+(\w+)\s*(?::\s*([\w<>,]+?))?\s*(=|;)/g;
  let out = '',
    last = 0,
    depth = 0,
    scan = 0,
    m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (; scan < m.index; scan++) depth += text[scan] === '{' ? 1 : text[scan] === '}' ? -1 : 0;
    if (depth !== 0) continue;
    const [, , name, ann] = m,
      at = m.index + m[0].length;
    let init: string | undefined,
      end = at;
    if (m[4] === '=') {
      let p = 0;
      for (; end < text.length; end++) {
        const c = text[end];
        if (c === '(') p++;
        else if (c === ')') p--;
        else if (c === ';' && p === 0) break;
      }
      init = text.slice(at, end);
      out += text.slice(last, m.index) + `${name}=`;
    } else {
      if (!ann) throw stale(`the declaration of ${name}`);
      out += text.slice(last, m.index) + `{var z_${name}:${ann};${name}=z_${name};}`;
    }
    last = at;
    const type = ann ?? typeOf(name, init!, known, T);
    known.set(name, type);
    decls.push({ name, type, init });
  }
  return { text: out + text.slice(last), decls };
}
// Whether `text` may assign `name` (conservatively: any assignment, increment, member store or pointer to it).
// `&&name` is a logical and, not the address of `name` (KB5451: `h.mesh!=0u&&motion<1.0` read as changing motion).
const assigns = (text: string, name: string) =>
  new RegExp(`(?<![\\w.])${name}(?:\\.\\w+|\\[[^\\]]*\\])*\\s*(?:[-+*/%&|^]?=(?!=)|\\+\\+|--)|(?<!&)&${name}\\b`).test(
    text,
  );

// `text` split at the top-level (outside parentheses) occurrences of `op` (`||` or `&&`), each part without the
// parentheses that wrap all of it.
function split(text: string, op: string): string[] {
  const out: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && text.startsWith(op, i)) {
      out.push(text.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  out.push(text.slice(start));
  return out.map(bare);
}
function bare(text: string): string {
  let t = text.trim();
  while (t.startsWith('(') && matching(t, 0, '(', ')') === t.length - 1) t = t.slice(1, -1).trim();
  return t;
}
// An if statement's branches: each condition (undefined for a final else) and body.
function branches(s: string): { cond?: string; body: string }[] | undefined {
  const out: { cond?: string; body: string }[] = [];
  let rest = s.trim();
  for (;;) {
    const m = /^if\s*\(/.exec(rest);
    if (!m) return undefined;
    const close = matching(rest, m[0].length - 1, '(', ')'),
      open = rest.indexOf('{', close);
    if (open < 0 || rest.slice(close + 1, open).trim()) return undefined;
    const end = matching(rest, open);
    out.push({ cond: rest.slice(m[0].length, close), body: rest.slice(open + 1, end) });
    rest = rest.slice(end + 1).trim();
    if (!rest) return out;
    const e = /^else\s*/.exec(rest);
    if (!e) return undefined;
    rest = rest.slice(e[0].length);
    if (rest.startsWith('{')) {
      const last = matching(rest, 0);
      if (rest.slice(last + 1).trim()) return undefined;
      out.push({ body: rest.slice(1, last) });
      return out;
    }
  }
}
// A comparison of the light kind `q` with a literal (`q==3u`, `q<3u`), as a test of q; undefined for anything else.
function kindTest(term: string): ((q: number) => boolean) | undefined {
  const m = /^q(==|!=|<=|>=|<|>)(\d+)u$/.exec(term);
  if (!m) return undefined;
  const n = Number(m[2]);
  return {
    '==': (q: number) => q === n,
    '!=': (q: number) => q !== n,
    '<': (q: number) => q < n,
    '<=': (q: number) => q <= n,
    '>': (q: number) => q > n,
    '>=': (q: number) => q >= n,
  }[m[1]];
}
// Whether condition `cond` holds for kind q: true, false, or undefined when it depends on more than q.
function kindHolds(cond: string, q: number): boolean | undefined {
  let any = false;
  for (const term of split(cond, '||')) {
    let all = true;
    for (const c of split(term, '&&')) {
      const t = kindTest(c);
      if (!t) return undefined;
      all &&= t(q);
    }
    any ||= all;
  }
  return any;
}
// Whether kind q runs the statement of `text` that holds `marker` once it gets that far: true, false (the ifs around it
// rule q out by kind comparisons), or undefined (they depend on more than q).
function reaches(text: string, marker: string, q: number): boolean | undefined {
  const s = statements(text).find((t) => t.includes(marker));
  if (s === undefined) return false;
  const b = branches(s);
  if (!b) return true;
  for (const x of b) {
    if (x.cond?.includes(marker)) return undefined;
    const holds = x.cond === undefined ? true : kindHolds(x.cond, q);
    if (x.body.includes(marker))
      return holds === false ? false : holds === undefined ? undefined : reaches(x.body, marker, q);
    if (holds === true) return false;
    if (holds === undefined) return undefined;
  }
  return false;
}
// Calls in `text` other than type constructors.
const calls = (text: string) => /\b(?!(?:vec[234][fiu]?|f32|u32|i32|bool)\b)\w+\s*\(/.test(text);

/**
 * The frame tests that switch each light kind off (StagedTrace.idle), from the light kinds loop's body `light`: the
 * statements before its chain of kinds must leave the path and the private state alone for the kind (declarations of
 * the kind's scratch with call-free initializers, or ifs on other kinds), and the kind's branch must open with
 * `if(<test>){continue;}`, a call-free test; each `||` term of it made only of kind comparisons and frame words is an
 * entry. Anything else gives the kind no entry, so its passes are always drawn.
 */
function idleKinds(code: string, light: string, kinds: number): FrameTest[][][] {
  const none = () => Array.from({ length: kinds }, () => [] as FrameTest[][]);
  // The frame uniform's words: Frame holds 16-byte fields only (vec4 and arrays of vec4), at 16-byte offsets.
  const fs = /\bstruct Frame \{([^}]*)\}/.exec(code);
  if (!fs || !/var<uniform> f:Frame;/.test(code)) return none();
  const fieldAt = new Map<string, number>();
  let words = 0;
  for (const field of fs[1]
    .split(/,(?![^<]*>)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(\w+):(?:vec4[fiu]|vec4<(?:f32|u32|i32)>|array<vec4[fiu],(\d+)>)$/.exec(field);
    if (!m) return none();
    fieldAt.set(m[1], words);
    words += 4 * Number(m[2] ?? 1);
  }
  const consts = new Map([...code.matchAll(/\bconst (\w+)=(\d+)u;/g)].map((m) => [m[1], Number(m[2])])),
    word = (name: string, c: string) => (fieldAt.has(name) ? fieldAt.get(name)! + 'xyzw'.indexOf(c) : undefined),
    lets = new Map<string, FrameTest>(),
    frameTest = (t: string): FrameTest | undefined => {
      if (lets.has(t)) return lets.get(t);
      let m: RegExpExecArray | null, w: number | undefined;
      if ((m = /^f\.(\w+)\.([xyzw])>0\.0$/.exec(t)) && (w = word(m[1], m[2])) !== undefined)
        return { word: w, test: 'positive' };
      if ((m = /^f\.(\w+)\.([xyzw])==0u$/.exec(t)) && (w = word(m[1], m[2])) !== undefined)
        return { word: w, test: 'zero' };
      if (
        (m = /^\(f\.(\w+)\.([xyzw])&(\w+)\)==0u$/.exec(t)) &&
        (w = word(m[1], m[2])) !== undefined &&
        consts.has(m[3])
      )
        return { word: w, test: 'none', mask: consts.get(m[3])! };
      return undefined;
    };
  // The chain of kinds: the first if whose conditions test the kind alone, with a final else.
  const list = statements(light),
    chainOf = (s: string) => {
      const b = branches(s);
      return b &&
        b[b.length - 1].cond === undefined &&
        b.every((x) => x.cond === undefined || kindHolds(x.cond, 0) !== undefined)
        ? b
        : undefined;
    },
    chainAt = list.findIndex((s) => chainOf(s) !== undefined);
  if (chainAt < 0) return none();
  const chain = chainOf(list[chainAt])!;
  // The statements before the chain, each as the kinds it leaves alone.
  const inert: ((q: number) => boolean)[] = [];
  for (const s of list.slice(0, chainAt)) {
    const d = /^\s*(?:var|let)\s+(\w+)\s*(?::\s*[\w<>,]+)?\s*(?:=([^;]*))?;$/.exec(s);
    if (d) {
      if (d[2] !== undefined && calls(d[2])) return none();
      const t = d[2] === undefined ? undefined : frameTest(bare(d[2]));
      if (t) lets.set(d[1], t);
      inert.push(() => true);
      continue;
    }
    const b = branches(s);
    if (!b || b.some((x) => x.cond === undefined)) return none();
    // An if on other kinds: some `&&` term of each branch's condition is a kind comparison that fails for q.
    inert.push((q) => b.every((x) => split(x.cond!, '&&').some((c) => kindTest(c)?.(q) === false)));
  }
  return Array.from({ length: kinds }, (_, q) => {
    if (!inert.every((t) => t(q))) return [];
    let body: string | undefined;
    for (const x of chain) {
      const holds = x.cond === undefined ? true : kindHolds(x.cond, q);
      if (holds === undefined) return [];
      if (holds) {
        body = x.body;
        break;
      }
    }
    const first = body === undefined ? undefined : branches(statements(body)[0] ?? '');
    if (!first || first.length !== 1 || first[0].body.trim() !== 'continue;' || calls(first[0].cond!)) return [];
    const entries: FrameTest[][] = [];
    for (const term of split(first[0].cond!, '||')) {
      const tests: FrameTest[] = [];
      let known = true,
        on = true;
      for (const c of split(term, '&&')) {
        const k = kindTest(c),
          t = k ? undefined : frameTest(c);
        if (k) on &&= k(q);
        else if (t && t.word < words) tests.push(t);
        else known = false;
      }
      if (known && on) entries.push(tests);
    }
    return entries;
  });
}

export function stagedTrace(source: string): StagedTrace {
  // Comments out (they name loops and calls the cuts look for).
  let code = source.replace(/\/\/[^\n]*/g, '');
  // Mesh PBR's texel fetch: one tap loop (TEXEL), matched without its whitespace.
  const ti = code.indexOf(TEXEL.from.slice(0, 40));
  if (code.includes('fn pbrTexture(')) {
    const end = ti < 0 ? -1 : code.indexOf('return value;', ti) + 'return value;'.length;
    if (end < 0 || code.slice(ti, end).replace(/\s+/g, '') !== TEXEL.from.replace(/\s+/g, ''))
      throw stale('pbrTexture');
    code = code.slice(0, ti) + TEXEL.to + code.slice(end);
  }
  // Mesh emitters: their radiance in the `emit` program (EMITTER).
  const emitter = code.includes(EMITTER.fn);
  if (emitter) {
    const fi = unique(code, EMITTER.fn),
      fClose = matching(code, fi + EMITTER.fn.length - 1),
      fBody = code.slice(fi + EMITTER.fn.length, fClose);
    if (fBody.split(EMITTER.call).length !== 2 || fBody.split(EMITTER.pick).length !== 2) throw stale(EMITTER.call);
    unique(code, EMITTER.use);
    const [draws, rest] = fBody.split(EMITTER.pick);
    // Every return after the draws leaves the radiance as set there, or the radiance call's own.
    if (/result\.radiance/.test(rest.replace(EMITTER.call, ''))) throw stale(EMITTER.call);
    // The code after the draws reads none of the draws' own locals but r, root and bary.
    if (/\b(header|records|lo|hi|pick|v)\b/.test(rest)) throw stale(EMITTER.pick);
    code =
      code.slice(0, fi) +
      EMITTER.fn +
      draws +
      EMITTER.pick +
      EMITTER.kept +
      rest.replace(EMITTER.call, '') +
      '}\n' +
      EMITTER.after +
      rest +
      code.slice(fClose);
  }
  const ri = unique(code, RADIANCE),
    rOpen = ri + RADIANCE.length - 1,
    rClose = matching(code, rOpen),
    rbody = code.slice(rOpen + 1, rClose),
    // Everything but radiance and the entry points (helpers a subclass adds before `trace` included).
    prefix = (code.slice(0, ri) + code.slice(rClose + 1, unique(code, ENTRY))).replace(IMAGES, ''),
    T: Types = { structs: new Map(), fns: new Map() };
  for (const m of code.matchAll(/struct (\w+) \{([^}]*)\}/g))
    T.structs.set(
      m[1],
      m[2].split(',').map((f) => {
        const [n, t] = f.split(':').map((s) => s.replace(/@\w+\(\d+\)\s*/g, '').trim());
        return [n, t];
      }),
    );
  for (const m of code.matchAll(/fn (\w+)\([^{]*?\)->([\w<>]+) \{/g)) T.fns.set(m[1], m[2]);
  const privates = [...prefix.matchAll(/var<private>\s*(\w+)\s*:\s*([\w<>]+)\s*;/g)].map((m) => ({
    name: m[1],
    type: m[2],
  }));
  // The private words each function may change, itself or through the functions it calls (rand() changes rng).
  const bodies = new Map<string, string>();
  for (const m of code.matchAll(/\bfn (\w+)\(/g)) {
    const open = code.indexOf('{', m.index);
    bodies.set(m[1], code.slice(open + 1, matching(code, open)));
  }
  const changes = new Map(
    [...bodies].map(([name, text]) => [
      name,
      new Set(privates.filter((p) => assigns(text, p.name)).map((p) => p.name)),
    ]),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, text] of bodies)
      for (const m of text.matchAll(/\b(\w+)\s*\(/g))
        for (const p of changes.get(m[1]) ?? [])
          if (m[1] !== name && !changes.get(name)!.has(p)) changes.get(name)!.add(p), (grew = true);
  }
  /** The private words function `name` reads, itself or through the functions it calls. */
  const reads = (name: string, seen = new Set<string>()): Set<string> => {
    const text = bodies.get(name) ?? '',
      out = new Set(privates.filter((p) => new RegExp(`\\b${p.name}\\b`).test(text)).map((p) => p.name));
    seen.add(name);
    for (const m of text.matchAll(/\b(\w+)\s*\(/g))
      if (bodies.has(m[1]) && !seen.has(m[1])) for (const p of reads(m[1], seen)) out.add(p);
    return out;
  };
  /** The private words `text` may change. */
  const touched = (text: string) => {
    const out = new Set(privates.filter((p) => assigns(text, p.name)).map((p) => p.name));
    for (const m of text.matchAll(/\b(\w+)\s*\(/g)) for (const p of changes.get(m[1]) ?? []) out.add(p);
    return out;
  };

  // The path loop: the code before it, its body and the code after it.
  const li = unique(rbody, LOOP),
    lClose = matching(rbody, li + LOOP.length - 1),
    body = rbody.slice(li + LOOP.length, lClose),
    after = rbody.slice(lClose + 1).trimEnd();
  if (!after.endsWith(RETURN) || /\b(for|while|loop)\b/.test(body)) throw stale('the path loop');
  const epilogue = after.slice(0, -RETURN.length);
  unique(rbody.slice(0, li), EARLY);
  unique(rbody.slice(0, li), LIMIT);
  const known = new Map<string, string>([['px', 'vec2u']]),
    pro = hoist(rbody.slice(0, li).replace(EARLY, '{z_fin=true;break;}'), known, T);

  // hit | vertex | (the call of direct) | post.
  const hi = unique(body, HIT_END) + HIT_END.length,
    hit = hoist(body.slice(0, hi), known, T),
    rest = body.slice(hi),
    di = unique(rest, CALL),
    callClose = matching(rest, di + CALL.length - 1, '(', ')');
  if (rest.slice(di + CALL.length, callClose) !== ARGS) throw stale('the call of direct');
  // The vertex's own walk and light sum: direct() starts both empty on every call, so the state's copies are emptied
  // here, before the light kinds add to them (a sum carried from the vertex before was added again at every later one).
  let vertexText = rest.slice(0, di);
  const open = depthOf(vertexText);
  if (open !== 1) throw stale('the block around direct');
  const soft = vertexText.lastIndexOf('{');
  vertexText =
    vertexText.slice(0, soft + 1) +
    vertexText
      .slice(soft + 1)
      .replace('var walk:Walk;', '{var z_walk:Walk;walk=z_walk;}dL=vec3f(0.0);')
      .replace('let lobes=', 'lobes=');
  const vertex = hoist(vertexText, known, T),
    post = `if(z_direct){let add=thr*dL${rest.slice(callClose + 1)}`;
  known.set('walk', 'Walk').set('lobes', 'u32').set('dL', 'vec3f');

  // direct: its prologue (less its sum) and one light kind of its loop, cut at the shadow ray.
  const dOpen = unique(code, DIRECT) + DIRECT.length - 1,
    dbody = code.slice(dOpen + 1, matching(code, dOpen)),
    loops = [...dbody.matchAll(LIGHTS)];
  if (loops.length !== 1) throw stale('the light kinds loop of direct');
  const bound = loops[0][1],
    literal = /^(\d+)u$/.exec(bound),
    kinds = literal ? Number(literal[1]) : MAX_LIGHT_KINDS,
    qi = loops[0].index!,
    qOpen = qi + loops[0][0].length - 1,
    qClose = matching(dbody, qOpen),
    dPrologue = dbody.slice(0, qi).replace('var L=vec3f(0.0);', '');
  if (dPrologue === dbody.slice(0, qi) || dbody.slice(qClose + 1).trim() !== 'return L;') throw stale('direct');
  const walkPtr = (t: string) => t.replaceAll('(*w)', 'walkV').replace(/([(,])w(?=[,)])/g, '$1&walkV'),
    light = dbody.slice(qOpen + 1, qClose),
    si = unique(light, SHADOW_IF),
    tail = light.slice(si + SHADOW_IF.length),
    vi = unique(tail, SHADOW),
    off = unique(tail, SUN_OFF, vi) + SUN_OFF.length,
    lightKnown = new Map(known),
    sample = hoist(walkPtr(light.slice(0, si)), lightKnown, T);
  // emit changes no private word; `sample` after the call changes none emit reads; `sample` copies the record into
  // `radiance` once and reads neither again; and the light kinds that draw emit run the call wherever they get past it.
  const emits: number[] = [];
  if (emitter) {
    const text = sample.text,
      at = text.indexOf(EMITTER.use),
      copied = text.indexOf(EMITTER.copy, at),
      changed = [...touched(EMITTER.run)],
      later = [...touched(text.slice(at + EMITTER.use.length))].filter((n) => reads('z_meshEmitted').has(n));
    if (text.split(EMITTER.use).length !== 2 || text.split('ls.radiance').length !== 2 || copied < 0)
      throw stale(EMITTER.copy);
    // A read of the light kind's radiance (not another value's `.radiance`, not a store) after the copy.
    if (/(?<![\w.])radiance\b(?!\s*=[^=])/.test(text.slice(copied + EMITTER.copy.length))) throw stale(EMITTER.copy);
    if (changed.length || later.length) throw stale(`emit: ${[...changed, ...later].join(', ')} change in between`);
    for (let q = 0; q < kinds; q++) {
      const r = reaches(light, EMITTER.use, q);
      if (r === undefined) throw stale(`light kind ${q}: ${EMITTER.use}`);
      if (r) emits.push(q);
    }
  }
  // A prologue that changes private state runs in every light program: no kind's passes may be left out then.
  const idle = touched(dPrologue).size ? Array.from({ length: kinds }, () => []) : idleKinds(code, light, kinds);
  sample.decls.push({ name: 'v', type: T.fns.get('shadow') ?? 'f32' });
  const shadowText = walkPtr(tail.slice(0, off).replace(SHADOW, 'v=shadow(o,wi,dist);')),
    gatherText = walkPtr(tail.slice(off));

  // The accumulation of a sample in trace.
  const ei = unique(code, ENTRY),
    entry = code.slice(ei, matching(code, ei + ENTRY.length - 1)),
    ri2 = unique(entry, SAMPLE) + SAMPLE.length;
  unique(entry, SEED);
  unique(entry, SPLIT_FLAG);
  unique(entry, DIRECT_FLAG);
  const accumulate = entry.slice(ri2, entry.indexOf('\n }', ri2));

  // The state: control words first (every program writes them), then the path, then the light kind's scratch.
  const referenced = (n: string) =>
    new RegExp(`\\b${n}\\b`).test(body + epilogue) || ['scatter', 'm', 'n', 'p', 'off'].includes(n);
  const control: Decl[] = [
      { name: 'z_fin', type: 'bool' },
      { name: 'z_post', type: 'bool' },
      { name: 'z_direct', type: 'bool' },
      { name: 'z_lskip', type: 'bool' },
      { name: 'z_shadow', type: 'bool' },
      { name: 'z_skip', type: 'bool' },
      { name: 'z_it', type: 'u32' },
      ...privates,
    ],
    path: Decl[] = [
      ...pro.decls.filter((d) => referenced(d.name)),
      ...hit.decls,
      ...vertex.decls,
      { name: 'walk', type: 'Walk' },
      { name: 'lobes', type: 'u32' },
      { name: 'dL', type: 'vec3f' },
    ],
    scratch: Decl[] = sample.decls.map((d) => ({ ...d, name: 'l_' + d.name, local: d.name }) as Decl);
  for (const d of [...control, ...path, ...scratch])
    if (
      new RegExp(`\\b(fn|const|var<\\w+>|override|struct) ${d.name}\\b`).test(prefix) &&
      !privates.some((p) => p.name === d.name)
    )
      throw stale(`the name ${d.name}`);

  // The vertex in two programs (one compiled program held both, and Direct3D's compiler took 71 s for it at the first
  // draw): what a hit does up to the surface (the shadow walk, the camera's first hit, fog and media), then the
  // surface itself. z_skip, kept in the state, carries a \`break\` or \`continue\` of the first to the second.
  const vertexStatements = statements(
      `${vertex.text.replaceAll('break;', '{z_fin=true;break;}')}z_direct=true;}z_post=true;`,
    ),
    vertexCut = vertexStatements.findIndex((t) => t.trim() === VERTEX_CUT);
  if (vertexCut < 1) throw stale(VERTEX_CUT);
  const vertexA = vertexStatements.slice(0, vertexCut).join('');
  let vertexB = vertexStatements.slice(vertexCut).join('');
  // Mesh PBR's two heavy surface calls, each in a program of its own (SURFACE_CALLS).
  const split: Partial<Record<'shading' | 'material', string>> = {};
  if (vertexB.includes('pbrMaterial(')) {
    const layer = privates.find((d) => d.name === 'pbrLayer');
    if (!layer) throw stale('pbrLayer');
    for (const [stage, { call, kept, run }] of Object.entries(SURFACE_CALLS) as [
      'shading' | 'material',
      (typeof SURFACE_CALLS)['shading' | 'material'],
    ][]) {
      if (vertexB.split(call).length !== 2) throw stale(call);
      // Nothing private may change but pbrLayer, which the material program puts back.
      const changed = [...touched(run)].filter((n) => n !== 'pbrLayer');
      if (changed.length) throw stale(`${stage}: a call that changes ${changed.join(', ')}`);
      vertexB = vertexB.replace(call, kept);
      split[stage] = run;
    }
    path.push(
      { name: 'z_tn', type: 'vec3f' },
      { name: 'z_pm', type: T.fns.get('pbrMaterial') ?? 'Mat' },
      { name: 'z_pl', type: layer.type },
    );
  }
  const code_: Record<string, string> = {
    ...split,
    start: once(pro.text),
    hit: `if(z_it>=limit){z_fin=true;}else{z_it++;${once(hit.text.replaceAll('break;', '{z_fin=true;break;}'))}}`,
    vertex: `z_post=false;z_direct=false;z_skip=false;${unloop(vertexA)}`,
    surface: `if(!z_skip){${unloop(vertexB)}}`,
    post: `if(z_post){${once(post.replaceAll('break;', '{z_fin=true;break;}'))}z_post=false;}`,
    sample: `z_lskip=true;z_shadow=false;${once(`${sample.text}z_lskip=false;z_shadow=${SHADOW_IF.slice(3, -2)};`)}`,
    ...(emitter ? { emit: `if(${emits.map((q) => `q==${q}u`).join('||') || 'false'}){${EMITTER.run}}` } : {}),
    shadow: `if(z_shadow){${shadowText}}`,
    gather: once(`if(z_shadow){${gatherText}`),
  };
  const limitInit = pro.decls.find((d) => d.name === 'limit')!.init!;

  // Pages: control words (every program writes them), then the fields grouped by the programs that write them, those
  // of the programs that run most often (five times an iteration) first, so each program rewrites few pages.
  const STAGES = [
      'shadow',
      'sample',
      'emit',
      'gather',
      'hit',
      'post',
      'vertex',
      'shading',
      'material',
      'surface',
    ] as const,
    fields = [...control, ...path, ...scratch],
    // The name a field has in a program's text.
    local = (d: Decl, s: string) =>
      ['sample', 'emit', 'shadow', 'gather'].includes(s)
        ? scratch.includes(d)
          ? d.name.slice(2)
          : d.name === 'walk'
            ? 'walkV'
            : d.name === 'dL'
              ? 'L'
              : undefined
        : scratch.includes(d)
          ? undefined
          : d.name,
    writers = (d: Decl): string[] =>
      control.includes(d)
        ? ['all']
        : STAGES.filter((s) => {
            const n = local(d, s);
            return n !== undefined && code_[s] !== undefined && assigns(code_[s], n);
          }),
    signature = new Map(fields.map((d) => [d, writers(d).join()])),
    rank = (d: Decl) => STAGES.reduce((r, s, i) => r | (writers(d).includes(s) ? 1 << (STAGES.length - i) : 0), 0),
    ranked = [...path, ...scratch].sort((a, b) => rank(b) - rank(a)),
    // Runs of fields with the same writers (adjacent once ranked), laid out by packOrder.
    groups: Decl[][] = [];
  for (const d of ranked)
    if (groups.length && signature.get(groups.at(-1)![0]) === signature.get(d)) groups.at(-1)!.push(d);
    else groups.push([d]);
  const repeat = REPEAT.exec(code),
    steps = [...Array(kinds).keys()].flatMap((q) =>
      Array<number>(repeat && Number(repeat[1]) === q ? Number(repeat[2]) : 1).fill(q),
    ),
    runs: Record<string, number> = Object.fromEntries(
      STAGES.map((s) => [
        s,
        ['sample', 'shadow', 'gather'].includes(s)
          ? steps.length
          : s === 'emit'
            ? steps.filter((q) => emits.includes(q)).length
            : 1,
      ]),
    ),
    controlWords = control.reduce((n, d) => n + words(d.type, T), 0),
    order = [
      ...control,
      ...packOrder(
        controlWords,
        groups.map((g) => ({
          size: g.reduce((n, d) => n + words(d.type, T), 0),
          writers: signature.get(g[0])!.split(','),
        })),
        runs,
      ).flatMap((i) => groups[i]),
    ],
    at = new Map<Decl, number>();
  let total = 0;
  for (const d of order) {
    at.set(d, total);
    total += words(d.type, T);
  }
  const pages = Math.ceil(total / PAGE_WORDS),
    written = (stage: Stage): number[] => {
      if (stage === 'start') return [...Array(pages).keys()];
      if (stage === 'finish') return [];
      const set = new Set<number>();
      for (const d of order) {
        const w = signature.get(d)!.split(',');
        if (w.includes('all') || w.includes(stage)) {
          const a = at.get(d)!;
          for (let k = a; k < a + words(d.type, T); k++) set.add(Math.floor(k / PAGE_WORDS));
        }
      }
      return [...set].sort((a, b) => a - b);
    };

  // Loading and storing the state.
  const texels = pages * LAYERS,
    load = Array.from(
      { length: texels },
      (_, k) => ` let t${k}=textureLoad(zp${Math.floor(k / LAYERS)},g,${k % LAYERS},0);\n`,
    ).join('');
  let next = 0;
  const take = () => `t${next >> 2}.${'xyzw'[next++ & 3]}`,
    ctor = order.map((d) => unpack(d.type, T, take)).join(','),
    stored: string[] = [];
  for (const d of order) pack(`s.${d.name}`, d.type, T, stored);
  while (stored.length < texels * 4) stored.push('0u');
  const vec = (k: number) => `vec4u(${stored.slice(k * 4, k * 4 + 4).join(',')})`,
    state = `
struct ZS {${order.map((d) => `${d.name}:${d.type}`).join(',')}}
${[...Array(pages).keys()].map((p) => `@group(1) @binding(${p}) var zp${p}:texture_2d_array<u32>;`).join('\n')}
struct ZStep {q:u32,page:u32,p0:u32,p1:u32}
@group(2) @binding(0) var<uniform> zstep:ZStep;
struct ZPart {sx:u32,s0:u32,row0:u32,rows:u32,n:u32,p0:u32,p1:u32,p2:u32}
@group(2) @binding(1) var<uniform> zpart:ZPart;
struct ZOut {${[...Array(LAYERS).keys()].map((k) => `@location(${k}) o${k}:vec4u`).join(',')}}
fn zLoad(g:vec2i)->ZS {
${load} return ZS(${ctor});
}
fn zStore(s:ZS,page:u32)->ZOut {
${[...Array(pages).keys()]
  .map((p) => ` if(page==${p}u){return ZOut(${[...Array(LAYERS).keys()].map((k) => vec(p * LAYERS + k)).join(',')});}`)
  .join('\n')}
 return ZOut(${Array(LAYERS).fill('vec4u(0u)').join(',')});
}
fn zKeep(g:vec2i,page:u32)->ZOut {
${[...Array(pages).keys()]
  .map(
    (p) =>
      ` if(page==${p}u){return ZOut(${[...Array(LAYERS).keys()].map((k) => `textureLoad(zp${p},g,${k},0)`).join(',')});}`,
  )
  .join('\n')}
 return ZOut(${Array(LAYERS).fill('vec4u(0u)').join(',')});
}
@vertex fn fill(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 return vec4f(f32(i&1u)*4.0-1.0,f32(i>>1u)*4.0-1.0,0.0,1.0);
}
`;
  const pathFields = [...control.filter((d) => !privates.includes(d)), ...path],
    unpackPath = pathFields.map((d) => ` var ${d.name}=S.${d.name};\n`).join(''),
    repackPath = pathFields.map((d) => `S.${d.name}=${d.name};`).join(''),
    getPrivates = privates.map((d) => `${d.name}=S.${d.name};`).join(''),
    setPrivates = privates.map((d) => `S.${d.name}=${d.name};`).join(''),
    // A program draws n samples of `rows` rows from row0 of the dispatch, sample by sample side by side (sx a row).
    where = `
 let g=vec2i(at.xy);
 let zt=vec2u(g)/vec2u(f.tile.x,zpart.rows);
 let zv=zt.y*zpart.sx+zt.x;
 let s=zpart.s0+zv;
 let zl=vec2u(g)%vec2u(f.tile.x,zpart.rows);
 let px=vec2u(zl.x+f.image.z,zpart.row0+zl.y+f.image.w);
`,
    program = (body: string) =>
      `${prefix}${state}@fragment fn stage(@builtin(position) at:vec4f)->ZOut {${where}${body}}\n`,
    pathStage = (text: string) =>
      program(` if(textureLoad(zp0,g,0,0).x!=0u){return zKeep(g,zstep.page);}
 var S=zLoad(g);
${unpackPath} ${getPrivates}
 let limit=${limitInit};
 ${text}
 ${repackPath}${setPrivates}
 return zStore(S,zstep.page);
`),
    lightStage = (text: string, gate: string) =>
      program(` if(textureLoad(zp0,g,0,0).x!=0u){return zKeep(g,zstep.page);}
 var S=zLoad(g);
 ${getPrivates}
 if(S.z_direct${gate}&&zstep.q<(${bound})){
  var q=zstep.q;
  let kind=select(0u,1u,S.scatter);let m=S.m;let n=S.n;let wo=-S.d;let o=S.p+S.off;let medium=S.medium;let mInst=S.mInst;
  let mask=S.lobes;
  var walkV=S.walk;var L=S.dL;var z_lskip=S.z_lskip;var z_shadow=S.z_shadow;
${scratch.map((d) => `  var ${d.name.slice(2)}=S.${d.name};\n`).join('')} ${dPrologue}
  ${text}
  S.walk=walkV;S.dL=L;S.z_lskip=z_lskip;S.z_shadow=z_shadow;${scratch.map((d) => `S.${d.name}=${d.name.slice(2)};`).join('')}
 }
 ${setPrivates}
 return zStore(S,zstep.page);
`),
    nonFields = pro.decls.filter((d) => !path.includes(d)),
    start = program(` var S:ZS;
 if(zv>=zpart.n){S.z_fin=true;return zStore(S,zstep.page);}
 let pixel=px.y*f.image.x+px.x;
${unpackPath}${nonFields.map((d) => ` var ${d.name}:${d.type};\n`).join('')} ${SEED}
 ${code_.start}
 ${repackPath}${setPrivates}
 return zStore(S,zstep.page);
`),
    // The sums so far (the samples before s0, from the previous part) plus these n samples, in sample order.
    finish = `${prefix}${state}struct Sums {@location(0) c:vec4f,@location(1) a:vec4f,@location(2) n:vec4f,@location(3) s:vec4f,@location(4) d:vec4f}
@group(3) @binding(0) var zsc:texture_2d<f32>;
@group(3) @binding(1) var zsa:texture_2d<f32>;
@group(3) @binding(2) var zsn:texture_2d<f32>;
@group(3) @binding(3) var zss:texture_2d<f32>;
@group(3) @binding(4) var zsd:texture_2d<f32>;
@fragment fn stage(@builtin(position) at:vec4f)->Sums {
 let gid=vec2u(at.xy);
 let zl=vec2u(gid.x,gid.y-zpart.row0);
 var c=vec4f(0.0);var a=vec4f(0.0);var nn=vec4f(0.0);var cs=vec4f(0.0);var ds=vec4f(0.0);
 if(zpart.s0>0u){let t=vec2i(gid);c=textureLoad(zsc,t,0);a=textureLoad(zsa,t,0);nn=textureLoad(zsn,t,0);cs=textureLoad(zss,t,0);ds=textureLoad(zsd,t,0);}
 ${SPLIT_FLAG}
 ${DIRECT_FLAG}
 for(var zv=0u;zv<zpart.n;zv++){
  let g=vec2i(vec2u((zv%zpart.sx)*f.tile.x+zl.x,(zv/zpart.sx)*zpart.rows+zl.y));
  let S=zLoad(g);
  var res=S.res;let L=S.L;let C=S.C;let D=S.D;
  ${epilogue}
  let r=got;${accumulate}
 }
 return Sums(c,a,nn,cs,ds);
}
`;
  const modules: Partial<Record<Stage, string>> = {
    start,
    hit: pathStage(code_.hit),
    vertex: pathStage(code_.vertex),
    ...Object.fromEntries(Object.entries(split).map(([stage, run]) => [stage, pathStage(run)])),
    surface: pathStage(code_.surface),
    post: pathStage(code_.post),
    sample: lightStage(code_.sample, ''),
    ...(emitter ? { emit: lightStage(code_.emit, '&&!S.z_lskip') } : {}),
    shadow: lightStage(code_.shadow, '&&!S.z_lskip'),
    gather: lightStage(code_.gather, '&&!S.z_lskip'),
    finish,
  };
  const writes = Object.fromEntries((Object.keys(modules) as Stage[]).map((s) => [s, written(s)])) as unknown as Record<
    Stage,
    number[]
  >;
  // Where the census reads z_fin and z_it (control words, so on page 0).
  const word = (name: string) => at.get(control.find((d) => d.name === name)!)!,
    texel = (w: number) => `textureLoad(zp0,g,${w >> 2},0).${'xyzw'[w & 3]}`,
    census = `@group(0) @binding(0) var zp0:texture_2d_array<u32>;
struct ZCensus {k:u32,p0:u32,p1:u32,p2:u32}
@group(0) @binding(1) var<uniform> zc:ZCensus;
@vertex fn fill(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 return vec4f(f32(i&1u)*4.0-1.0,f32(i>>1u)*4.0-1.0,0.0,1.0);
}
@fragment fn census(@builtin(position) at:vec4f) {
 let g=vec2i(at.xy);
 if(${texel(word('z_fin'))}==0u||${texel(word('z_it'))}>=zc.k){discard;}
}
`;
  if (word('z_fin') >= PAGE_WORDS || word('z_it') >= PAGE_WORDS) throw stale('the control words');
  return { modules, pages, writes, words: total, census, kinds, steps, idle, emits };
}
