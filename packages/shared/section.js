// Optional renderers reuse SectionPlanes' existing uniform; core and machinery
// keep their shader patch and ownership unchanged.
const bindingPattern = /@group\(0\) @binding\((\d+)\) var<uniform> section:Section;/;
const cache = new Map();
export function sectionState(context) {
  const match = bindingPattern.exec(context.shader);
  if (!match) return;
  const resource = context.bindings.find((entry) => entry.binding === Number(match[1]))?.resource;
  return resource && 'buffer' in resource ? resource : undefined;
}
export function sectionShader(source, group, binding) {
  const key = `${group}:${binding}:${source}`;
  if (cache.has(key)) return cache.get(key);
  const clip =
    'for(var p=0u;p<u32(section.settings.x);p++){if(dot(section.planes[p].xyz,i.position)+section.planes[p].w<0){discard;}}';
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
            (_, value) => `{let sectionResult=${value};${clip}return sectionResult;}`,
          )
        : body + clip) +
      '}';
    cursor = signature.lastIndex = end;
  }
  code =
    `struct Section {planes:array<vec4f,6>,settings:vec4f}\n@group(${group}) @binding(${binding}) var<uniform> section:Section;\n` +
    code +
    source.slice(cursor);
  if (cache.size >= 64) cache.clear();
  cache.set(key, code);
  return code;
}
