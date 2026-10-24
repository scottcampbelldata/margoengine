// Optional renderers reuse SectionPlanes' existing uniform; core and machinery
// keep their shader patch and ownership unchanged. Per-material clipping planes (@margoengine/materials
// `clippingPlanes`) use the same layout under another name, so one shader can carry both.
const bindingPattern = /@group\(0\) @binding\((\d+)\) var<uniform> section:Section;/;
const cache = new Map();
export function sectionState(context) {
  const match = bindingPattern.exec(context.shader);
  if (!match) return;
  const resource = context.bindings.find((entry) => entry.binding === Number(match[1]))?.resource;
  return resource && 'buffer' in resource ? resource : undefined;
}
/**
 * The WGSL statement that discards `position` against uniform `name`'s planes. SectionPlanes ('section') cut away the
 * union of the planes' negative sides; other names read settings.y as the mode: 0 the union, 1 the intersection (a
 * point goes only when it is behind every plane).
 */
export function clipStatement(name, position = 'i.position') {
  if (name === 'section')
    return `for(var p=0u;p<u32(section.settings.x);p++){if(dot(section.planes[p].xyz,${position})+section.planes[p].w<0){discard;}}`;
  return `{let ${name}Count=u32(${name}.settings.x);var ${name}Behind=0u;for(var p=0u;p<${name}Count;p++){if(dot(${name}.planes[p].xyz,${position})+${name}.planes[p].w<0){${name}Behind++;}}if(${name}Count>0u&&select(${name}Behind>0u,${name}Behind==${name}Count,${name}.settings.y>0.5)){discard;}}`;
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
