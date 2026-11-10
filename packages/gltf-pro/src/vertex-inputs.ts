// What a finished PBR shader reads of the 80-byte vertex. Every primitive's buffer holds position, normal, tangent, two
// UV sets and colour as five vec4; a draw whose shader reads fewer fetches fewer (a standard material with no maps:
// 0.63 -> 0.47 ms at 50,000 boxes). Runs on the final text, after every patch, so no patch needs to anchor on a trimmed
// vertex stage. Anything it cannot read for certain keeps every input.

export interface VertexInputs {
  /** The shader to compile. */
  readonly code: string;
  /** The vertex locations it reads, ascending. */
  readonly locations: readonly number[];
  /** Those of `locations` whose `xyz` alone it reads: a three-float fetch fills them, w taking WebGPU's default 1. */
  readonly narrow: readonly number[];
}

const ALL: readonly number[] = [0, 1, 2, 3, 4];
// The tangent frame of `surface`, then the mapped normal it exists for.
const frame = /\n {2}var t=i\.tangent[^]*?\n {2}s\.n=normalize\(t\*sampledNormal[^;]*;/;
const flatNormal = 'let sampledNormal=vec4f(0.5,0.5,1,1).xyz*2-1;';
const coordinates = /\nfn uv\(i:Out, ?\w+:f32\)->vec2f \{[^\n]*\}(?=\n)/;

/** With a flat normal the frame's two terms are exact zeros, so the normal is `n`; the frame goes unless later text uses it. */
function dropFlatFrame(code: string): string {
  // From `surface` on: a helper above it may open with the same line (materials' normal map node does).
  const start = code.indexOf('fn surface('),
    body = code.slice(start),
    found = frame.exec(body);
  if (start < 0 || !found || !code.includes(flatNormal)) return code;
  const after = body.slice(found.index + found[0].length),
    end = after.indexOf('\n  return s;');
  if (end < 0 || /\b(t|b|dp1|dp2|duv1|duv2)\b/.test(after.slice(0, end))) return code;
  return code.slice(0, start) + body.replace(frame, '\n  s.n=normalize(n);');
}

/** The vertex stage's text range: its opening to the `return o;` of its end. */
function stage(code: string): [number, number] {
  const start = code.indexOf('@vertex fn vertex(');
  return [start, code.indexOf('return o;\n}', start)];
}

/** Removes `Out.<field>` and the vertex stage's write of it when no other code reads it. */
function dropOutput(code: string, field: string): string {
  const [start, end] = stage(code),
    outside = (code.slice(0, start) + code.slice(end)).replace(coordinates, ''),
    written = code.slice(start, end).replace(new RegExp(`\\s*o\\.${field}=[^;]*;`), '');
  if (new RegExp(`\\.${field}\\b|\\b${field}\\(i,`).test(outside + written)) return code;
  // The field leaves `Out` too: a constant written to it would still pass between the stages.
  const head = code.slice(0, start).replace(new RegExp(`(struct Out \\{[^}]*?),?\\s*@location\\(\\d+\\) ${field}:vec4f`), '$1');
  return (head + written + code.slice(end)).replace(field === 'uv' ? coordinates : '', '');
}

/** Vertex buffer slot of the third and fourth UV sets, past the instance buffer's: unused slots between stay empty. */
export const laterUVSlot = 2;
/** Their layout: one vec4 a vertex, TEXCOORD_2 then TEXCOORD_3. */
export const laterUVLayout: GPUVertexBufferLayout = {
  arrayStride: 16,
  attributes: [{ shaderLocation: 11, offset: 0, format: 'float32x4' }],
};
/**
 * `code`, as trimmed by `vertexInputs`, reading TEXCOORD_2 and 3 as well: a second vertex buffer feeds `Out.uvs`, and every
 * choice between the two sets of `Out.uv` becomes a choice among four. Only a draw whose material reads a later set
 * compiles this. Output location 15 is free of every patch that adds outputs.
 */
export function laterUVShader(code: string): string {
  if (!/\bo\.uv=/.test(code)) return code;
  return (
    code
      .replaceAll(/select\(i\.uv\.xy,i\.uv\.zw,([^;)]*?)>0\.5\)/g, 'margoUVSet(i,$1)')
      .replace(/struct Input \{([^}]*?)\s*\}/, 'struct Input {$1, @location(11) uvs:vec4f}')
      .replace(/(struct Out \{[^}]*?)\n\}/, '$1, @location(15) uvs:vec4f\n}')
      .replace(/\bo\.uv=([^;]*);/, (write, value: string) => `${write} o.uvs=${value.replace(/\bi\.uv\b/g, 'i.uvs')};`) +
    '\nfn margoUVSet(i:Out,k:f32)->vec2f {return select(select(i.uv.xy,i.uv.zw,k>0.5),select(i.uvs.xy,i.uvs.zw,k>2.5),k>1.5);}\n'
  );
}

