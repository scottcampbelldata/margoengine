/** Snapshot buffer ranges because callers may update binding wrappers in place. */
export function sameBindings(previous: readonly GPUBindGroupEntry[], entries: readonly GPUBindGroupEntry[]): boolean {
  if (previous.length !== entries.length) return false;
  for (let i = 0; i < previous.length; i++) {
    const old = previous[i],
      entry = entries[i],
      a = old.resource,
      b = entry.resource;
    if (
      old.binding !== entry.binding ||
      !(
        a === b ||
        ('buffer' in a && 'buffer' in b && a.buffer === b.buffer && a.offset === b.offset && a.size === b.size)
      )
    )
      return false;
  }
  return true;
}
export function snapshotBindings(entries: readonly GPUBindGroupEntry[]): GPUBindGroupEntry[] {
  return entries.map(({ binding, resource }) => ({
    binding,
    resource:
      'buffer' in resource ? { buffer: resource.buffer, offset: resource.offset, size: resource.size } : resource,
  }));
}
