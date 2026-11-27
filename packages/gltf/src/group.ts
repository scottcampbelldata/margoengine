const empty = new WeakMap<GPUDevice, GPUBindGroup>();
/** Per pipeline (made by `notePipeline`): for each group, the bindings its entry points statically use. */
const uses = new WeakMap<GPURenderPipeline, Map<number, Set<number>>>();
const reached = new Map<string, Map<string, Map<number, Set<number>>>>();

/**
 * The bindings each group of `code` holds that `entries` (the pipeline's entry points) statically use: a resource is
 * statically used when a function reachable from an entry point names it (WGSL, "Statically Accessed"), and a
 * `layout: 'auto'` pipeline's group layouts hold only those (WebGPU, "default pipeline layout"). So a group built for
 * that pipeline may bind no other: a material map that only another entry reads (the transmission tint's thickness
 * map, KB-OIT-BLENDTHICK1) must stay out of a draw whose entry never reads it. Shader text ships without comments
 * (KB-WGSL1), so a name in it is a use. Cached by code and entry points.
 */
export function staticBindings(code: string, entries: readonly string[]): Map<number, Set<number>> {
  let byEntries = reached.get(code);
  if (!byEntries) {
    if (reached.size >= 256) reached.clear();
    reached.set(code, (byEntries = new Map()));
  }
  const key = entries.join();
  let out = byEntries.get(key);
  if (out) return out;
  const bodies = new Map<string, string>();
  for (const m of code.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
    let at = code.indexOf('{', m.index),
      depth = 0,
      end = at;
    for (; end < code.length; end++)
      if (code[end] === '{') depth++;
      else if (code[end] === '}' && !--depth) break;
    bodies.set(m[1], code.slice(m.index, end + 1));
  }
  const seen = new Set<string>(),
    queue = entries.filter((name) => bodies.has(name));
  let text = '';
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const body = bodies.get(name)!;
    text += body + '\n';
    for (const [word] of body.matchAll(/\b\w+\b/g)) if (bodies.has(word) && !seen.has(word)) queue.push(word);
  }
  const names = new Set(text.match(/\b\w+\b/g));
  out = new Map();
  for (const m of code.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+(\w+)/g)) {
    const group = +m[1];
    if (!out.has(group)) out.set(group, new Set());
    if (names.has(m[3])) out.get(group)!.add(+m[2]);
  }
  byEntries.set(key, out);
  return out;
}
/** Records which bindings of each group `pipeline` (a `layout: 'auto'` pipeline of `code`) uses, for `pipelineGroup`. */
export function notePipeline(pipeline: GPURenderPipeline, code: string, descriptor: GPURenderPipelineDescriptor): void {
  const names = [descriptor.vertex.entryPoint, descriptor.fragment?.entryPoint].filter((n): n is string => !!n);
  uses.set(pipeline, staticBindings(code, names));
}

/**
 * Bind group `index` of an auto-layout pipeline. Entries the pipeline's entry points do not use are left out when the
 * pipeline was noted (`notePipeline`): its layout has no slot for them. With no entries it is one empty group of an
 * explicit layout: WebKit gives an invalid layout for a group past the last one the shader uses, which a material
 * without textures reaches, and the draw then fails. Every browser accepts the explicit empty group at any index.
 */
export function pipelineGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  index: number,
  entries: GPUBindGroupEntry[],
): GPUBindGroup {
  const used = uses.get(pipeline)?.get(index);
  if (used) entries = entries.filter((entry) => used.has(entry.binding));
  if (entries.length) return device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries });
  let group = empty.get(device);
  if (!group) {
    group = device.createBindGroup({ layout: device.createBindGroupLayout({ entries: [] }), entries: [] });
    empty.set(device, group);
  }
  return group;
}
