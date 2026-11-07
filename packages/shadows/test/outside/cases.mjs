// What check.mjs compares with Cycles. `iou` is the least overlap of the two shadow regions (under half the light), and
// `difference` the largest mean visibility error over the ground. A shadow map's edge can sit up to one texel from the true
// edge and the frame's pixels are the ground's sample grid, so the bounds below come from those two sizes on each scene's
// shadow perimeter, not from a run's result.
const box = { min: [-1.2, -0.1, -1.2], max: [1.2, 1, 1.2] };
const hard = { resolution: 4096, bounds: box, filter: 'hard', casterMargin: 1, bias: 0.0002, normalBias: 0.002 };
const panels = { ...hard, bounds: { min: [-6, -0.2, -6], max: [6, 2.5, 3] } };
export const cases = [
  // Leaves of the real DiffuseTransmissionPlant, an alpha MASK material on modelled leaf outlines.
  { name: 'plant-hard', scene: 'plant', kind: 'shadows', minShadow: 2000, iou: 0.9, difference: 0.03, options: hard },
  { name: 'plant-virtual', scene: 'plant', kind: 'virtual', minShadow: 2000, iou: 0.9, difference: 0.03, options: { distance: 8, filter: 'hard', casterMargin: 2, bias: 0.001, normalBias: 0.002 } },
  // The real AlphaBlendModeTest panels, cutoffs 0.25, 0.5 and 0.75 on the same alpha gradients: the shadows are the texture's
  // shapes. Their whole quads, the control, cover far more ground. Each panel's texture keeps a one-texel strip on its
  // edges, far under a pixel here: Cycles averages it over the pixel, Margo's one sample per pixel finds it or not, some 150
  // pixels of 1,600 either way, which is where the overlap bound comes from. Pages have coarser texels than the 4096 map.
  { name: 'alpha-hard', scene: 'alpha', kind: 'shadows', minShadow: 1000, iou: 0.85, difference: 0.03, options: panels },
  { name: 'alpha-virtual', scene: 'alpha', kind: 'virtual', minShadow: 1000, iou: 0.78, difference: 0.03, options: { distance: 20, filter: 'hard', casterMargin: 4, bias: 0.002, normalBias: 0.002 } },
  // Real elevation of Mount Rainier (Terrarium tile 10/165/360), a `drawShadow` source. Terrain draws a clipmap of its heights
  // and Cycles the tile's own grid, so edges can differ by one cell, 1 unit, some 2 pixels here.
  { name: 'rainier-shadows', scene: 'rainier', kind: 'shadows', minShadow: 2000, iou: 0.75, difference: 0.05, options: { resolution: 4096, bounds: { min: [-135, 0, -135], max: [135, 45, 135] }, filter: 'hard', casterMargin: 10, bias: 0.0002, normalBias: 0.05 } },
  { name: 'rainier-virtual', scene: 'rainier', kind: 'virtual', minShadow: 2000, iou: 0.75, difference: 0.05, options: { distance: 400, filter: 'hard', casterMargin: 100, bias: 0.1, normalBias: 0.1 } },
  { name: 'rainier-control', scene: 'rainier', kind: 'virtual', minShadow: 2000, below: 0.75, control: 'nocast', options: { distance: 400, filter: 'hard', casterMargin: 100, bias: 0.2, normalBias: 0.2 } },
  // A real image as a light pattern against a real sheet of that image across the sun. Both read the same texels, so what
  // parts them is how a bilinear tap at one sample per pixel meets Cycles' 64 samples: the edges of the half-light regions
  // move by under a pixel, which is a few percent of these thin wisps' perimeter over area.
  { name: 'pattern-shadows', scene: 'pattern', kind: 'shadows', minShadow: 2000, iou: 0.9, difference: 0.03, options: { resolution: 256, bounds: box, filter: 'hard' } },
  { name: 'pattern-virtual', scene: 'pattern', kind: 'virtual', minShadow: 2000, iou: 0.9, difference: 0.03, options: { distance: 20, filter: 'hard' } },
  { name: 'pattern-control', scene: 'pattern', kind: 'shadows', minShadow: 2000, below: 0.8, control: 'shifted', options: { resolution: 256, bounds: box, filter: 'hard' } },
  { name: 'alpha-control', scene: 'alpha', kind: 'shadows', minShadow: 1000, below: 0.78, control: 'solid', options: panels },
];
