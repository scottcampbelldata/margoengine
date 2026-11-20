// What every 2D lighting pass shares about the GPU objects it binds: a caller's texture held by the borrowed-object
// rule (docs/conventions.md, "Borrowed GPU objects"), one view per texture and bind groups made again only when what
// they bind changes, so a steady frame makes no view and no bind group.

export { TextureOption, type TextureSource2D } from '../../shared/texture-option.js';

const views = new WeakMap<GPUTexture, GPUTextureView>();
/** The texture's whole view, made once per texture. */
export function viewOf(texture: GPUTexture): GPUTextureView {
  let view = views.get(texture);
  if (!view) views.set(texture, (view = texture.createView()));
  return view;
}

/** The objects one entry binds, in a fixed order, so two entry lists compare without building anything. */
const part = (entry: GPUBindGroupEntry, k: number): unknown => {
  const r = entry.resource as Partial<GPUBufferBinding>;
  return k === 0 ? entry.binding : k === 1 ? (r.buffer ?? entry.resource) : k === 2 ? r.offset : r.size;
};

/** Bind groups by name, each made again only when its device, layout or anything it binds changes. */
export class BindGroups {
  readonly #made = new Map<string, { device: GPUDevice; layout: GPUBindGroupLayout; parts: unknown[]; group: GPUBindGroup }>();
  get(device: GPUDevice, name: string, layout: GPUBindGroupLayout, entries: GPUBindGroupEntry[]): GPUBindGroup {
    const old = this.#made.get(name);
    if (old && old.device === device && old.layout === layout && old.parts.length === entries.length * 4) {
      let same = true;
      for (let i = 0; same && i < old.parts.length; i++) same = old.parts[i] === part(entries[i >> 2]!, i & 3);
      if (same) return old.group;
    }
    const group = device.createBindGroup({ layout, entries });
    this.#made.set(name, {
      device,
      layout,
      parts: Array.from({ length: entries.length * 4 }, (_, i) => part(entries[i >> 2]!, i & 3)),
      group,
    });
    return group;
  }
  /** Forgets every group, as at a device restore. */
  clear(): void {
    this.#made.clear();
  }
}
