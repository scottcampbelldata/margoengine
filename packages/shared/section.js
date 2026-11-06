// Optional renderers reuse the existing uniform of a scene's `section` plugin (a plugin that patches core's mesh
// shader and owns the binding named `section`); its patch and ownership stay unchanged. Per-material clipping planes (@margoengine/materials
// `clippingPlanes`) use the same layout under another name, so one shader can carry both.
const bindingPattern = /@group\(0\) @binding\((\d+)\) var<uniform> section:Section;/;
const cache = new Map();
// The section binding of the last shader read: draws call this per model, and a frame keeps one core shader.
let lastShader, lastBinding;
export function sectionState(context) {
  const shader = context.shader;
  if (shader !== lastShader) {
    const match = bindingPattern.exec(shader);
    lastShader = shader;
    lastBinding = match ? Number(match[1]) : undefined;
  }
  if (lastBinding === undefined) return;
  const bindings = context.bindings;
  for (let i = 0; i < bindings.length; i++)
    if (bindings[i].binding === lastBinding) {
      const resource = bindings[i].resource;
      return resource && 'buffer' in resource ? resource : undefined;
    }
}
/**
 * The WGSL statement that discards `position` against uniform `name`'s planes. A `section` plugin ('section') cuts away the
 * union of the planes' negative sides; other names read settings.y as the mode: 0 the union, 1 the intersection (a
 * point goes only when it is behind every plane).
 */
export function clipStatement(name, position = 'i.position') {
  if (name === 'section')
    return `for(var p=0u;p<u32(section.settings.x);p++){if(dot(section.planes[p].xyz,${position})+section.planes[p].w<0){discard;}}`;
  return `{let ${name}Count=u32(${name}.settings.x);var ${name}Behind=0u;for(var p=0u;p<${name}Count;p++){if(dot(${name}.planes[p].xyz,${position})+${name}.planes[p].w<0){${name}Behind++;}}if(${name}Count>0u&&select(${name}Behind>0u,${name}Behind==${name}Count,${name}.settings.y>0.5)){discard;}}`;
}
/** The planes uniform `name` of a material or caster, at `binding` of `group`. */
export const clipDeclaration = (group, binding, name) =>
  `struct ${name}Planes {planes:array<vec4f,6>,settings:vec4f}\n@group(${group}) @binding(${binding}) var<uniform> ${name}:${name}Planes;\n`;
/**
 * `code` cutting away the union of uniform `name`'s planes in the rasterizer, before the fragment stage, through WGSL's
 * `clip_distances` (the device needs the 'clip-distances' feature). The vertex stage returns a copy of `Out` that adds the
 * distances, as a fragment stage cannot read them; `position` is the world point, in scope at the stage's `return o;`.
 * A plane past the count gets 1, which cuts nothing. Apply it last: nothing can patch `->Out {` afterwards.
 */
export function clipDistances(code, name, position = 'o.position') {
  const head = /@vertex\s+fn\s+\w+\([\s\S]*?\)->Out\s*\{/.exec(code),
    end = head ? code.indexOf('return o;', head.index) : -1;
  if (end < 0) throw new TypeError('Hardware clip distances need a vertex stage that returns Out; use clippingPlanes without the feature');
  const fill = `for(var margoP=0u;margoP<6u;margoP++){o.margoClip[margoP]=select(1.0,dot(${name}.planes[margoP].xyz,${position})+${name}.planes[margoP].w,margoP<u32(${name}.settings.x));}`;
  return (
    'enable clip_distances;\n' +
    (code.slice(0, end) + fill + code.slice(end))
      .replace(head[0], head[0].replace('->Out', '->MargoClipped'))
      .replace('var o:Out;', 'var o:MargoClipped;')
      .replace(
        /struct Out \{([^}]*)\}/,
        (whole, fields) => `${whole}\nstruct MargoClipped {${fields.trimEnd().replace(/,$/, '')},@builtin(clip_distances) margoClip:array<f32,6>}`,
      )
  );
}
const distanceMark = /^\/\/ margo clip distances (\w+)$/m;
/** `code` asking whoever compiles it to apply `clipDistances` with uniform `name`, at `binding` of `group`. */
export const markClipDistances = (code, group, binding, name) =>
  `// margo clip distances ${name}\n${clipDeclaration(group, binding, name)}${code}`;
/** `code` as a device compiles it: with `clipDistances` applied if `markClipDistances` asked for it. */
export function markedClipDistances(code) {
  const match = distanceMark.exec(code);
  return match ? clipDistances(code, match[1]) : code;
}
export function sectionShader(source, group, binding, name = 'section') {
  const key = `${group}:${binding}:${name}:${source}`;
  if (cache.has(key)) return cache.get(key);
  const type = name === 'section' ? 'Section' : `${name}Planes`,
    clip = clipStatement(name);
  const signature = /@fragment\s+fn\s+\w+\(i:Out\b[^{]*\{/g;
  let code = '',
    cursor = 0,
    match;
  while ((match = signature.exec(source))) {
    const start = signature.lastIndex;
    let end = start,
      depth = 1;
    while (end < source.length && depth) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}') depth--;
      end++;
    }
    const body = source.slice(start, end - 1);
    code +=
      source.slice(cursor, start) +
      (body.includes('return')
        ? body.replace(
            /\breturn\s+([^;]+);/g,
            (_, value) => `{let ${name}Result=${value};${clip}return ${name}Result;}`,
          )
        : body + clip) +
      '}';
    cursor = signature.lastIndex = end;
  }
  code =
    `struct ${type} {planes:array<vec4f,6>,settings:vec4f}\n@group(${group}) @binding(${binding}) var<uniform> ${name}:${type};\n` +
    code +
    source.slice(cursor);
  if (cache.size >= 64) cache.clear();
  cache.set(key, code);
  return code;
}
