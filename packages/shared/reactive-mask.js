// A pass whose look moves with no motion vector that follows it (Water's waves carry their reflections and ripples
// along) puts this frame's reactive mask here, red 0 to 1 for how far to distrust history, and TAA reads every mask
// published for its frame by itself, so no scene has to hand one to the other (KB-WATER-TAASMEAR1). Kept on the pass
// context for the encoder and view it was drawn in, so a frame or view without the pass never reads a stale or
// destroyed texture. Several publishers in one frame (a sea and a river) are all kept; TAA takes their maximum.
const key = Symbol.for('margoengine.optional.reactive-mask');
// Each read counts here, so a publisher whose mask costs a pass of its own (Weather's and VFX's particles) draws it only
// while something reads masks (KB-TAA-PARTICLEMASK1).
const demand = Symbol.for('margoengine.optional.reactive-mask.demand');
// The particle mask that publishers without a mask of their own share: one r8unorm texture per context.
const target = Symbol.for('margoengine.optional.reactive-mask.target');
const seen = new WeakMap();
export function publishReactiveMask(c, texture) {
  const entry = c[key];
  if (entry && entry.encoder === c.encoder && entry.view === c.view) {
    if (!entry.textures.includes(texture)) entry.textures.push(texture);
  } else c[key] = { encoder: c.encoder, view: c.view, textures: [texture] };
}
export function reactiveMasks(c) {
  c[demand] = (c[demand] ?? 0) + 1;
  const entry = c[key];
  return entry && entry.encoder === c.encoder && entry.view === c.view ? entry.textures : [];
}
// Whether masks were read since `owner`'s frame before this one: decided once per encoder, so every view of a frame
// gets the same answer, and false from the second frame after the last read (the reader was detached).
export function reactiveMaskWanted(c, owner) {
  const reads = c[demand];
  let s = seen.get(owner);
  if (!s) seen.set(owner, (s = { encoder: undefined, reads: undefined, wanted: false }));
  if (s.encoder !== c.encoder) {
    s.wanted = reads !== undefined && s.reads !== reads;
    s.reads = reads;
    s.encoder = c.encoder;
  }
  return s.wanted;
}
// The colour attachment of the shared particle mask for this frame and view, at the frame's size and sample count (a
// multisampled frame draws into a multisampled twin resolved into the mask each pass): the first draw of a view clears
// it, later ones load it, and the mask is published for TAA. Draw coverage into red with a max blend.
export function reactiveTarget(c) {
  const samples = c.descriptor.multisample?.count ?? 1;
  let t = c[target];
  if (!t || t.device !== c.device || t.width !== c.width || t.height !== c.height || t.samples !== samples) {
    t?.mask.destroy();
    t?.multi?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      size = [c.width, c.height];
    t = c[target] = {
      device: c.device,
      width: c.width,
      height: c.height,
      samples,
      mask: c.device.createTexture({
        label: 'reactive particle mask',
        size,
        format: 'r8unorm',
        usage,
      }),
      multi:
        samples > 1
          ? c.device.createTexture({
              label: 'reactive particle mask (multisampled)',
              size,
              format: 'r8unorm',
              sampleCount: samples,
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
          : undefined,
      encoder: undefined,
      view: undefined,
    };
    t.maskView = t.mask.createView();
    t.multiView = t.multi?.createView();
  }
  const first = t.encoder !== c.encoder || t.view !== c.view;
  t.encoder = c.encoder;
  t.view = c.view;
  publishReactiveMask(c, t.mask);
  return {
    view: t.multiView ?? t.maskView,
    resolveTarget: t.multi ? t.maskView : undefined,
    loadOp: first ? 'clear' : 'load',
    clearValue: [0, 0, 0, 0],
    storeOp: 'store',
  };
}
// The blend of a draw into the shared mask: each pixel keeps the largest coverage drawn over it.
const max = { operation: 'max', srcFactor: 'one', dstFactor: 'one' };
export const reactiveBlend = { color: max, alpha: max };
