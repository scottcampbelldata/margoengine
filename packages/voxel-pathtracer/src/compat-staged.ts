// The path loop of `trace` cut into fragment programs for the WebGL2 compatibility layer (compat.ts), so that no
// program holds more than one traversal: Direct3D's shader compiler (ANGLE's default backend on Windows) takes time that
// grows several times faster than the code it inlines, and the whole loop in one program never finished compiling
// (docs/known-bugs.md, docs/limits.md). The programs are cut from the shader text itself, the one the tracer (or a
// subclass's edit of it) runs on WebGPU: every statement runs once, in the same order, with the same random numbers, so a
// staged path is the same path. Between programs the path's state is kept in rgba32uint pages, 8 layers (32 words) a
// page, read by every program and written, page by page, by the programs that change it.
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

/** The programs of one sample, in the order they run. */
export type Stage = 'start' | 'hit' | 'vertex' | 'surface' | 'sample' | 'shadow' | 'gather' | 'post' | 'finish';

export interface StagedTrace {
  /** Each program's WGSL (a fill-triangle vertex entry `fill` and a fragment entry `stage`). */
  readonly modules: Readonly<Record<Stage, string>>;
  /** Pages of path state (32 words each). */
  readonly pages: number;
  /** The pages each program writes (`finish` writes the four sums instead). */
  readonly writes: Readonly<Record<Stage, readonly number[]>>;
  /** Words of path state. */
  readonly words: number;
  /** Light kinds a sample runs `sample`, `shadow` and `gather` for (kinds past the shader's bound do nothing). */
  readonly kinds: number;
  /**
   * The census program: one fragment whose first word is 3 while a path of the part has not finished before iteration
   * `k` began, and 0 once every one has (compat.ts reads it back and stops the part's loop there).
   */
  readonly census: string;
}

/** Iterations of the path loop for `maxBounces` (its `limit`, which the generator checks against the shader). */
export const loopLimit = (maxBounces: number): number => maxBounces * 4 + 16 + (maxBounces + 1) * 16;

/**
 * The path loop's iterations in windows, in order: 4, 4, 8, 16, 32, then 64 at a time (the last one shorter). Before
 * every window but the first the route reads its census back and stops once every path has finished (compat.ts), so a
 * part whose paths end early records few iterations, and one that runs the whole loop reads at most 24 censuses at 64
 * bounces. Every window but the last is a multiple of 4 iterations, so every census falls on one.
 */
export function loopWindows(iterations: number): number[] {
  const first = [4, 4, 8, 16, 32],
    out: number[] = [];
  for (let done = 0; done < iterations; ) {
    const n = Math.min(first[out.length] ?? 64, iterations - done);
    out.push(n);
    done += n;
  }
  return out;
}