/**
 * True when every vertex of `vertices` (80-byte PBR, 20 floats a vertex) from vertex `start` on, `count` of them, has
 * the colour (1, 1, 1, 1): what a primitive without COLOR_0 packs. Stops at the first other colour.
 */
export function whiteColours(vertices: Float32Array, start = 0, count = vertices.length / 20 - start): boolean {
  for (let i = start * 20 + 16, end = (start + count) * 20; i < end; i += 20)
    if (vertices[i] !== 1 || vertices[i + 1] !== 1 || vertices[i + 2] !== 1 || vertices[i + 3] !== 1) return false;
  return true;
}

/** True when every vertex of `vertices` from vertex `start` on, `count` of them, has colour alpha 1 (COLOR_0 absent included). */
export function opaqueColours(vertices: Float32Array, start = 0, count = vertices.length / 20 - start): boolean {
  for (let i = start * 20 + 19, end = (start + count) * 20; i < end; i += 20) if (vertices[i] !== 1) return false;
  return true;
}

/**
 * A MASK colour pass hands the colour's transparency (1 - alpha) from the vertex stage on, and the fragment reads
 * 1 minus that. Interpolating a constant 0 is exact on every rasterizer; interpolating a constant 1 is not (perspective
 * division leaves 0.99999994 in some pixels), and a texel alpha equal to `alphaCutoff` must stay opaque (glTF 2.0,
 * 3.9.4) when the vertex alpha is 1 or COLOR_0 is absent. Code that names the stage output any other way than
 * `i:Out` / `o.color` is returned unchanged.
 */
export function exactAlphaShader(code: string): string {
  const [start, end] = stage(code);
  if (start < 0 || end < 0) return code;
  const body = code.slice(start, end),
    outside = code.slice(0, start) + code.slice(end),
    writes = body.match(/\bo\.color=[^;]*;/g);
  if (writes?.length !== 1 || code.includes('fn margoClearAlpha(')) return code;
  // Every `Out` outside the vertex stage is a parameter named `i`, and nothing else is named `i` there.
  if ([...outside.matchAll(/(\w+)\s*:\s*Out\b/g)].some((m) => m[1] !== 'i')) return code;
  if ([...outside.matchAll(/\bi\s*:\s*(\w+)/g)].some((m) => m[1] !== 'Out') || /\b(let|var|const)\s+i\b/.test(outside))
    return code;
  const vertex = body.replace(/\bo\.color=([^;]*);/, 'o.color=margoClearAlpha($1);'),
    swap = (text: string) => text.replace(/\bi\.color\b/g, 'margoClearAlpha(i.color)');
  return (
    swap(code.slice(0, start)) +
    vertex +
    swap(code.slice(end)) +
    '\nfn margoClearAlpha(c:vec4f)->vec4f {return vec4f(c.rgb,1.0-c.a);}\n'
  );
}

