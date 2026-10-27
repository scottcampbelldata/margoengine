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

All pages need a browser with WebGPU. A page shows a short notice when WebGPU is missing.

| Page | What it shows |
| --- | --- |
| [animation-formats.html](animation-formats.html) | Collada skins and glTF animation pointers |
| [batched-mesh.html](batched-mesh.html) | Many shapes drawn in one call |
| [cad-views.html](cad-views.html) | Top, front, right and perspective views of one model |
| [character-animation.html](character-animation.html) | A walking robot with blendable expressions |
| [clipping-planes.html](clipping-planes.html) | Section planes on every material |
| [depth-texture.html](depth-texture.html) | A depth texture that any material can sample |
| [flight-helmet.html](flight-helmet.html) | The Khronos Flight Helmet with PBR materials |
| [khronos-gallery.html](khronos-gallery.html) | Khronos glTF sample assets |
| [kinematics-constraints.html](kinematics-constraints.html) | Arm clearance check with the kinematics package |
| [minimap.html](minimap.html) | A second camera view as a minimap |
| [robot-expressive.html](robot-expressive.html) | The same character study as a standalone page |
| [scene-targets.html](scene-targets.html) | Several render targets with named outputs |
| [skinning-ik.html](skinning-ik.html) | Skinning and IK in a small animated scene ([details](skinning-ik/README.md)) |
| [split-screen.html](split-screen.html) | Two players, two views, render layers |
| [texture-formats.html](texture-formats.html) | TGA, TIFF, KTX and DDS textures |
| [tokyo-diorama.html](tokyo-diorama.html) | A street corner animated in Blender and played back by the animation package |
| [weather.html](weather.html) | Weather presets that blend: rain, snow, hail, lightning, wind and wet or snowy ground |
| [windy-meadow.html](windy-meadow.html) | Grass, wind and a changing sky |

The same server also serves the loader examples:

| Page | What it shows |
| --- | --- |
| [blender-loader/](blender-loader/) | Loading a `.margo` file exported from Blender |
| [usdz-loader/](usdz-loader/) | Loading USDZ and USDA files |
| [webxr-orbit/](webxr-orbit/) | A WebXR session around a simple scene |

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
