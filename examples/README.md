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
| [khronos-gallery.html](khronos-gallery.html) | Khronos glTF sample assets |
| [gallery/](gallery/index.html) | The Harrow Head gallery: live pages by feature ([direction](gallery/DIRECTION.md)) |
| [kinematics-constraints.html](kinematics-constraints.html) | Arm clearance check with the kinematics package |
| [minimap.html](minimap.html) | A second camera view as a minimap |
| [robot-expressive.html](robot-expressive.html) | The same character study as a standalone page |
| [scene-targets.html](scene-targets.html) | Several render targets with named outputs |
| [split-screen.html](split-screen.html) | Two players, two views, render layers |
| [texture-formats.html](texture-formats.html) | TGA, TIFF, KTX and DDS textures |
| [tokyo-diorama.html](tokyo-diorama.html) | A street corner animated in Blender and played back by the animation package |
| [weather.html](weather.html) | Weather presets that blend: rain, snow, hail, lightning, wind and wet or snowy ground |
| [windy-meadow.html](windy-meadow.html) | Grass, wind and a changing sky |
| [molten-words/](molten-words/index.html) | Any typed word as dripping liquid chrome |
| [cathedral-light/](cathedral-light/index.html) | Sun through stained glass into a dusty hall, with a time-of-day slider |
| [biomes/](biomes/index.html) | A 4 km landscape from a biome map: climate controls, a Koppen and layer map, biome painting and height and mask exports |

The same server also serves the loader examples:

| Page | What it shows |
| --- | --- |
| [blender-loader/](blender-loader/) | Loading a `.margo` file exported from Blender |
| [usdz-loader/](usdz-loader/) | Loading USDZ and USDA files |
| [webxr-orbit/](webxr-orbit/) | A WebXR session around a simple scene |
| [xr-device-check/](xr-device-check/) | Runs WebXR on a real headset or phone and saves the record [docs/xr-device-runs](../docs/xr-device-runs/README.md) keeps |

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