const LIMIT = 'let limit=f.config.x*4u+16u+(f.config.x+1u)*16u;';
const RADIANCE = 'fn radiance(px:vec2u)->Path {';
const LOOP = 'for(var it=0u;it<limit;it++){';
const HIT_END = 'if(walking){walkAdvance=false;}else{mediaAdvance=false;}';
const CALL = 'let add=thr*direct(';
const ARGS = 'select(0u,1u,scatter),m,n,-d,p+off,medium,mInst,&walk,lobes';
const DIRECT = 'fn direct(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f,medium:u32,mInst:u32,w:ptr<function,Walk>,mask:u32)->vec3f {';
// The light kinds' loop; its bound is `5u`, or an expression a feature puts there (triangle meshes add two kinds).
const LIGHTS = /for\(var q=0u;q<([^;{}]+);q\+\+\)\{/g;
// Light kinds the route runs when the bound is not a literal: the stages skip kinds at or past the bound, so any bound
// up to this runs every kind it names (the mesh feature's is at most 7, src/mesh-light-build.ts).
export const MAX_LIGHT_KINDS = 8;
// Where the vertex program ends and the surface program begins (the hoisted `var n=vec3f(0.0);`).
const VERTEX_CUT = 'n=vec3f(0.0);';
const SHADOW_IF = 'if(any(e.f>vec3f(0.0))&&(air||!far)){';
const SHADOW = 'var v=shadow(o,wi,dist);';
const SUN_OFF = 'sunCell=false;';
const ENTRY = '@compute @workgroup_size(8,8) fn trace(@builtin(global_invocation_id) gid:vec3u) {';
const SEED = 'rng=hash((pixel*0x9e3779b1u)^hash(f.tile.z+s+hash(f.config.y)));';
const SAMPLE = 'let r=radiance(px);';
const SPLIT_FLAG = 'let split=(f.config.z&SPLIT)!=0u;';
const IMAGES = /@group\(0\) @binding\((6|7|8|10)\) var<storage,read_write> \w+:array<vec4f>;\n/g;
// Declarations whose type the initializer does not show.
const HINTS: Record<string, string> = { limit: 'u32', p: 'vec3f', fogged: 'bool', sunOnly: 'bool', lobes: 'u32' };

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
    let init: string | undefined, end = at;
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
const assigns = (text: string, name: string) =>
  new RegExp(
    `(?<![\\w.])${name}(?:\\.\\w+|\\[[^\\]]*\\])*\\s*(?:[-+*/%&|^]?=(?!=)|\\+\\+|--)|&${name}\\b`,
  ).test(text);

export function stagedTrace(source: string): StagedTrace {
  // Comments out (they name loops and calls the cuts look for).
  const code = source.replace(/\/\/[^\n]*/g, '');
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

  // The path loop: the code before it, its body and the code after it.
  const li = unique(rbody, LOOP),
    lClose = matching(rbody, li + LOOP.length - 1),
    body = rbody.slice(li + LOOP.length, lClose),
    after = rbody.slice(lClose + 1).trimEnd();
  if (!after.endsWith('return res;') || /\b(for|while|loop)\b/.test(body)) throw stale('the path loop');
  const epilogue = after.slice(0, -'return res;'.length);
  unique(rbody.slice(0, li), LIMIT);
  const known = new Map<string, string>([['px', 'vec2u']]),
    pro = hoist(rbody.slice(0, li).replace('return res;', '{z_fin=true;break;}'), known, T);

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
  sample.decls.push({ name: 'v', type: T.fns.get('shadow') ?? 'f32' });
  const shadowText = walkPtr(tail.slice(0, off).replace(SHADOW, 'v=shadow(o,wi,dist);')),
    gatherText = walkPtr(tail.slice(off));

  // The accumulation of a sample in trace.
  const ei = unique(code, ENTRY),
    entry = code.slice(ei, matching(code, ei + ENTRY.length - 1)),
    ri2 = unique(entry, SAMPLE) + SAMPLE.length;
  unique(entry, SEED);
  unique(entry, SPLIT_FLAG);
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
    if (new RegExp(`\\b(fn|const|var<\\w+>|override|struct) ${d.name}\\b`).test(prefix) &&
      !privates.some((p) => p.name === d.name))
      throw stale(`the name ${d.name}`);

  // The vertex in two programs (one compiled program held both, and Direct3D's compiler took 71 s for it at the first
  // draw): what a hit does up to the surface (the shadow walk, the camera's first hit, fog and media), then the
  // surface itself. z_skip, kept in the state, carries a \`break\` or \`continue\` of the first to the second.
  const vertexStatements = statements(
      `${vertex.text.replaceAll('break;', '{z_fin=true;break;}')}z_direct=true;}z_post=true;`,
    ),
    vertexCut = vertexStatements.findIndex((t) => t.trim() === VERTEX_CUT);
  if (vertexCut < 1) throw stale(VERTEX_CUT);
  const vertexA = vertexStatements.slice(0, vertexCut).join(''),
    vertexB = vertexStatements.slice(vertexCut).join('');
  const code_ = {
    start: once(pro.text),
    hit: `if(z_it>=limit){z_fin=true;}else{z_it++;${once(hit.text.replaceAll('break;', '{z_fin=true;break;}'))}}`,
    vertex: `z_post=false;z_direct=false;z_skip=false;${unloop(vertexA)}`,
    surface: `if(!z_skip){${unloop(vertexB)}}`,
    post: `if(z_post){${once(post.replaceAll('break;', '{z_fin=true;break;}'))}z_post=false;}`,
    sample: `z_lskip=true;z_shadow=false;${once(`${sample.text}z_lskip=false;z_shadow=${SHADOW_IF.slice(3, -2)};`)}`,
    shadow: `if(z_shadow){${shadowText}}`,
    gather: once(`if(z_shadow){${gatherText}`),
  };
  const limitInit = pro.decls.find((d) => d.name === 'limit')!.init!;

  // Pages: control words (every program writes them), then the fields grouped by the programs that write them, those
  // of the programs that run most often (five times an iteration) first, so each program rewrites few pages.
  const STAGES = ['shadow', 'sample', 'gather', 'hit', 'post', 'vertex', 'surface'] as const,
    fields = [...control, ...path, ...scratch],
    // The name a field has in a program's text.
    local = (d: Decl, s: string) =>
      ['sample', 'shadow', 'gather'].includes(s)
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
            return n !== undefined && assigns(code_[s], n);
          }),
    signature = new Map(fields.map((d) => [d, writers(d).join()])),
    rank = (d: Decl) => STAGES.reduce((r, s, i) => r | (writers(d).includes(s) ? 1 << (STAGES.length - i) : 0), 0),
    order = [...control, ...[...path, ...scratch].sort((a, b) => rank(b) - rank(a))],
    at = new Map<Decl, number>();
  let total = 0;
  for (const d of order) {
    at.set(d, total);
    total += words(d.type, T);
  }
  const pages = Math.ceil(total / 32),
    written = (stage: Stage): number[] => {
      if (stage === 'start') return [...Array(pages).keys()];
      if (stage === 'finish') return [];
      const set = new Set<number>();
      for (const d of order) {
        const w = signature.get(d)!.split(',');
        if (w.includes('all') || w.includes(stage)) {
          const a = at.get(d)!;
          for (let k = a; k < a + words(d.type, T); k++) set.add(k >> 5);
        }
      }
      return [...set].sort((a, b) => a - b);
    };

  // Loading and storing the state.
  const texels = pages * 8,
    load = Array.from(
      { length: texels },
      (_, k) => ` let t${k}=textureLoad(zp${k >> 3},g,${k & 7},0);\n`,
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
struct ZOut {${[...Array(8).keys()].map((k) => `@location(${k}) o${k}:vec4u`).join(',')}}
fn zLoad(g:vec2i)->ZS {
${load} return ZS(${ctor});
}
fn zStore(s:ZS,page:u32)->ZOut {
${[...Array(pages).keys()]
  .map((p) => ` if(page==${p}u){return ZOut(${[...Array(8).keys()].map((k) => vec(p * 8 + k)).join(',')});}`)
  .join('\n')}
 return ZOut(${Array(8).fill('vec4u(0u)').join(',')});
}
fn zKeep(g:vec2i,page:u32)->ZOut {
${[...Array(pages).keys()]
  .map(
    (p) =>
      ` if(page==${p}u){return ZOut(${[...Array(8).keys()].map((k) => `textureLoad(zp${p},g,${k},0)`).join(',')});}`,
  )
  .join('\n')}
 return ZOut(${Array(8).fill('vec4u(0u)').join(',')});
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
  let q=zstep.q;
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
    finish = `${prefix}${state}struct Sums {@location(0) c:vec4f,@location(1) a:vec4f,@location(2) n:vec4f,@location(3) s:vec4f}
@group(3) @binding(0) var zsc:texture_2d<f32>;
@group(3) @binding(1) var zsa:texture_2d<f32>;
@group(3) @binding(2) var zsn:texture_2d<f32>;
@group(3) @binding(3) var zss:texture_2d<f32>;
@fragment fn stage(@builtin(position) at:vec4f)->Sums {
 let gid=vec2u(at.xy);
 let zl=vec2u(gid.x,gid.y-zpart.row0);
 var c=vec4f(0.0);var a=vec4f(0.0);var nn=vec4f(0.0);var cs=vec4f(0.0);
 if(zpart.s0>0u){let t=vec2i(gid);c=textureLoad(zsc,t,0);a=textureLoad(zsa,t,0);nn=textureLoad(zsn,t,0);cs=textureLoad(zss,t,0);}
 ${SPLIT_FLAG}
 for(var zv=0u;zv<zpart.n;zv++){
  let g=vec2i(vec2u((zv%zpart.sx)*f.tile.x+zl.x,(zv/zpart.sx)*zpart.rows+zl.y));
  let S=zLoad(g);
  var res=S.res;let L=S.L;let C=S.C;
  ${epilogue}
  let r=res;${accumulate}
 }
 return Sums(c,a,nn,cs);
}
`;
  const modules: Record<Stage, string> = {
    start,
    hit: pathStage(code_.hit),
    vertex: pathStage(code_.vertex),
    surface: pathStage(code_.surface),
    post: pathStage(code_.post),
    sample: lightStage(code_.sample, ''),
    shadow: lightStage(code_.shadow, '&&!S.z_lskip'),
    gather: lightStage(code_.gather, '&&!S.z_lskip'),
    finish,
  };
  const writes = Object.fromEntries(
    (Object.keys(modules) as Stage[]).map((s) => [s, written(s)]),
  ) as unknown as Record<Stage, number[]>;
  // Where the census reads z_fin and z_it (control words, so on page 0).
  const word = (name: string) => at.get(control.find((d) => d.name === name)!)!,
    texel = (w: number) => `textureLoad(zp0,g,${w >> 2},0).${'xyzw'[w & 3]}`,
    census = `@group(0) @binding(0) var zp0:texture_2d_array<u32>;
struct ZCensus {k:u32,p0:u32,p1:u32,p2:u32}
@group(0) @binding(1) var<uniform> zc:ZCensus;
struct ZPart {sx:u32,s0:u32,row0:u32,rows:u32,n:u32,w:u32,h:u32,p2:u32}
@group(0) @binding(2) var<uniform> zpart:ZPart;
@vertex fn fill(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 return vec4f(f32(i&1u)*4.0-1.0,f32(i>>1u)*4.0-1.0,0.0,1.0);
}
@fragment fn census()->@location(0) vec4u {
 for(var y=0u;y<zpart.h;y++){
  for(var x=0u;x<zpart.w;x++){
   let g=vec2i(vec2u(x,y));
   if(${texel(word('z_fin'))}==0u||${texel(word('z_it'))}>=zc.k){return vec4u(3u,1u,0u,0u);}
  }
 }
 return vec4u(0u,1u,0u,0u);
}
`;
  if (word('z_fin') >= 32 || word('z_it') >= 32) throw stale('the control words');
  return { modules, pages, writes, words: total, census, kinds };
}
