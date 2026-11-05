// What a finished PBR shader reads of the 80-byte vertex. Every primitive's buffer holds position, normal, tangent, two
// UV sets and colour as five vec4; a draw whose shader reads fewer fetches fewer (a standard material with no maps:
// 0.63 -> 0.47 ms at 50,000 boxes). Runs on the final text, after every patch, so no patch needs to anchor on a trimmed
// vertex stage. Anything it cannot read for certain keeps every input.

export interface VertexInputs {
  /** The shader to compile. */
  readonly code: string;
  /** The vertex locations it reads, ascending. */
  readonly locations: readonly number[];
}

const ALL: readonly number[] = [0, 1, 2, 3, 4];
// The tangent frame of `surface`, then the mapped normal it exists for.
const frame = /\n {2}var t=i\.tangent\.xyz-n\*dot\(n,i\.tangent\.xyz\);[^]*?\n {2}s\.n=normalize\(t\*sampledNormal\.x\*f\.factors\.z\+b\*sampledNormal\.y\*f\.factors\.z\+n\*sampledNormal\.z\);/;
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

/** Trims finished shader `source` to the vertex inputs it reads. Called once per pipeline built. */
export function vertexInputs(source: string): VertexInputs {
  const unchanged = { code: source, locations: ALL };
  if (!/\bstruct Input \{/.test(source) || source.split(':Input').length !== 2) return unchanged;
  if (Math.min(...stage(source)) < 0) return unchanged;
  let code = dropOutput(dropOutput(dropFlatFrame(source), 'tangent'), 'uv');
  const [start, end] = stage(code),
    body = code.slice(code.indexOf(')->Out {', start), end);
  // `i` handed on whole could read anything.
  if (/\bi\b(?!\.)/.test(body)) return unchanged;
  // The instance's UV row goes with the output it fed.
  if (!body.includes('k.uvt')) code = code.replace(', @location(10) uvt:vec4f}', '}');
  const declared = /struct Input \{([^}]*)\}/.exec(code)!,
    fields = [...declared[1].matchAll(/@location\((\d+)\) (\w+):vec4f/g)],
    kept = fields.filter((field) => body.includes('i.' + field[2]));
  if (fields.length !== 5) return unchanged;
  return {
    code: kept.length < 5 ? code.replace(declared[1], kept.map((field) => field[0]).join(', ')) : code,
    locations: kept.map((field) => +field[1]),
  };
}