/** Vertex buffer slot 0: the 80-byte vertex, one attribute per location `inputs` reads, three floats where xyz do. */
export function vertexLayout(inputs: VertexInputs): GPUVertexBufferLayout {
  return {
    arrayStride: 80,
    attributes: inputs.locations.map((location) => ({
      shaderLocation: location,
      offset: location * 16,
      format: inputs.narrow.includes(location) ? 'float32x3' : 'float32x4',
    })),
  };
}

const instanceLayouts = new WeakMap<GPUVertexBufferLayout, Map<string, GPUVertexBufferLayout>>();
/**
 * Instance buffer `layout` less the attributes finished shader `code` does not declare in its `Instance` struct (the
 * UV row `vertexInputs` drops with the UVs): the same stride, nothing fetched that no input reads. One object per
 * layout and kept set.
 */
export function instanceInputs(code: string, layout: GPUVertexBufferLayout): GPUVertexBufferLayout {
  const declared = /\bstruct Instance \{([^}]*)\}/.exec(code);
  if (!declared) return layout;
  const used = new Set([...declared[1].matchAll(/@location\((\d+)\)/g)].map((field) => +field[1])),
    attributes = [...layout.attributes].filter((a) => used.has(a.shaderLocation));
  if (attributes.length === [...layout.attributes].length) return layout;
  const key = attributes.map((a) => a.shaderLocation).join();
  let kept = instanceLayouts.get(layout);
  if (!kept) instanceLayouts.set(layout, (kept = new Map()));
  let out = kept.get(key);
  if (!out) kept.set(key, (out = { ...layout, attributes }));
  return out;
}

/**
 * Trims finished shader `source` to the vertex inputs it reads. Called once per pipeline built. `white`: every vertex
 * of the drawn buffer has colour (1, 1, 1, 1) (`whiteColours`), so the vertex stage reads that constant in place of
 * the colour input: the same value, without the 16-byte fetch.
 */
export function vertexInputs(source: string, white = false): VertexInputs {
  const unchanged = { code: source, locations: ALL, narrow: [] };
  if (!/\bstruct Input \{/.test(source) || source.split(':Input').length !== 2) return unchanged;
  if (Math.min(...stage(source)) < 0) return unchanged;
  let code = dropOutput(dropOutput(dropFlatFrame(source), 'tangent'), 'uv');
  const [start, end] = stage(code),
    open = code.indexOf(')->Out {', start);
  let body = code.slice(open, end);
  // `i` handed on whole could read anything.
  if (/\bi\b(?!\.)/.test(body)) return unchanged;
  if (white && /\bi\.color\b/.test(body)) {
    body = body.replace(/\bi\.color\b/g, 'vec4f(1)');
    code = code.slice(0, open) + body + code.slice(end);
  }
  // The instance's UV row goes with the output it fed.
  if (!body.includes('k.uvt')) code = code.replace(', @location(10) uvt:vec4f}', '}');
  const declared = /struct Input \{([^}]*)\}/.exec(code)!,
    fields = [...declared[1].matchAll(/@location\((\d+)\) (\w+):vec4f/g)],
    kept = fields.filter((field) => body.includes('i.' + field[2]));
  if (fields.length !== 5) return unchanged;
  return {
    // A built-in such as a node graph's vertex index costs no fetch, so it stays beside the kept attributes.
    code:
      kept.length < 5
        ? code.replace(declared[1], [...kept, ...declared[1].matchAll(/@builtin\(\w+\) \w+:\w+/g)].map((field) => field[0]).join(', '))
        : code,
    locations: kept.map((field) => +field[1]),
    // Every read of the input takes `.xyz` (position's w is 1 and normal's 0 in the buffer; neither is read).
    narrow: kept
      .filter(([, , name]) => {
        const reads = body.match(new RegExp(`\\bi\\.${name}\\b(\\.\\w+)?`, 'g'))!;
        return reads.every((read) => read.endsWith('.xyz'));
      })
      .map((field) => +field[1]),
  };
}
