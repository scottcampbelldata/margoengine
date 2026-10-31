# Start here

You will find the page that matches what you want to do. Every guide is short, has code you can copy, and has been run
in a real browser.

New to Margo? Do the [quickstart](../README.md#quickstart) first. It takes about five minutes and ends with a textured,
lit scene with shadows, orbit controls and click-to-select.

## I want to...

| I want to... | Read |
| --- | --- |
| Put an image on a surface, or make a surface shiny, rough or bumpy | [Textures and materials](guides/textures-and-materials.md) |
| Light a scene, add a lamp, or turn on shadows | [Lights and shadows](guides/lights-and-shadows.md) |
| Let people orbit, pan and zoom, or use Blender or SolidWorks mouse controls | [Camera and controls](guides/camera-and-controls.md) |
| Click, hover, outline, drag-select or drag meshes | [Interaction](guides/interaction.md) |
| Show a `.glb` or `.gltf` model | [Loading glTF](guides/loading-gltf.md) |
| Play a character's animation clips | [Animation](guides/animation.md) |
| Walk through a building in first person | [Walkthrough](guides/walkthrough.md) |
| Show an STL or OBJ file | [Imports](guides/imports.md) and the [loaders README](../packages/loaders/README.md) |
| Make the scene look better (bloom, SSAO, tone mapping) | [post](../packages/post/README.md), [tonemap](../packages/tonemap/README.md) |
| Add physics | [physics](../packages/physics/README.md) |
| Draw text or game menus | [text](../packages/text/README.md), [ui](../packages/ui/README.md) |
| Draw terrain, water or sky | [terrain](../packages/terrain/README.md), [water](../packages/water/README.md), [sky](../packages/sky/README.md) |
| Build with voxels | [voxel](../packages/voxel/README.md) |
| Plot data or volumes | [sciviz](../packages/sciviz/README.md), [compute](../packages/compute/README.md) |
| Save a scene as glTF, STL or USDZ | [exporters](../packages/exporters/README.md) |
| Use React | [React package README](../packages/react/README.md), [cookbook](react-cookbook.md) and [integration](react-integration.md) |
| Build your first React scene (texture, shadows, click) | [React: your first scene](guides/react-first-scene.md) |
| Build an editor with save, load and undo in React | [React: build the scene from a document](guides/react-scene-document.md) |
| Decide what goes in React state and what in the frame loop | [React: state or the frame loop?](guides/react-state-vs-frame-loop.md) |
| Fix a first guess about frame callbacks, `marchingCubes`, ray input or `PostStack` | [Four calls people guess wrong](guides/first-guesses.md) |
| See what the engine draws; keep the inspector from covering your buttons | [Debugging with the inspector](guides/debugging.md) |
| Move a three.js project over | [Coming from three.js](from-threejs.md) |
| Ship a smaller or faster app | [Quality tiers](guides/quality-tiers.md), [limits](limits.md), [deploying](deploying.md) |
| Find a package | [Package list](../README.md#packages) and the [catalog](README.md) |
| Understand how it is built | [Architecture](../MODERN-ENGINE.md), [API overview](api-overview.md) |
| Contribute | [CONTRIBUTING.md](../CONTRIBUTING.md) |

Pages for post-processing, physics, text, terrain and plots are package READMEs today. Task guides for them are still
to be written.

## Four facts to know first

- **WebGPU.** The engine draws with WebGPU. Chrome and Edge on desktop are the tested browsers. The optional WebGL2
  fallback draws plain meshes only. See [Browser support](../README.md#browser-support).
- **Small core, optional packages.** The core and the stage together are 22,522 bytes gzip (not your whole app: React, models and optional packages add to it; see [limits](limits.md)). Shadows, glTF, physics and the
  rest are packages you import when you need them: `import { Shadows } from 'margoengine/shadows'`.
- **Not on npm yet.** 1.0.0 is the first planned release. Run examples from a clone until then.
- **Units are metres, Y is up.** The same as glTF.

## When not to use Margo

- You need to support browsers without WebGPU. The fallback is a preview of plain meshes.
- You need a large ecosystem of third-party plug-ins, tutorials and answers. Margo is new and has few.
- You need features the [limits](limits.md) page lists as missing.

## Next

- Stuck? Errors carry a code and a help link; the codes are listed on [margoengine.com/errors](https://margoengine.com/errors.html).
- Found a bug in a guide? Open an issue; every code block here is meant to run as written.
