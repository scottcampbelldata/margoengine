// What check.mjs compares with Cycles. `iou` is the least overlap of the two shadow regions (under half the light), and
// `difference` the largest mean visibility error over the ground. A shadow map's edge can sit up to one texel from the true
// edge and the frame's pixels are the ground's sample grid, so the bounds below come from those two sizes on each scene's
// shadow perimeter, not from a run's result.
const box = { min: [-1.2, -0.1, -1.2], max: [1.2, 1, 1.2] };
const hard = { resolution: 4096, bounds: box, filter: 'hard', casterMargin: 1, bias: 0.0002, normalBias: 0.002 };
const cup = { resolution: 4096, bounds: { min: [-0.3, -0.01, -0.3], max: [0.3, 0.12, 0.3] }, filter: 'hard', casterMargin: 1, bias: 0.0002, normalBias: 0.0005 };
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
  // The plant under a sun of 0.04 half-angle tangent, Cycles' soft edges. PCSS is the reference for what a map can do here:
  // a variance edge has one width, so it is too wide near the stems and too narrow far up, and the bound is that spread.
  { name: 'soft-pcss', scene: 'soft', kind: 'shadows', minShadow: 2000, iou: 0.85, difference: 0.03, options: { ...hard, filter: 'soft', lightSize: 0.04 } },
  { name: 'soft-variance', scene: 'soft', kind: 'shadows', minShadow: 2000, iou: 0.75, difference: 0.03, options: { ...hard, filter: undefined, variance: { size: 2048, blur: 8, bleed: 0.1 } } },
  // Light through real leaves and a real cup, against Cycles' translucent BSDF of KHR_materials_diffuse_transmission with one
  // bounce, deep in the shadow (`core`). A sheet scatters what it passes, so the ground far below gets the small share the sheet
  // subtends there: under 1 percent in both renderers, where the control, the light going straight on, gives 5. One 8-bit step
  // here is about 0.004, so `near` is two steps and a half. Margo reads the factors alone, so `scale` gives the cup's texture
  // its mean, 0.47. A closed cup is this model's worst case, one scatter where light takes two walls: its bound is the 0.04
  // that one extra scatter can leave, and docs/limits.md says so.
  { name: 'leaf-through', scene: 'leaf', kind: 'shadows', core: 0.1, near: 0.01, difference: 0.03, options: { ...hard, colored: true, size: 0.05 } },
  { name: 'leaf-straight', scene: 'leaf', kind: 'shadows', core: 0.1, far: 0.04, difference: 0.03, options: { ...hard, colored: true } },
  { name: 'cup-through', scene: 'cup', kind: 'shadows', core: 0.1, near: 0.05, difference: 0.03, options: { ...cup, colored: true, scale: 0.47, size: 0.015 } },
  // The same mountain past the cascades: a `distance` of 30 ends them long before the ground the camera sees, 170 units off.
  // The field is the tile's own grid, so its edge is the terrain's to within a cell, as in rainier-shadows. The control has no
  // far shadows and sees none.
  { name: 'rainier-far', scene: 'rainier', kind: 'shadows', minShadow: 2000, iou: 0.75, difference: 0.05, options: { distance: 30, filter: 'hard', casterMargin: 10, far: { bias: 0.1, sunSize: 0 } } },
  { name: 'rainier-far-virtual', scene: 'rainier', kind: 'virtual', minShadow: 2000, iou: 0.75, difference: 0.05, options: { distance: 30, filter: 'hard', casterMargin: 10, far: { bias: 0.1, sunSize: 0 } } },
  { name: 'rainier-far-control', scene: 'rainier', kind: 'shadows', minShadow: 2000, below: 0.2, options: { distance: 30, filter: 'hard', casterMargin: 10 } },
  // A styled shadow against two suns of the same direction in Cycles: one casting, of colour 1 - floor, and one casting nothing,
  // of colour floor, whose light is exactly what the style leaves. Red and blue are separate renders, as the floors differ.
  // `near` is the bound of the plain plant's edges on a mean over the shadow, some 3 of 100 pixels off by the floor's height.
  // The control is the same plant with no style, which leaves none of the floor.
  { name: 'style-red', scene: 'style-red', kind: 'shadows', core: 0.5, near: 0.03, difference: 0.03, options: { ...hard, look: { intensity: 0.8, color: [0.1, 0.3, 0.6] } } },
  { name: 'style-blue', scene: 'style-blue', kind: 'shadows', core: 0.8, near: 0.03, difference: 0.03, channel: 2, options: { ...hard, look: { intensity: 0.8, color: [0.1, 0.3, 0.6] } } },
  { name: 'style-virtual', scene: 'style-red', kind: 'virtual', core: 0.5, near: 0.03, difference: 0.03, options: { distance: 8, filter: 'hard', casterMargin: 2, bias: 0.001, normalBias: 0.002, look: { intensity: 0.8, color: [0.1, 0.3, 0.6] } } },
  { name: 'style-control', scene: 'style-red', kind: 'shadows', core: 0.5, far: 0.2, difference: 0.03, options: hard },
  // Rays against the plant's own triangles, as Cycles', so what is left is its pixel filter over the frame's one sample a pixel.
  // A sun of 0.04 takes 64 rays: their noise is 1 / (2 sqrt(64)) of a pixel at worst, 0.06, and the mean over the ground far less.
  // The control traces an empty tree over the same map: no shadow may stay, or the map is drawing it.
  { name: 'rays-hard', scene: 'plant', kind: 'shadows', minShadow: 2000, iou: 0.9, difference: 0.03, options: { ...hard, traced: { rays: 1, bias: 0.001 } } },
  { name: 'rays-soft', scene: 'soft', kind: 'shadows', minShadow: 2000, iou: 0.9, difference: 0.03, options: { ...hard, traced: { rays: 64, lightSize: 0.04, bias: 0.001 } } },
  { name: 'rays-control', scene: 'plant', kind: 'shadows', minShadow: 2000, below: 0.2, control: 'empty', options: { ...hard, traced: { rays: 1, bias: 0.001 } } },
  { name: 'alpha-control', scene: 'alpha', kind: 'shadows', minShadow: 1000, below: 0.78, control: 'solid', options: panels },
];
