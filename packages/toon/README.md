# @margoengine/toon

Stepped diffuse shading and inverted-hull outlines.

Import `margoengine/toon` from the `margoengine` package, or `@margoengine/toon` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Stepped diffuse ramps reuse creative/ToonShading. A second front-culled pass expands vertex normals into an inverted hull for silhouette outlines.

```ts
import {Toon} from 'margoengine/toon';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const toon = Toon.attach(engine, {bands: 4, rim: 0.15, outline: 0.025});
```

Outline thickness is world units. color is linear RGB in 0..1. The hull replays visible core geometry with the existing reversed-Z depth buffer. Geometry should have coherent smooth normals for a continuous silhouette; hard-normal seams can separate hull corners. `Toon` is a core-mesh pipeline; outline loaded and animated models with `ModelOutlines` (below). dispose removes both passes.

## Outlines on loaded and skinned models

`@margoengine/toon/models` draws the same inverted hull around loaded glTF PBR models and `@margoengine/materials` meshes: skinned and morphed characters keep their outline in every pose (the hull is drawn from the vertices their deformer wrote this frame), and instanced primitives get one hull per instance.

```ts
import {ModelOutlines} from 'margoengine/toon/models';
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Animation} from 'margoengine/animation';
const engine = await Engine.create(document.querySelector('canvas')!);
const character = await loadGLTF(engine, '/hero.glb');
Animation.attach(character).play(0);
const outlines = ModelOutlines.attach(engine, {outline: 0.02, color: [0.02, 0.01, 0.01]});
outlines.outline = 0.03; // live, as are the other options
outlines.materials = {Hair: {outline: 0.05, color: [0.2, 0.05, 0]}, Eyes: {outline: 0}}; // per material, 0: no line
outlines.vertexColors = true; // painted COLOR_0 tints the line and its alpha scales the width
outlines.nodes = [character.nodes[0]]; // only that node's primitives and its children's (undefined: all)
```

