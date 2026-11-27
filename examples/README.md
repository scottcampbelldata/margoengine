# Examples

Every example runs from source. Set up the repository first (see [Build from source](../README.md#build-from-source)),
then build the packages once:

```sh
npm run build:packages
```

## Example pages

Start the dev server from the repository root and open a page:

```sh
npm run dev:examples
# http://127.0.0.1:5173/examples/flight-helmet.html
```

The server watches only the files it has served, so pages load as soon as it starts, also with several tabs already
open, and a page reloads when a file it loaded changes, a rebuilt package included (docs/limits.md, "Root dev server
file watching").

Pages use WebGPU, with a WebGL2 compatibility fallback where supported. A page shows a short notice when neither
backend can run it.

| Page | What it shows |
| --- | --- |
| [sciviz-head.html](sciviz-head.html) | CC0 OpenNeuro head MRI: volume cutaway, three slice axes and a GPU isosurface |
| [sciviz-stars.html](sciviz-stars.html) | One million public-domain 2MASS sources in observed sky position and colour space, with EDL and selection linked to a histogram |
| [sciviz-wind.html](sciviz-wind.html) | Eight real NOAA daily wind fields with streamlines, arrows and gap-free trace replacement |
| [sciviz-volume.html](sciviz-volume.html) | Synthetic volume rendering and GPU-generated scalar data |
| [sciviz-points.html](sciviz-points.html) | Synthetic Gaussian point clusters with a point budget |
| [sciviz-surface.html](sciviz-surface.html) | GPU-generated wave surface |
| [boulder.html](boulder.html) | A robot climbs a wall: IK that keeps its arms clear of the wall and itself ([details](boulder/README.md)) |
| [animation-formats.html](animation-formats.html) | Collada skins and glTF animation pointers |
| [batched-mesh.html](batched-mesh.html) | Many shapes drawn in one call |
| [character-animation.html](character-animation.html) | A walking robot with blendable expressions |
| [clipping-planes.html](clipping-planes.html) | Section planes on every material |
| [depth-texture.html](depth-texture.html) | A depth texture that any material can sample |
| [flight-helmet.html](flight-helmet.html) | The Khronos Flight Helmet with PBR materials |
| [gpu-flocking.html](gpu-flocking.html) | 16,384 GPU birds or fish fleeing the pointer, live flocking rules and the flock's debug view |
| [gpu-liquid.html](gpu-liquid.html) | A tank of 65,536 GPU MLS-MPM liquid particles drawn as a surface: stir it with the pointer, drop a floating box in, open the debug view |
| [khronos-gallery.html](khronos-gallery.html) | Khronos glTF sample assets |
| [gallery/](gallery/index.html) | The Harrow Head gallery: live pages by feature ([direction](gallery/DIRECTION.md)) |
| [kinematics-constraints.html](kinematics-constraints.html) | Arm clearance check with the kinematics package |
| [physics-breakable.html](physics-breakable.html) | Breakable stone pillar, brick wall, and glass pane with Voronoi fracture, support anchors, cumulative damage, and debug overlay |
| [physics-rigid.html](physics-rigid.html) | 800 instanced boxes and spheres (one body per instance, two draws) falling onto heightfield terrain, a pointer ray that pushes what it hits, an explosion, and shapes with their computed mass beside the exact one |
| [physics-joints.html](physics-joints.html) | A hinged door with a stop and a motor, a three-link multibody arm on position motors, and a chain of limited ball joints, with the joint frames and limits debug view |
| [hud-preview.html](hud-preview.html) | A HUD scene and an item-preview scene over a main scene |
| [minimap.html](minimap.html) | A second camera view as a minimap |
| [robot-expressive.html](robot-expressive.html) | The same character study as a standalone page |
| [scene-targets.html](scene-targets.html) | Several render targets with named outputs |
| [split-screen.html](split-screen.html) | Two players, two views, render layers |
| [texture-formats.html](texture-formats.html) | TGA, TIFF, KTX and DDS textures |
| [weather.html](weather.html) | Weather presets that blend: rain, snow, hail, lightning, wind and wet or snowy ground |
| [windy-meadow.html](windy-meadow.html) | Grass, wind and a changing sky |
| [ocean.html](ocean.html) | Spectral FFT ocean with live `setWind`, `WATER_LOOKS`, chop/whitecaps sliders, dive-underwater camera, synchronous CPU `sample()` buoy and debug overlays |
| [water-ripples.html](water-ripples.html) | Interactive ripple pond with click/drag `disturbRay`, `trackBody` moving boat wakes, reflecting obstacle pillars/walls, rain toggle and debug heatmaps |
| [orrery/](orrery/index.html) | A brass orrery under a glass dome: any date puts the planets at their real heliocentric longitudes ([details](orrery/README.md)) |
| [cabin-hearth/](cabin-hearth/index.html) | A snowbound log cabin at night: one lit window in falling snow, a fire in the hearth and a kettle steaming ([details](cabin-hearth/README.md)) |
| [whiteout-pass/](whiteout-pass/index.html) | A blizzard at dusk on a mountain pass: snow streams past a log hut with one warm lit window, and the storm eases into a lull ([details](whiteout-pass/README.md)) |
| [event-horizon/](event-horizon/index.html) | A spinning black hole traced through Kerr spacetime: the lensed disk, its jet, the light paths and maps of redshift, beaming, temperature and image order ([details](event-horizon/README.md)) |
| [kitty-hawk/](kitty-hawk/index.html) | The Wright Flyer's four flights of 17 December 1903 over the Kill Devil Hills dune coast, from the published distances and times, with a film grade and camera rigs for shot files |
| [storm-light/](storm-light/index.html) | A lighthouse on a headland at night in a building storm: beam shafts in fog, rain, lightning and a heaving sea ([details](storm-light/README.md)) |
| [molten-words/](molten-words/index.html) | Any typed word as dripping liquid chrome |
| [cathedral-light/](cathedral-light/index.html) | Sun through stained glass into a dusty hall, with a time-of-day slider |
| [cad-viewer/](cad-viewer/index.html) | A STEP part in a CAD viewer: orbit and view cube, sections, dimensions and measurements ([details](cad-viewer/README.md)) |
| [biomes/](biomes/index.html) | A 4 km landscape from a biome map: climate controls, a Koppen and layer map, biome painting and height and mask exports |

The same server also serves the loader examples:

| Page | What it shows |
| --- | --- |
| [blender-loader/](blender-loader/) | Loading a `.margo` file exported from Blender |
| [usdz-loader/](usdz-loader/) | Loading USDZ and USDA files |
| [webxr-orbit/](webxr-orbit/) | A WebXR session around a simple scene |
| [xr-device-check/](xr-device-check/) | Runs WebXR on a real headset or phone and saves the record [docs/xr-device-runs](../docs/xr-device-runs/README.md) keeps |

### Ready and error state

Page checks wait for `data-ready` on one element of the page. Pages set it only through
[demo-status.ts](demo-status.ts), so an error stays on screen and the page is never marked ready after it
(`tests/demo-status.test.js` fails on a page that writes `data-ready` itself):

```ts
import { demoStatus } from './demo-status.ts';

const canvas = document.querySelector('canvas')!,
  page = demoStatus(canvas, document.querySelector<HTMLElement>('#status'));
try {
  // ... build the scene ...
  page.ready('Scene ready.'); // data-ready="true", unless page.error ran first
} catch (cause) {
  page.error(cause); // shows the message, removes data-ready, sets data-error
}
```

## Projects

These are separate npm workspaces with their own dev server.

| Folder | Run | What it is |
| --- | --- | --- |
| [vite/](vite/) | `npm run modern:dev` | Starter app with Vite and TypeScript |
| [react-viewer/](react-viewer/) | `npm run dev --workspace @margoengine/react-viewer` | A model viewer in React |
| [next/](next/) | `npm run dev --workspace @margoengine/starter-next` | A Next.js app |
| [gameplay-sandbox/](gameplay-sandbox/) | `npm run dev:sandbox` | A small third-person game ([details](gameplay-sandbox/README.md)) |
| [voxel-sandbox/](voxel-sandbox/) | `npm run dev:voxel` | A voxel world ([details](voxel-sandbox/README.md)) |

## Scripts and workloads

| Folder | What it is |
| --- | --- |
| [package-benchmarks/](package-benchmarks/) | Workloads that measure individual packages ([details](package-benchmarks/README.md)) |
| [assets/](assets/) | Models and textures used by the examples, with their credits |

The real-data scientific demos keep local, licensed assets and their reproducible preparation notes in
[assets/sciviz](assets/sciviz/README.md). Their browser checks cover WebGPU and the WebGL2 fallback at desktop
and phone sizes, fast control changes and PNG downloads. The earlier four synthetic sciviz pages are retained
only as [package browser test pages](../packages/sciviz/tests/pages/README.md).
