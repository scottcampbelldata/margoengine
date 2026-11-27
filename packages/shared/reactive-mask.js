// A pass whose look moves with no motion vector that follows it (Water's waves carry their reflections and ripples
// along) puts this frame's reactive mask here, red 0 to 1 for how far to distrust history, and TAA reads every mask
// published for its frame by itself, so no scene has to hand one to the other (KB-WATER-TAASMEAR1). Kept on the pass
// context for the encoder and view it was drawn in, so a frame or view without the pass never reads a stale or
// destroyed texture. Several publishers in one frame (a sea and a river) are all kept; TAA takes their maximum.
const key = Symbol.for('margoengine.optional.reactive-mask');
export function publishReactiveMask(c, texture) {
  const entry = c[key];
  if (entry && entry.encoder === c.encoder && entry.view === c.view) {
    if (!entry.textures.includes(texture)) entry.textures.push(texture);
  } else c[key] = { encoder: c.encoder, view: c.view, textures: [texture] };
}
export function reactiveMasks(c) {
  const entry = c[key];
  return entry && entry.encoder === c.encoder && entry.view === c.view ? entry.textures : [];
}