Options: `outline`, thickness in world units 0 to 10 (default 0.025, 0 hides it); `color`, linear RGB 0 to 1 (default `[0.015, 0.015, 0.015]`); `smooth`, seam-free outlines (default true, live); `materials`, width and colour by glTF material name over those two (default none, live); `vertexColors`, the line's colour times the vertex colour (COLOR_0) RGB and its width times its alpha (default false, live); `models`, the models to outline (default every model on the engine); `nodes`, only the primitives under these nodes (a model's `root` or entries of `model.nodes`, each with its descendants; default every primitive, live), as drei's `Outlines` inside one `skinnedMesh`. Hidden nodes and nodes outside a view's layers get no outline; point and line primitives never do. With `smooth`, every copy of a vertex at one position (split by a hard edge or a UV seam) pushes out along the average of their normals, read each frame from the vertices drawn, so hard-edged meshes get an unbroken outline, posed ones too; it is thinner at sharp corners (a cube's corner moves the width over the square root of 3 each way). `positionRings(vertices)` returns the links it bakes, each vertex's next copy at the same position. Positions must match bit for bit; at most 64 copies a position are averaged; a vertex buffer without STORAGE usage draws as `smooth: false`. With `smooth: false` the line follows each vertex's own normal and parts at creases. WebGPU only; `dispose()` removes the pass. For a screen-space line of fixed pixel width, use `@margoengine/post` `Outline`.

## One mesh's outline

`@margoengine/toon/outline` outlines a single core mesh (drei's `Outlines`; React: `@margoengine/react/outlines`): its triangles are drawn again with front faces culled and every vertex pushed out along a hull normal, after the opaque scene.

```ts
import {MeshOutline} from 'margoengine/toon/outline';
import {Engine, box} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const mesh = engine.createMesh().setGeometry(box(1, 1, 1));
const outline = MeshOutline.attach(engine, {mesh, thickness: 3, screenspace: true, color: [0.02, 0.05, 0.3]});
outline.angle = 0; // live: let the hull part at every crease
outline.transparent = true;
outline.opacity = 0.5;
```

Options (every one but `renderOrder` live as a property): `mesh` (required); `geometry`, the triangles when another package draws the mesh (default the mesh's own); `color`, linear RGB 0 or more (default black); `opacity` 0..1, blended only when `transparent` (default 1, false; a transparent line leaves depth unwritten); `thickness`, world units or, with `screenspace`, drawing-buffer pixels, 0..1024 (default 0.05, false); `toneMapped`, the colour goes through Khronos PBR Neutral like a lit surface, else it is clamped like unlit output, then sRGB encoded either way (default true); `polygonOffset` and `polygonOffsetFactor`, depth pushed back by the factor times the depth slope (default false, 0); `renderOrder` -1000..1000, draw order among outlines (default 0); `angle`, the crease angle 0..pi: copies of a vertex at one position whose normals lie within it of each other push out along their averaged normal (default pi, a closed hull; 0 keeps each face's normal, so the line parts at creases). A mirrored matrix culls back faces instead. `creasedNormals(vertices, angle)` and `outlineColor(color, toneMapped)` return what is uploaded. WebGPU or the WebGL2 compatibility layer; `dispose()` removes the pass. Sources: Raskar and Cohen, "Image Precision Silhouette Edges" (I3D 1999); Gooch, Sloan, Gooch, Shirley and Riesenfeld, "Interactive Technical Illustration" (I3D 1999); Thurmer and Wuthrich, "Computing Vertex Normals from Polygonal Facets" (JGT 1998); not re-read for this entry.

## Hatching and halftone

Hatching composes with `Shadows` and `Clustered`. The ink is applied after both have contributed to the lit paper
colour. This follows the separation of tone and ink coverage described by [Winkenbach and Salesin,
*Computer-Generated Pen-and-Ink Illustration* (1994)](https://grail.cs.washington.edu/projects/cg-illus/) and
[Praun, Hoppe, Webb and Finkelstein, *Real-Time Hatching* (2001)](https://gfx.cs.princeton.edu/pubs/Praun_2001_RH/).

`@margoengine/toon/hatch` draws pen hatching or print dots in place of flat bands on core meshes: the surface takes its full lit colour (the paper) and the diffuse light level decides how much of each pixel is ink, in a pattern fixed to the screen.

```ts
import {Hatching} from 'margoengine/toon/hatch';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const hatching = Hatching.attach(engine, {style: 'hatch', spacing: 8, layers: 3});
hatching.style = 'halftone'; // live, as are the other options; hatching.set({...}) changes several at once
```

Options (each live): `style`, `'hatch'` (default) or `'halftone'`; `spacing`, line or dot spacing in screen pixels, 2 to 64 (default 8); `width`, stroke width in pixels for `'hatch'`, 0.5 up to `spacing` (default 1.5); `layers`, stroke layers for `'hatch'`, 1 to 4 (default 3), layer k drawn where the light is below (layers - k) / (layers + 1), each turned 180 / layers degrees from the last; `angle`, the first strokes' or the dot grid's angle in degrees (default 45); `ink`, linear RGB 0 to 1 drawn unlit (default black). Halftone dots cover 1 - light of each cell. With `Toon` attached too, hatching replaces its bands and keeps its rim and outlines. Core meshes only; it uses group 0 binding 146. WebGPU only.

For toon shading per material, on materials meshes (plain, instanced, skinned) and loaded glTF PBR models (skinned and morphed too), use `@margoengine/materials`: `new ToonMaterial({gradientMap})` or `{steps: 3}`, and `toonModel(model)` for a loaded model or some of its primitives. Both band the sun, clustered lights and their shadows through the ramp.

```ts
import {ToonMaterial, createMesh, toonModel} from 'margoengine/materials';
import {Engine} from 'margoengine/core';
import {sphereGeometry} from 'margoengine/geometry';
import {loadGLTF} from 'margoengine/gltf/pbr';
const engine = await Engine.create(document.querySelector('canvas')!);
const geometry = sphereGeometry(1, 32, 16), character = await loadGLTF(engine, '/hero.glb');
createMesh(engine, geometry, new ToonMaterial({color: '#e07040', steps: 3}));
toonModel(character, {steps: 4});
```

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/toon

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.
