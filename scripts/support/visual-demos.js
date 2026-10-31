// The site demos the visual check captures (scripts/visual-regression.js).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Baseline profiles with references for the voxel sandbox views (recorded on the RTX A6000 desktop: Edge 155 on 2026-10-19,
// Edge 156 on 2026-10-24).
const VOXEL = ['nvidia-ampere-msedge-155', 'nvidia-ampere-msedge-156'];
// path: URL path under the site root; ready: page expression true once the principal scene (and any full-detail
// upgrade) is on screen; mask: dynamic elements painted over. tonemap reads no tier, so its light view is skipped.
/**
 * A gallery page's view for the visual check: one hero section per landing batch (at most 13 in all, to hold check:merge
 * time). Baselines are recorded with `npm run visual:update -- --only=<id> --runs=4`.
 */
export const galleryView = (slug, section) => ({
  id: `gallery-${slug}`,
  path: `gallery/${slug}.html?section=${section}&view=${section}`,
  ready: 'window.gallery?.readiness===true',
  views: ['high'],
});

export const demos = [
  {
    id: 'night-citadel',
    path: 'night-citadel/',
    ready: '!!window.nightCitadel?.readiness',
    mask: ['#fps', '#delta', '#refresh-note'],
  },
  { id: 'gameplay-sandbox', path: 'gameplay-sandbox/', ready: '!!window.sandbox', mask: ['#telemetry *'] },
  // Voxel sandbox deterministic views (seed 1, fixed camera and clock, no HUD; examples/voxel-sandbox/README.md).
  // `profiles`: the baseline profiles that have references for them. On other hardware they are captured but skipped,
  // not failed, until `npm run visual:update -- --only=voxel --runs=4` records them there and the profile is added here.
  { id: 'voxel-overview', path: 'voxel/?view=overview', ready: 'window.voxelSandbox?.ready===true', profiles: VOXEL },
  { id: 'voxel-ground', path: 'voxel/?view=ground', ready: 'window.voxelSandbox?.ready===true', profiles: VOXEL },
  {
    id: 'voxel-night',
    path: 'voxel/?view=night',
    ready: 'window.voxelSandbox?.ready===true',
    views: ['high'],
    profiles: VOXEL,
  },
  // Slabs and stairs (DESIGN.md "Block shapes"): sun-shadowed half blocks, an inset deck step and a top-slab roof.
  {
    id: 'voxel-shapes',
    path: 'voxel/?view=shapes',
    ready: 'window.voxelSandbox?.ready===true',
    views: ['high'],
    profiles: ['nvidia-ampere-msedge-156'],
  },
  {
    id: 'character-animation',
    path: 'demos/character-animation.html',
    ready: "document.querySelector('#viewport')?.dataset.ready==='true'",
  },
  // The same page under its older URL; checked for device loss only.
  {
    id: 'robot-expressive',
    path: 'demos/robot-expressive.html',
    ready: "document.querySelector('#viewport')?.dataset.ready==='true'",
    views: ['high'],
    lossOnly: true,
  },
  {
    id: 'flight-helmet',
    path: 'demos/flight-helmet.html',
    ready: "document.querySelector('#viewport')?.dataset.ready==='true'&&window.extensionDemo.quality!=='preview'",
  },
  {
    id: 'windy-meadow',
    path: 'demos/windy-meadow.html',
    ready: "document.querySelector('#viewport')?.dataset.ready==='true'",
  },
  // Multi-view demos (docs/multi-view-roadmap.md M7): several views of one engine in one canvas.
  ...['split-screen', 'minimap'].map((id) => ({
    id,
    path: `demos/${id}.html`,
    ready: "document.querySelector('#viewport')?.dataset.ready==='true'",
  })),
  // Feature demos (docs/threejs-parity.md): batched mesh, clipping planes, scene targets (MRT), the depth texture,
  // Collada skins with KHR_animation_pointer glTFs, and one texture per image file format.
  ...['batched-mesh', 'clipping-planes', 'scene-targets', 'depth-texture', 'animation-formats', 'texture-formats'].map(
    (id) => ({
      id,
      path: `demos/${id}.html`,
      ready: "document.querySelector('#viewport')?.dataset.ready==='true'",
      views: ['high', 'phone'],
    }),
  ),
  // Weather (item 28.5): the state machine blends presets; rain, snow and hail are random per frame, so it is checked
  // for device loss only.
  {
    id: 'weather',
    path: 'demos/weather.html',
    ready: "document.querySelector('#viewport')?.dataset.ready==='true'",
    views: ['high'],
    lossOnly: true,
  },
  { id: 'earth', path: 'demos/earth/', ready: "!!window.earthDemo&&window.earthDemo.quality!=='preview'" },
  { id: 'dof', path: 'demos/dof/', ready: '!!window.dofDemo', views: ['high', 'light', 'phone'] },
  { id: 'tonemap', path: 'demos/tonemap/', ready: '!!window.tonemapDemo', views: ['high', 'phone'] },
  // Khronos sample assets: one small view per model, served by a Vite dev server from the repo root
  // (`dev`) because the site build must not ship 250 MB of models. Models that fail to load are left out.
  ...JSON.parse(readFileSync(resolve(import.meta.dirname, '../../examples/assets/khronos/manifest.json'), 'utf8'))
    .models.filter((m) => m.render?.verdict !== 'fails')
    .map((m) => ({
      id: `khronos-${m.name}`,
      path: `examples/khronos-gallery.html?model=${m.name}`,
      dev: true,
      ready: "document.body.dataset.ready==='true'",
      views: ['model'],
    })),
];
