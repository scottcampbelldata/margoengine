# @margoengine/environment

Import `margoengine/environment` from the `margoengine` package, or `@margoengine/environment` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

HDR, EXR and UltraHDR loading, EXR writing, GPU image-based lighting (prefiltered specular, spherical-harmonic irradiance, BRDF LUT) applied to meshes and glTF models, environment and color backgrounds, and scene-wide fog for Margo Engine on WebGPU.

Build from source with `npm run build` in `packages/environment`.

Decodes Radiance `.hdr` (RGBE), OpenEXR (single-part scanline EXR with NONE, RLE, ZIPS, ZIP or PIZ, tiled or mipmapped EXR through `/exr-tiled`, and PXR24, B44 and DWAA/DWAB through the asynchronous `/exr-codecs` worker, see Limits) and UltraHDR gain-map JPEG images, prefilters them into image-based lighting (`Environment`, `EnvironmentLighting`), and draws a background (the environment with `exposure`, `rotation` and `blur`, or a color) and fog (linear, exponential-squared and height fog), plus froxel volumetric fog with light shafts in the optional `/volumetric` entry.

The optional `/reflector`, `/refractor` and `/cube-camera` entries add a planar mirror, a planar see-through surface (glass, water) and a cube render target (see "Mirrors, glass and cube cameras"), and `/lightformer` an emissive studio card for cube captures (see "Lightformer"); `/main` is the root without the image decoders, for code that reads no image file (an app that never names a decoder gets that split from the root too; `@margoengine/react`'s lights, fog and cube camera use it); `/exr-write` writes EXR files (see "Writing EXR") and `/exr-tiled` reads tiled and mipmapped ones (see "Reading tiled and mipmapped EXR").

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Environment, EnvironmentBackground, EnvironmentLighting, loadEnvironmentImage} from 'margoengine/environment';

const canvas = document.createElement('canvas');
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const image = await loadEnvironmentImage('/studio.hdr'); // .hdr, .exr or UltraHDR .jpg, picked by signature
const environment = await Environment.attach(engine, image, {rotation: 0.5}); // rebuilds itself after a device loss
EnvironmentBackground.attach(engine, environment, {exposure: 1, blur: 0});
const lighting = EnvironmentLighting.attach(engine, environment);               // core meshes: IBL replaces the constant ambient term
lighting.add(await loadGLTF(engine, '/helmet.glb'));       // glTF PBR models: same, scaled by occlusion maps
engine.start();
// On teardown: engine.dispose() disposes every plugin; lighting.dispose() also detaches it from models.
```

`environment.dispose()` also removes its registration from the scene that owns it,
so another `await Environment.attach(engine, image)` can use the same name. It is
safe to dispose twice. Dispose dependent backgrounds and lighting before replacing
their environment; they retain the environment object originally passed to them.

A plain color (or vertical gradient) background and fog, without any environment map:

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {ColorBackground, Fog} from 'margoengine/environment';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
ColorBackground.attach(engine, {color: '#bcd4e6'});            // fills every pixel the scene left empty
const fog = Fog.attach(engine, {color: '#bcd4e6', near: 10, far: 80}); // fogs core meshes; {density: 0.02} for exponential-squared fog; heightFalloff for height fog
fog.add(await loadGLTF(engine, '/helmet.glb'));                // glTF PBR models, opaque and blended
fog.far = 120;                                                 // every option is a live property
```

A skybox from ordinary PNG/JPG images (box, sphere or cylinder), crisp for pixel art:

```ts
import {EngineKernel} from 'margoengine/core';
import {ImageBackground} from 'margoengine/environment';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const box = await ImageBackground.load({shape: 'box', images: ['px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png'], filter: 'nearest'});
engine.use(box);
// or one panorama: {shape: 'sphere', images: ['sky.jpg']} (equirect), {shape: 'cylinder', images: ['hills.png'], height: 1.5}
box.filter = 'linear';                                         // filter, rotation and height are live properties
```

## Scene lighting, fog and color backgrounds

- **`EnvironmentLighting(environment)`** is an engine plugin and a glTF PBR `LightingEffect`. As a plugin it runs a pass at order -1 (after shadows, sky, clustered lights and the post-processing captures) that patches core's mesh shader through `PassContext.shader`, adding `margoAmbient` (declared just before as `let margoAmbient=iblShade(...);`) to the `let linear=` term in place of the constant ambient `lighting.radiance[3]`; core itself is not changed. `add(model)` (or `model.addLighting(lighting)`; `applyTo(model)` is a deprecated alias) does the same for glTF PBR's shader through its declared `ambient` lighting hook (glTF PBR README, "Lighting hooks"), replacing its hemisphere `ambient()` and multiplying IBL by the occlusion map. The five IBL bindings are 20 to 24 in core's group 0 and glTF PBR's group 2. While the environment is restoring or disposed, or lives on another device, nothing is patched and nothing is bound. Sky's ambient patch is kept and IBL adds to it; terrain wetness does not scale IBL. glTF PBR's physical variant (clearcoat, sheen, transmission, specular) is patched the same way, but its IBL term uses the plain metallic-roughness F0 and its clearcoat and sheen layers keep their hemisphere ambient; unlit materials ignore IBL. **Ambient occlusion**: in core's shader, naming the IBL term `margoAmbient` is a shader convention, not an import (listed in `tests/shader-contracts.test.js`); glTF PBR gets it through its `ambient` hook: post's SSAO (core meshes and registered glTF PBR models) replays `margoAmbient` as the light it occludes, so SSAO darkens IBL diffuse and specular in creases instead of the constant ambient term. Without SSAO the lit output is unchanged; specular occlusion uses the same AO factor as diffuse (an approximation, see post's README).
- **`HemisphereLight({sky, ground, intensity})`** and **`AmbientLight({color, intensity})`**: ambient light of `sky` colour from above and `ground` colour from below, blended by `0.5 + 0.5 n.y` and times `intensity`; an AmbientLight is one colour from everywhere. A surface of albedo `a` facing up reflects `a x sky x intensity` (diffuse; gltf/pbr's shaders add their usual `f0 x 0.5` specular share). `engine.use(light)` (or `HemisphereLight.attach(engine, options)`) lights core meshes and terrain and owns the uniform (binding 144); `light.add(model)` adds gltf/pbr models, materials meshes and VAT crowds through gltf/pbr's `sky` lighting hook. It takes the place of the built-in ambient: core's `lighting.ambient x lighting.radiance[3]` (or sky's absolute ambient colour) and gltf/pbr's fixed sky gradient `mix((0.35, 0.3, 0.25), 1, 0.5 + 0.5 n.y) x radiance[3]`, wherever a shader uses it (hemisphere ambient, Lambert/Phong and lobe materials, clearcoat and sheen defaults, VAT crowds). With `EnvironmentLighting`, an environment behind `LightProbes`, or sky ambient, it adds to their light, in either attach order; with `LightProbes` without an environment it is their fallback outside the probe volumes. Under IBL, a physical material's clearcoat and sheen take IBL's light alone. Colours and intensity are live (a uniform write, no recompile); one hemisphere per engine (a second throws). SSAO occludes it on core meshes. Without one, every shader and GPU call is what it was (`environment-hemisphere` proof). Real-GPU check: `examples/package-benchmarks/light-features-gpu.mjs`.
- **`SHLight({coefficients, intensity})`**: a light probe given as nine RGB L2 spherical-harmonic coefficients of the incoming radiance: the diffuse ambient light of a whole environment in 27 numbers, the same at every point. `coefficients` is nine `[r, g, b]` triples or 27 numbers (`k x 3 + channel`), linear, in the order (0,0), y, z, x, xy, yz, 3z^2-1, xz, x^2-y^2 (the standard real SH order and `projectEquirectSH`'s output, so coefficients from other tools carry over unchanged); default all zero. The shader evaluates the Lambert-convolved irradiance over pi (Ramamoorthi and Hanrahan 2001, "An Efficient Representation for Irradiance Environment Maps", SIGGRAPH; band factors 1, 2/3, 1/4), clamped at zero, so a constant radiance `L` lights every surface like `AmbientLight` of colour `L`; `light.irradiance(normal)` returns the same value on the CPU. It takes the same ambient slot as `HemisphereLight` (binding 144, `engine.use` or `SHLight.attach`, `add(model)`, adds to IBL, the fallback of `LightProbes` without an environment, occluded by SSAO); one ambient light per engine, hemisphere, ambient or SH (a second throws). `coefficients` and `intensity` (default 1) are live. Real-GPU check: `light-features-gpu.mjs` check 7.

```ts
import {Engine} from 'margoengine/core';
import {SHLight, projectEquirectSH, loadEnvironmentImage} from 'margoengine/environment';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
// Nine coefficients from anywhere (any tool's L2 SH in the standard order carries over as it is)...
const probe = SHLight.attach(engine, {
  coefficients: [
    [0.6, 0.65, 0.8], [0.1, 0.15, 0.3], [0.2, 0.2, 0.18],
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0.05, 0.05, 0.08], [0, 0, 0], [0, 0, 0],
  ],
});
// ...or projected from an environment image on the CPU, swapped live.
probe.coefficients = projectEquirectSH(await loadEnvironmentImage('/studio.hdr'));
probe.intensity = 0.8;
engine.start();
```
- **`Fog(options)`** computes `amount = linear (near, far)` or `1 - exp(-(density * d)^2)` from the camera distance, times `exp(-heightFalloff * max(y - height, 0))`, inside the mesh shaders (binding 25), so blended glTF primitives are fogged too (glTF PBR's `output` hook), unlike sky's depth-based post fog. On the canvas it mixes after tone mapping, so a fully fogged pixel shows exactly `color` and matches a `ColorBackground` of the same color; on an rgba16float target (tonemap, ssao, dof, creative PostProcessing) it mixes linear radiance before their tone mapping. Height fog is the per-fragment factor, not an integral along the view ray. The background, particles, VFX, splats and other custom shaders are not fogged. `fog.enabled = false` switches it off by uploading zero-fog parameters (near and far at the float maximum, density 0); the patched shaders and pipelines stay, so switching either way never compiles a shader, and off renders the same pixels as no fog (checked on the real GPU). Adding or removing the plugin instead changes the shaders.
- **`ColorBackground({color, bottom})`** draws a full-screen triangle at order 0.5 (after core's opaque meshes, before glTF PBR models so blended primitives composite over it) at reversed-Z depth 0 with a read-only `greater-equal` test, so it only fills pixels whose depth was never written. On the canvas it writes the sRGB bytes exactly (no tone mapping); on an rgba16float target it writes the linear value. `bottom` makes a vertical screen-space gradient. Colors are `'#rgb'`, `'#rrggbb'`, `0xrrggbb` (sRGB) or linear `[r, g, b]`, as everywhere in Margo (docs/conventions.md); `color` and `bottom` read back linear `[r, g, b]`. `Fog` takes the same colors. (Before 2026-10-19 arrays here were sRGB components: an array written for that, such as `[0.5, 0.5, 0.5]`, now means a lighter grey; pass `'#808080'` for the old look.)
- **`ImageBackground({shape, images, filter, height, rotation})`** is a skybox from 8-bit sRGB images: `'box'` takes six square faces of one size in WebGPU cube order +X, -X, +Y, -Y, +Z, -Z (row 0 at the top, as `CubeFaces`), `'sphere'` one equirectangular panorama (centre column facing -Z, row 0 straight up, as the HDR equirect) and `'cylinder'` one panorama wrapped once around a vertical unit-radius cylinder. Cylinder mapping: the horizontal angle gives u over the full 360 degrees (as the sphere); v = 0.5 - y / (height * r) for a view direction with vertical part y and horizontal length r, so v is linear in height on the cylinder and the image covers `height` of it centred on the horizon (default 2 * PI * imageHeight / imageWidth: square texels); above and below it the top and bottom rows repeat. `images` are decoded pixels (`ImageData` or `{width, height, data}`); `ImageBackground.load(options)` also takes URLs, blobs, image elements, bitmaps and canvases (createImageBitmap, then a 2D OffscreenCanvas). The pixels stay on the CPU and are uploaded as `rgba8unorm-srgb`, so the GPU decodes sRGB to linear before filtering, and again after a device restore. `filter: 'nearest'` keeps pixel-art skies crisp (default `'linear'`); `filter`, `height` and `rotation` (about +Y) are live properties, and changing the filter makes one sampler and bind group. Drawn like `ColorBackground` (order 0.5, name `'background'`, only on cleared depth): on the canvas the exact sRGB pixels (no tone mapping), on an rgba16float target the linear values. Background only: it lights nothing (use `Environment` for image-based lighting). No mipmaps: an image much larger than the screen shows aliasing when minified.
- **`TransparentCanvas.attach(engine)`** makes the canvas transparent (cleared to alpha 0) without a core change: it reconfigures core's canvas context with `alphaMode: 'premultiplied'` (same device and preferred format) and runs the `ColorBackground` pass writing premultiplied alpha 0, so the page shows wherever nothing is drawn and multisampled silhouettes resolve to valid premultiplied edges. It reapplies itself after `engine.rebootDevice()` (core reconfigures the context opaque, then calls `onDeviceRestored`), and `dispose()` (or `using`) restores the opaque canvas and detaches. Attach no other background with it (`ColorBackground`, `EnvironmentBackground`, `Sky` would fill the pixels again). On the WebGL2 fallback it does nothing; create that renderer transparent: `fallback: canvas => webglRenderer(canvas, {transparent: true})`. Which post effects keep alpha: `@margoengine/post` README (Tonemap reads the mark this plugin sets on the canvas and grades straight colour). Real-GPU check: `examples/package-benchmarks/transparent-canvas-gpu.mjs`.
- **`ColorOutput.attach(engine, {gamut, hdr, peak, force})`**: Display P3 and HDR canvas output (WebGPU `colorSpace` and `toneMapping`), zero core bytes. See "Display P3 and HDR output" below.
- `dispose()` on `ColorBackground`, `ImageBackground` or `EnvironmentBackground` also detaches it from the engine, so a replacement can attach under the same name.
- All three are built to allocate nothing in steady frames (the browser test measures this for the backgrounds), patch each distinct shader string once (cached), rebuild their GPU state in `onDeviceRestored`, and throw on a shader they do not recognize instead of drawing wrong.

## Volumetric fog and light shafts

`@margoengine/environment/volumetric` is a separate entry (11.3 kB min+gzip on its own; nothing is loaded, compiled or run unless you import and attach it; the root entry is byte-identical without it):

```ts
import {Engine} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
import {Clustered} from 'margoengine/clustered';
import {LocalShadows} from 'margoengine/clustered/shadows';
import {Tonemap} from 'margoengine/tonemap';
import {VolumetricFog} from 'margoengine/environment/volumetric';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);                                  // any post capture gives the fog its scene depth
const shadows = Shadows.attach(engine, {distance: 80});  // sun shadows: light shafts through gaps
const lights = Clustered.attach(engine);                 // point and spot lights scatter in the fog
LocalShadows.attach(engine, {lights});                   // ...and their shadows carve it
const fog = VolumetricFog.attach(engine, {density: 0.03, heightFalloff: 0.15, anisotropy: 0.6, shadows, lights});
fog.options.density = 0.05;                              // options are read every frame
```

How it works. A camera-frustum grid of froxels (default 160 × 90 × 64, slices spaced quadratically over `range` metres beyond the near plane, so finer near the camera) is filled by one compute pass: density (uniform, `heightFalloff` above `height`, optional `noise` drifting with `wind`), then the light scattered toward the camera with a Henyey-Greenstein phase (`anisotropy`): the engine's directional light, shadowed through `Shadows`' cascades (four stratified comparison samples along each froxel's depth); `ambient` (default the engine's ambient term, grey); and, with `lights`, every clustered point and spot light in the froxel's cluster (the cluster lists clustered already built this frame) with the falloff and cone clustered lights surfaces with (each light's `decay`, `angle`/`penumbra` or outer/inner cone, and `range: 0` unlimited; while no light sets `decay` or `angle` the froxel shader is the original inverse-square one), times its `LocalShadows` term when one is attached. Hooks the lights carry for the lit shader alone (bounce, IES, projector, shapes, layers) keep their bindings in the froxel pass's layout, read in a branch that never runs, so a scene with `LightBounce` or IES profiles keeps its fog (KB-FOG-HOOK-BINDINGS1) Each froxel's sample is jittered within its cell every frame (Halton 2, 3, 5 over 16 frames) and blended with the previous frame's value reprojected at the froxel's centre (`temporal`, default 0.9 history; a still camera reads its own texel unfiltered, so nothing drifts), which removes the stair-stepping of a coarse grid. A second compute step integrates every froxel column front to back (energy-conserving per slice, through a 3 x 3 tent filter across columns) into a 3D texture of in-scattered light and optical depth. On the WebGL2 compatibility layer, which runs compute on the GPU only when each invocation writes its own texel, every froxel integrates its own column from the front instead: the same steps in the same order, (slices + 1) / 2 times as many on the GPU, nothing on the CPU (before, the column ran as JavaScript, about 1 s a frame at the default grid). The composite then reads the scene depth per pixel (per sample at 4x MSAA), looks the volume up at that distance and blends premultiplied `light + scene × transmittance` over opaque surfaces and the sky; past `range` it adds the far air in closed form ("Far air" below). Perspective and orthographic cameras both work: distances are measured from the camera's near plane along its view axis, read from `camera.matrix`.

It renders in its own passes at order 5 (after opaque meshes, glTF PBR models, the sky and water; before VFX and post effects) and never patches a lit shader, so it adds no texture or sampler to the 16 per stage (gltf/pbr README, "Texture bindings"); its compute pass binds 3 sampled textures at most (history, sun cascades, local shadow maps). Scene depth comes from the post capture that owns the scene target (Tonemap, Bloom, PostStack, SSAO, TAA, DOF), at 1x or 4x; without one, pass `depth: () => texture` (for example water's `depthTexture`), otherwise the first frame throws saying so. On an `rgba16float` capture it composites linear radiance; on a display target it tone maps the fog colour like sky fog. Output is premultiplied, so with `TransparentCanvas` the fog in front of empty pixels becomes a translucent layer (alpha = fog opacity) instead of an invalid colour. `fog.texture` exposes the integrated volume (rgba16float, rgb light and a optical depth at each slice's far edge) for custom shaders, such as fogging particles.

**Narrow beams and bulbs in the fog.** Each froxel integrates every clustered light over its slice's whole depth instead of sampling it at points, so a spot cone much thinner than a froxel (a lighthouse beam, a searchlight) stays one continuous shaft, in depth and across the screen. The slice is split in four parts, each with its own cluster lookup. In each part the stretch of the froxel's ray inside the light's range sphere and outer cone is found exactly (a quadratic each; Eberly 2000), the inverse-square part of the scattering over that stretch is the closed form (atan(b) - atan(a)) / h, h being the ray's closest approach to the light (Sun, Ramamoorthi, Narasimhan and Nayar 2005; Pegoraro and Parker 2009), and the smooth rest (cone edge, range window, phase, extinction, shadow) is taken at 2 points spaced equally in that angle and jittered each frame (equiangular sampling, Kulla and Fajardo 2012). A cone thinner than the froxel is widened by the froxel's size seen from the light with its peak lowered to keep the same energy, so a beam between two froxel rows lights both by their share instead of only the row its centre ray hits (footprint prefiltering after Toksvig 2005 and Kaplanyan, Hill, Patney and Lefohn 2016). Before 2026-11-15 the fog took each light at four points per slice on each froxel's centre ray, and the Storm Light beam drew as a row of separate blocks (KB-FOG-BEAM1). A light's closest approach is held to the cell it stands for: it never drops below R / sqrt(3), R being half the larger of the froxel's width and height, the distance whose inverse square is the mean of 1/d^2 over a ball of radius R, so a froxel holding a bulb or a lens scatters what its cell does instead of drawing a bright square around the light. The light also crosses the fog on its way: it is dimmed by exp(-extinction x distance), the extinction at the froxel (the fog's and its `FogVolumes`') taken along the whole path, exact in uniform fog (before 2026-11-13 it arrived undimmed, so a beam lit thick fog hundreds of metres out as brightly as at the lens). Real-GPU checks on an RTX A6000, WebGPU and the WebGL2 layer alike: `npm run test:fog-beam:browser` compares every froxel column with the true scattering averaged over the froxel's area, the light dimmed along its path, for a 3 degree beam crossing the view toward the camera (per-column L1 error 0.044, limit 0.05) and for a bulb beside a froxel sample (0.004); `npm run test:fog-beam-continuity:browser` sends a 0.7 degree beam, 0.2 m across, through froxels 0.4 m wide and 1.3 m tall in a portrait view: each of the 16 columns it crosses holds 0.762 to 1.186 of its true light (L1 0.140), where the old sampling held 0 to 0.511.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {Tonemap} from 'margoengine/tonemap';
import {VolumetricFog} from 'margoengine/environment/volumetric';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);
const lights = Clustered.attach(engine);
// A lighthouse beam: a 1.5 degree cone 600 m long, far thinner than a froxel 100 m out.
lights.setLights([{position: [0, 30, 0], direction: [1, -0.02, 0], outerAngle: 0.026, innerAngle: 0.012, range: 600, intensity: 1.5e6}]);
VolumetricFog.attach(engine, {density: 0.02, lights});
```

**Area lights in the fog.** `AreaLights` (`margoengine/clustered/area`) on the same `lights` scatter in the fog too: each rectangle's radiance times its solid angle from the froxel (two triangles, Van Oosterom and Strackee, IEEE Trans. Biomed. Eng. 30(2), 1983), the phase toward its centre and the extinction on the way; a one-sided light lights only the space in front of it. Unshadowed in the fog. Until 2026-11-16 an attached `AreaLights` lost every frame with the fog on (its binding fell out of the fog's layout, KB-CABIN-WINDOWGLOW1).

**Turning it down while running.** `fog.options.enabled = false` skips the pass from the next frame and keeps the grid; true draws again with a fresh history. `fog.options.grid` reallocates on the next frame. `featureKnobs` from `margoengine/quality/features` does both by measured cost.

**With the other fogs.** VolumetricFog replaces environment `Fog` and sky's `fog` option rather than adding to them: both already darken distant surfaces toward a colour, so running two would fog the scene twice. It throws, naming the other one, while a `Fog` is enabled, sky fog has a density or creative `PostProcessing` has an `atmosphere.density`; a `Fog` with `enabled = false` can stay attached (for a quality switch between the two). Keep the sky itself: its background is fogged like any far surface, and the fog takes its light from it ("Far air" below). It also takes the place of creative's screen-space `atmosphere.godRays` where shafts must follow real occluders.

**Far air: visibility, the fog past `range` and the sky's light.** With no options the fog is clear air: 23 km visibility at ground level, thinning upward with the 1.2 km scale height of the air's haze, so distant hills and the sea fade with distance while the sky overhead stays clear. Set the air by `visibility` in metres, the distance at which a black object shows 2% contrast against the horizon (Koschmieder): the extinction is 3.912 / visibility per metre (haze 5,000, mist 1,000, fog 200 and less). `density` still sets the extinction directly (then the fog is uniform unless `heightFalloff` says otherwise); give one or the other. The froxel grid covers the near air out to `range`, with shafts, local lights, noise and `volumes`; past it every opaque pixel, sky and water included, gets the same medium in closed form along its ray to the surface or out to the sky: the optical depth of the height fog is the exponential integral of Wenzel (2006) and Quilez (2010), split at `height` for the flat layer under it. So a sea 3 km out fades by exp(-3.912 x 3,000 / visibility), and the horizon is as fogged as the far sea under it. The fog's light comes from the sky: with a `Sky` in the scene (found by its name, or passed as `sky`) and no `ambient`, the ambient light the fog scatters, near and far, is the horizon sky in each view direction, read from the sky's 64 x 32 environment map, as aerial perspective takes the far air's light from the sky at the horizon (Hillaire 2020; Bruneton and Neyret 2008). A fully fogged far sea then shows the horizon sky above it, and sea meets sky with no step. Water needs no fog of its own: the fog composites over the water's depth, which a `Water` drawn in the frame hands it through the capture (no `depth` option; before 2026-11-16 a sea without `depth` read the capture's depth, which holds no water, and drew fully fogged as sky, KB-FOG-WATERDEPTH1). With several `Water` surfaces in one view the fog reads the last one drawn (docs/limits.md). `Water.setFog` stays as an override for a fog without VolumetricFog. Until 2026-11-16 the default was 0.02 per metre (196 m visibility, uniform) and the fog stopped at `range`; pass `density: 0.02` for the old fog.

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {Sky} from 'margoengine/sky';
import {Water} from 'margoengine/water';
import {VolumetricFog} from 'margoengine/environment/volumetric';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);
Sky.attach(engine, {hours: 18.5});
Water.attach(engine, {horizon: true});
// Rain haze: a black boat 2 km out shows 2% contrast; the sea fades into the sky's own horizon colour.
const fog = VolumetricFog.attach(engine, {visibility: 2000, range: 400});
fog.options.visibility = 8000;                          // the rain eases: read every frame
```

Real-GPU check, WebGPU and the WebGL2 layer: `npm run test:fog-far:browser` fogs a flat sea seen from 300 m with `range` 600 and measures each pixel's transmittance from linear HDR light against the optical depth integrated on the CPU along its ray: every sea and sky pixel within 0.01, uniform fog at 1 km and 10 km visibility and height fog with the camera above and inside the dense layer; the sea at 1 km in 1 km visibility shows 2% (+-0.5%) contrast; the sea 3 km out in 10 km visibility fades to exp(-3.912 x 0.3); the luma step where the view depth crosses `range` is under 1 code beyond its neighbours'; with a Sky, a fully fogged far sea equals the fogged sky just above it within 1%, so there is no step at the horizon, and equals the unfogged sky 2.8 degrees up, the sky map row the fog's light is, within 2% (measured 0.92%); its gap to the unfogged horizon sky (10.8% at dusk) is the sky's own brightening from 2.8 down to 0.5 degrees (9.9 to 10.5% in the same frame); and a sea fogged with no `depth` option matches the integral as with it (KB-FOG-WATERDEPTH1).

**Multiple scattering.** Light in fog scatters more than once: in thick fog much of what reaches the eye has bounced several times, so the fog glows and brightens, also looking away from the sun. `multipleScattering` is the distance in metres over which light already scattered can scatter again before it leaves the fog, about the size of the fog bank (default 0: single scattering only, every shader and uniform byte as before). Each froxel adds the light of every order from two up as a geometric series with an isotropic phase (Hillaire 2020, section 5.5): with `f = color * (1 - exp(-density * multipleScattering))`, capped at 0.95, the ambient and the shadowed sun's isotropic share are scattered `f / (1 - f)` times more. Fog of albedo 1 and 0.08 per metre with `multipleScattering: 25` has `f = 0.86` and glows 7.4 times brighter in its isotropic part; thin fog (small `density * multipleScattering`) barely changes.

It is an estimate per froxel, not a light transport solve: the extra light follows the froxel's own sun shadow (no glow spreading into a shadowed street from the lit fog beside it), clustered lights add no multiple scattering, local fog volumes take the main fog's `f`, and the 0.95 cap holds white fog of unbounded depth to 20 times its isotropic single scattering. Real-GPU check (Apple M6, Metal): `npm run test:fog-transparent:browser` compares every froxel of the integrated volume with the closed form `color (ambient + sun / 4 pi) / (1 - f) (1 - exp(-depth))`. Thick fog (`multipleScattering: 25`) matched it within 1.1e-3 and came out 7.39, 3.24 and 2.08 times brighter per channel for colour `[1, 0.8, 0.6]`.

**Lightning.** `lightning: {light}` takes a lightning flash's point light, read every frame (`weather.lightningLight` from `@margoengine/sky/weather`; give it to `lights` too, which lights the fog straight from the channel). The cloud deck the flash lights sends light back down, which the fog scatters as ambient light: a Lambertian base of albedo `albedo` under illuminance `E` has radiance `albedo E / pi`, and the deck fills the upper half of the fog's directions, so the fog's ambient gains `albedo E / (2 pi)` in the light's colour, with `E = intensity / d^2` for the light `d` metres from the camera. `albedo` defaults to `CLOUD_ALBEDO`, 0.8, a thick storm cloud's (its albedo approaches 0.8 to 0.9 past an optical thickness of 50: S. Twomey, "The influence of pollution on the shortwave albedo of clouds", J. Atmos. Sci. 34, 1149-1152, 1977); 0 turns it off.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {VolumetricFog} from 'margoengine/environment/volumetric';
import {Weather} from 'margoengine/sky/weather';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const lights = Clustered.attach(engine);
const weather = Weather.attach(engine, {intensity: 0.9});
lights.setLights([weather.lightningLight]);
VolumetricFog.attach(engine, {density: 0.004, lights, lightning: {light: weather.lightningLight}});
```

Measured (Intel Arc 140V, Edge, AC power; `node examples/package-benchmarks/volumetric-gpu.mjs`, [volumetric-gpu.json](../../examples/package-benchmarks/results/volumetric-gpu.json)): light shafts through a 1.5 m slit with the sun behind the wall: the wall seen through the shaft is 9.6x brighter than the wall seen through shadowed fog (1.1x with the slit plugged; orthographic 15.6x vs 1.2x); a clustered spot light's cone in fog is 4.3x its surroundings (no difference without `lights`) and its `LocalShadows` darken the fog under a box caster to 0.48x; fog grows with density (luma 95, 152, 190 at 0.01, 0.03, 0.09) and with `heightFalloff: 0.4` the low wall is 2.5x as fogged as the high wall (equal without it); no NaN, Inf or negative value in the volume; at 4x and 1x MSAA alike. Still camera: mean frame-to-frame change 0.05 of 255 (p99 1 level); slow pan (0.05 degrees per frame): 0.19 against 0.05 without fog, no spike (max 0.24, p99 1). GPU time, quiet machine, sun shadows, default grid: the froxel compute pass 1.3-2.2 ms whatever the resolution (it scales with the grid: 80 x 45 x 32 0.3-0.5 ms, 240 x 135 x 96 3.4-3.9 ms); the composite 0.26 ms at 1280 x 720 and 0.4 ms at 1920 x 1080 at 1x, 1.1 and 2.3 ms at 4x (it runs per sample there). Whole frame: 720p 4x 5.3 -> 7.8 ms, 1080p 4x 11.6 -> 15.7 ms, 720p 1x 1.9 -> 5.0 ms, 1080p 1x 4.6 -> 6.9 ms; 8 clustered point lights in the fog add at most 0.3 ms to the compute pass. (Those timings are from the build before centre reprojection, which adds two matrix products per froxel; the final build's run in the JSON is labelled diagnostic: the machine was busy and its times run up to 50% higher.)

Limits: the 4x composite is per sample (about 4x the 1x cost; a per-pixel variant would be cheaper at the price of silhouette halos); one froxel grid resolution regardless of screen size, so sharp shadow edges in the fog are about one froxel wide (8 × 8 pixels at 1280 × 720 with the default grid) and softened by the temporal blend; fast-moving lights or occluders leave a short trail (lower `temporal`); transparent surfaces, particles, VFX and splats are fogged only when added with `fog.add` (next paragraph; otherwise blended glTF-pro primitives take the fog of what is behind them and later effects none), and an added one farther than `range` takes the same closed-form far air as the opaque pixels beside it; past `range` the fog has no shafts, noise, local lights or `volumes` (the far air is the smooth medium); the sun's shadow is a single comparison sample of the cascade, without PCSS; no local density fields beyond the boxes and spheres of `/fog-volumes` (next section); multiple scattering is a per-froxel estimate ("Multiple scattering" above), not a light transport solve. WebGPU only.

**Fogged transparents.** `fog.add(x)` fogs a transparent drawable that is not in the scene depth: a glTF PBR model's BLEND primitives (or a transparent `@margoengine/materials` mesh), or a `VFX`, `Splats` or `PointsPlugin`'s normally blended particles, splats and sprites. The fog takes over its transparent draw and runs it right after its own composite, in one pass over the fogged frame with the scene depth read only, and each fragment reads the integrated volume at its own depth, where the composite reads it at the scene's. With transmittance T and in-scattered light L between the camera and the fragment, a fragment of colour c and alpha a is drawn as straight alpha `a (c T + L) + (1 - a) dst`, which equals fogging the blended result exactly, since `dst` already holds L plus T times what is behind. It returns a remover; disposing the fog or the drawable removes it too:

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {VolumetricFog} from 'margoengine/environment/volumetric';
import {loadGLTF} from 'margoengine/gltf/pbr';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);
const fog = VolumetricFog.attach(engine, {density: 0.05});
const glass = await loadGLTF(engine, '/glass-panels.glb');
const remove = fog.add(glass);                           // its blended panels are fogged at their own depth
remove();                                                // back to its own sorted draw
```

Additive and multiply glTF PBR materials, native transmission and additive point sprites keep their own draw (a sum or a product cannot carry the fog's light through one straight-alpha blend). A frame the fog skips (`enabled = false`, no depth yet) still draws them, unfogged. Without `add` every fog shader and GPU call is what it was. Real-GPU check: `npm run test:fog-transparent:browser` (the hook's `margoTransparentAt`, bound to the fog's live volume, equals a CPU mirror at 192 froxel centres within 1.7e-7 (checked under 1e-3); a skipped frame passes colours through exactly; a drawable added in a real engine draws with no GPU error and leaves when removed).

## Local fog volumes

`FogGrid` connects the solved wet-air layer to `VolumetricFog`. It samples the current height and extinction of the
surrounding fog columns at each froxel. Its upload follows the source's revision, including after restoring a snapshot.

```ts
import { Engine } from '@margoengine/core';
import { FogGrid } from '@margoengine/environment/fog-volumes';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { DrainageFog } from '@margoengine/physics/drainage-fog';
import { PhysicsWorld } from '@margoengine/physics/world';
import { Bloom } from '@margoengine/post/bloom';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
engine.stop();
Bloom.attach(engine, { strength: 0 });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const fog = await DrainageFog.load();
world.add(fog, { width: 4, depth: 4, origin: [-15, -15], initialHumidity: 1, initialLiquid: 0.0003 });
const grid = new FogGrid(fog);
const pass = VolumetricFog.attach(engine, { volumes: grid, density: 0, range: 60 });
world.advance(60);
engine.render({ delta: 0 });
pass.options.volumes = undefined;
grid.dispose();
```


`@margoengine/environment/fog-volumes` adds boxes and spheres of fog with their own density, colour and 3D noise to `VolumetricFog`, for mist in a valley, smoke in a room or steam over a vent. They go into the same froxel grid, so they take the sun, its shafts and shadows, the ambient, clustered lights and the reprojection exactly as the fog does:

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {VolumetricFog} from 'margoengine/environment/volumetric';
import {FogVolumes} from 'margoengine/environment/fog-volumes';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine); // the scene depth the fog reads
const volumes = new FogVolumes([
  {shape: 'box', min: [-40, -5, -40], max: [40, 1.5, 40], density: 0.15, edge: 1, noise: 0.6, noiseScale: 6}, // valley mist
  {shape: 'sphere', center: [2, 1.2, -3], radius: 1.5, density: 0.8, color: [0.6, 0.6, 0.65], edge: 0.5},  // smoke
]);
const fog = VolumetricFog.attach(engine, {density: 0, volumes}); // density 0: local fog only
const smoke = volumes.volumes[1];
if (smoke.shape === 'sphere') smoke.center = [2, 1.5, -3];   // read every frame
```

How it works. Each froxel adds every volume's extinction at its sample point to the fog's own and the volume's albedo times that extinction to its scattering, so overlapping volumes and the global fog mix by their extinction. A volume's density is `density` inside, rising from 0 at the boundary over `edge` metres inside it (a smoothstep of the distance to the sphere's surface or to the box's nearest face), times the fog's two-octave value noise at `noiseScale` drifting with the fog's `wind` when `noise` is above 0. The volumes are one storage buffer (64 B each, at most 256) uploaded every frame in a bind group after `lights` and `shadows`; without `volumes` VolumetricFog's shaders are byte for byte as before. `FogVolumes` owns its buffer: `dispose()` (or `using`) frees it.

Limits: every froxel tests every volume, so the froxel pass grows with the volume count (not timed); boxes are axis-aligned; a volume thinner than a froxel (about 8 x 8 pixels across and a slice deep with the default grid) is blurred over its froxel and its neighbours (the 3 x 3 tent); a moved volume shows over `temporal`'s history like any change; no volume carves fog out of the global fog. Real-GPU check: `npm run test:fog-volumes:browser` (the integrated volume of a box, a sphere and a noisy box equals a CPU mirror of the froxel pass, every froxel; each volume's fog takes its albedo; a moved sphere moves its fog on the next frame).

The [BB-7 ray cutaway](../../docs/physics-demo-review.md) uses `FogVolumes` to draw the suspended sand that the swimmer lifts from `TerrainBed`. Run `npm run test:gpu:swim-sediment -w @margoengine/environment` for both renderers. The technical geometry follows the accepted body orientation and fin-tip displacement in metres. The fixed camera shows the sand lift, move with the bottom current and settle onto the changed bed. The shot holds the world before the trigger and after settling, and snapshot replay reproduces the ray, puff and bed frames exactly.

## Sparse density grids (VDB volumes, spray mist)

`@margoengine/environment/density-volume` is a heterogeneous medium on a sparse grid for `VolumetricFog`: smoke, steam or spray mist with detail anywhere in the world, written by a program, splatted from particles or read from an OpenVDB file. It goes into the fog's froxel grid as its `volumes`, so it is lit by the sun, its shafts and shadows, the ambient and clustered lights with the fog's phase function and reprojection:

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {VolumetricFog} from 'margoengine/environment/volumetric';
import {DensityVolume} from 'margoengine/environment/density-volume';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);
const mist = new DensityVolume({voxelSize: 0.25, density: 0.8, color: [0.95, 0.97, 1]});
mist.splat([0, 1, -4, 1.5, 1.4, -5], {radius: [0.8, 1.2], weight: [1, 0.6]}); // two Gaussian puffs
mist.set(4, 4, -16, 2);                                                       // one voxel by index
const fog = VolumetricFog.attach(engine, {density: 0, volumes: mist});
mist.clear(); mist.splat([0, 1.2, -4], {radius: 1});                          // shows on the next frame
```

A VDB grid read by `parseVDB` of `@margoengine/loaders/vdb` loads with `DensityVolume.fromVDB(file.grids[0], {density})`: its active leaves and tiles, placed by the grid's own matrix (inactive voxels read 0; vector grids and level sets are refused). For a flood's spray mist, `floodMist` of `@margoengine/water/flood-bake` gives Gaussian puffs to `splat`.

**Render simulated cloud water.** `CloudDensityVolume` places each accepted `CloudSolver` sample at the centre of its world cell. It converts the liquid-water mixing ratio to visible extinction using the air density and effective droplet radius. The defaults are 1.2 kg/m³ and 10 µm. The water field supplies the changing shape and location. Call `update()` after stepping or restoring the world.

```ts
import { Engine } from 'margoengine/core';
import { CloudSolver } from 'margoengine/physics/clouds';
import { PhysicsWorld } from 'margoengine/physics/world';
import { BoundaryLayerWind } from 'margoengine/weather/boundary-layer';
import { CloudDensityVolume } from 'margoengine/environment/density-volume';
import { VolumetricFog } from 'margoengine/environment/volumetric';
import { Tonemap } from 'margoengine/tonemap';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: { position: [0, 180, 1550], target: [0, 350, 0], near: 10, far: 4400 },
});
Tonemap.attach(engine);
const wind = new BoundaryLayerWind({ speed: 7.5, turbulence: false });
const cloud = new CloudSolver();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(cloud, {
  cells: [24, 12, 14], cellSize: 84, humidity: 0.96, humidityTop: 0.96, wind,
  timeScale: 180, interval: 3, surfaceHeat: 0, surfaceLatent: 0,
  bubbles: [{ centre: [-320, 360, 0], radius: 320, warming: 2.2, humidity: 1.18 }],
});
const volume = new CloudDensityVolume(cloud);
const fog = VolumetricFog.attach(engine, { density: 0, range: 3500, volumes: volume, temporal: 0 });
world.advance(10);
volume.update();
engine.render({ delta: 0 });
// Release the fog before the density volume when unloading the scene.
```

The grid uses renderer-local metres and fixed geometry. Recreate its volume when the source grid changes. The optical approximation uses a uniform density and radius, with trilinear filtering and the existing froxel lighting and resolution. It models warm liquid clouds in visible light. [Hansen and Travis (1974)](https://www.giss.nasa.gov/pubs/abs/ha09500o.html), [Slingo (1989)](https://doi.org/10.1175/1520-0469(1989)046%3C1419:AGPFTS%3E2.0.CO;2)

**Render wind-driven sea spray.** `SeaSprayDensityVolume` uses the accepted sea-spray parcels from `AirborneParticles`. Their mass, diameter and current material density determine the optical cross-section. Call `update()` after advancing or restoring the physics world.

```ts
import { Engine } from 'margoengine/core';
import { AirborneParticles } from 'margoengine/physics/airborne';
import { FoamSolver } from 'margoengine/physics/foam';
import { SpectralSea } from 'margoengine/physics/sea';
import { WaveSolver } from 'margoengine/physics/waves';
import { PhysicsWorld } from 'margoengine/physics/world';
import { BoundaryLayerWind } from 'margoengine/weather/boundary-layer';
import { SeaSprayDensityVolume } from 'margoengine/environment/density-volume';
import { VolumetricFog } from 'margoengine/environment/volumetric';
import { Tonemap } from 'margoengine/tonemap';
import { Sky } from 'margoengine/sky';
import { Water } from 'margoengine/water';

const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: { position: [35, 3.3, 10], target: [7, 1.25, -1], near: 0.35, far: 360 },
});
Tonemap.attach(engine, { exposure: -0.4 });
Sky.attach(engine, { sunDirection: [-0.94, 0.075, -0.37], timeScale: 0, lighting: { intensity: 3 } });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, seed: 42 });
const wind = new BoundaryLayerWind({ speed: 22, turbulence: false });
const sea = new WaveSolver();
const swell = { height: 4, period: 6, direction: 0 };
world.add(sea, {
  cells: [4, 4], cellSize: 24, depth: 80,
  frequencies: { count: 24, min: 0.06, max: 0.06 * 1.12 ** 23 },
  directions: 16, start: swell, swell, wind,
});
world.add(new FoamSolver(), { waves: sea.field, cells: [12, 12], cellSize: 3, statistics: 18, wind });
const airborne = await AirborneParticles.load({ whitecaps: true });
world.add(airborne, {
  wind,
  spray: { columns: 12, rows: 12, spacing: 3, centre: [0, 0], releaseHeight: 1.1 },
});
const spray = new SeaSprayDensityVolume(airborne, { cellSize: world.cellSize });
const surface = new SpectralSea({ waves: sea.field, seed: 42 });
const water = Water.attach(engine, { sea: surface, size: [110, 110], horizon: true, whitecaps: 0 });
const fog = VolumetricFog.attach(engine, {
  volumes: spray, density: 0, range: 62, anisotropy: 0.86, temporal: 0,
});
world.advance(120);
surface.refresh();
water.setTime(world.time);
spray.update();
engine.render({ delta: 0 });
// When unloading, release fog before spray, then remove the airborne solver from the world.
```

`voxelSize` defaults to 0.1 m. A parcel contributes extinction area `3m/(ρd)` in the visible large-droplet approximation. Its spherical Gaussian is normalized inside three standard deviations, with a standard deviation of two voxels. Sampling at voxel centres approximates that continuous integral, so volume resolution affects very narrow plumes. Small dried aerosol near visible wavelengths needs wavelength-dependent scattering. `update(renderCell)` accepts a signed cell when the renderer uses another origin. Omit it to use the source's live cell. Match `cellSize` to the world's cell width. [Hansen and Travis (1974)](https://www.giss.nasa.gov/pubs/abs/ha09500o.html), [Gong (2003)](https://doi.org/10.1029/2003GB002079)

How it works. The grid is the leaf layout of OpenVDB (Museth 2013): bricks of 8 x 8 x 8 voxels, z fastest, and constant tiles for whole bricks of one value. On the GPU a page table over the box of occupied bricks holds one entry a brick (empty, a tile's value, or its slot in the voxel store); each froxel maps its sample point to index space through the inverse of the index-to-world matrix and filters the eight voxel centres around it trilinearly, so `sample(p)` on the CPU gives the same value. A voxel value of 1 is `density` extinction per metre with albedo `color`. `splat` adds Gaussians of a given peak and world radius, cut at three radii. The page table and voxels upload only when the grid changed; the matrix, box and look every frame.

Options and defaults: `voxelSize` 0.5 m and `origin` [0, 0, 0] (voxel (0, 0, 0)'s centre), or `matrix` (affine, column-major index to world); `density` 1 per m; `color` [1, 1, 1]; `maxBricks` 32,768 (64 MiB of voxels); `maxPages` 16,777,216 (the page table spans the box round every brick, 4 B a brick of the box). Limits: detail finer than a froxel (about 8 x 8 pixels and a slice deep with the default grid) is averaged into it, so a close-up of fine smoke needs a finer `grid`; one `volumes` source per fog (this or `FogVolumes`); voxel indices within +-524,288; values below 0 read as 0. Real-GPU check: `npm run test:density-volume:browser` (WebGPU and the WebGL2 layer: Gaussian splats, a VDB leaf and a tile give an integrated froxel volume equal to a CPU mirror built on `sample`, every froxel; the albedo colours the fog; a rewritten grid shows on the next frame; an empty grid is clear).

## Sliders for the air: `@margoengine/environment/settings`

`VolumetricFog` reads its options each frame into one uniform, and `Fog`, `Environment` and `EnvironmentBackground` write theirs through setters, so the look changes while the scene runs and nothing is rebuilt. `@margoengine/environment/settings` lists those controls as a table for sliders and panels: `ENVIRONMENT_SETTINGS` has 29 rows (`name`, `group`, `kind`, `default`, `min`, `max`, `step`, `unit`, `about` and `live`), grouped as the air (`air.visibility`, `air.heightFalloff`, `air.height`, `air.color`, `air.ambient`, `air.anisotropy`, `air.multipleScattering`, `air.range`, `air.temporal`, `air.enabled`), its noise and drift (`noise.*`), the scene fog (`sceneFog.*`), the environment (`environment.intensity`, `environment.rotation`) and the background (`background.exposure`, `background.blur`, `background.rotation`). `applyEnvironmentSettings({air, fog, environment, background}, values)` writes a set of values onto the objects you give (a name left out takes its default), and `ENVIRONMENT_LOOKS` names six looks made only of row values: `clear`, `haze`, `mist`, `fog`, `smokePall` and `dustHaze`. An unknown name throws `TypeError`, a value outside its row's range `RangeError`, and a row moved off its default whose object you did not pass `TypeError`.

Every row is `live` (can change every frame with no rebuild) except the three `grid.*` sizes, which reallocate the froxel grid on the next frame. Writing every live row each frame for 60 frames creates no pipeline, buffer or texture (`npm run test:settings:browser`, native WebGPU and the WebGL2 layer), and the defaults written draw exactly what a fog built with no options draws. The one cost: `air.multipleScattering` leaving 0 compiles one fog program (and returning to 0 another), so key it over a range that stays above 0.

`air.visibility` is how far a dark object stays visible (Koschmieder, 2% contrast; clear air 23,000 m, mist 1,000, fog 200). It is nullable: null follows the weather. A `WeatherDrive` from `@margoengine/weather` writes the fog's density each frame while the row is null; a value is an override the drive never writes, and setting null hands the air back to the weather. Without a drive null is clear air. The same holds for `sceneFog.density`, the `noise.windX` and `noise.windZ` drift and `air.color`: while `air.color` is null the drive gives the fog the colour of its dust, smoke, ash and sea spray (each load's colour by its share of the air, the rest white), and a colour set outside the table stays; a value holds the colour against the drive (white too), and null takes back only a colour the table set. Before 2026-11-17 `air.color` defaulted to white and the drive wrote no colour, so an ash or smoke fog stayed white. `air.ambient` null is the sky's horizon light, `air.heightFalloff` null is the haze's scale height (1 in 1,200 per metre), and null on `noise.windX` and `noise.windZ` leaves the drift to the drive.

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {VolumetricFog} from 'margoengine/environment/volumetric';
import {ENVIRONMENT_LOOKS, applyEnvironmentSettings} from 'margoengine/environment/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);
const air = VolumetricFog.attach(engine, {});
applyEnvironmentSettings({air}, {...ENVIRONMENT_LOOKS.mist, 'air.height': 5});
// Key a row over a shot: the mist thickens from a kilometre of sight to 300 metres.
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  applyEnvironmentSettings({air}, {...ENVIRONMENT_LOOKS.mist, 'air.height': 5, 'air.visibility': Math.max(300, 1000 - 70 * time)});
});
```

## Light probes: irradiance volumes and reflection probes

`@margoengine/environment/probes` is a separate entry (14,984 B min+gzip with live capture, 13,541 B before it, measured the way `examples/package-benchmarks/entry-sizes.mjs` does; the root entry is byte-identical without it).
It bakes the scene into light probes on the GPU and uses them as the ambient light of core meshes and of every model
you `add` (gltf/pbr and materials models, terrain), the receivers clustered lights reach:

```ts
import {Engine} from 'margoengine/core';
import {Environment, loadEnvironmentImage} from 'margoengine/environment';
import {LightProbes} from 'margoengine/environment/probes';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const environment = await Environment.create(engine, await loadEnvironmentImage('/sky.hdr'));
const probes = LightProbes.attach(engine, {
  environment,                                                            // ambient outside the probes, and the sky they see
  volume: {min: [-5, 0, -4], max: [5, 3, 4], counts: [6, 2, 5]},          // irradiance probes at the cell centres
  reflections: [{position: [0, 1.5, 0], min: [-5, 0, -4], max: [5, 3, 4]}], // box-projected onto the room's walls
});
// probes.add(model) for each gltf/pbr / materials model or terrain; added models are also captured.
await probes.bake();                                                      // at load, or again whenever the scene changes
// For a moving mirror, keep the capture at its centre and refresh on demand:
probes.setReflectionPosition(0, [1, 1.5, 0]);                              // must stay inside this probe's box
await probes.bake();
// For live updates, bound the rough-level GGX filter work; sharp reflection detail stays at the configured resolution.
await probes.bake({samples: 256});
// Or keep the reflection probes current while the scene changes: one cube face per frame, nearest probe first
// (also `LightProbes.attach(engine, {..., live: {facesPerFrame: 1}})`), with culling off so captures see everything.
probes.setLive({facesPerFrame: 1, priority: 'nearest'});
engine.start({culling: false});
await probes.refresh(0);                                                  // re-capture one probe from code, e.g. a door opened
```

- **Irradiance volume.** A box filled with a grid of probes (1-64 per axis, at most 4,096), one per cell centre. Each probe
  renders the scene into six faces (`resolution`, default 16 px) and projects them to L2 spherical harmonics (`sh: 1` keeps
  L1: 4 instead of 9 coefficients), stored as irradiance / PI like the environment's SH. Receivers blend the eight nearest
  probes trilinearly (clamped to the outer cell centres); surfaces on the box faces are inside, and the volume fades to
  the fallback over `blend` metres outside the box (default 0).
A capture draws core's lit shader from the probe's own camera with every surface patch, under a post stack and TAA alike (TAA's jittered clip transform gives way to the probe camera; before KB-PROBES-TAA1 every face drew the main camera's view), through the same helper as `LightBounce` (`packages/shared/frame-capture.js`).

- **Reflection probes.** Up to 16, each captured at `position` (`resolution`, default 128 px faces) and stored as
  octahedral radiance levels down to 4 x 4: level 0 resampled from the faces, each rougher level a GGX convolution of
  level 0 at roughness level / (levels - 1) (n = v = r, as the environment's prefilter). A surface's reflected ray is
  intersected with the probe's box (box projection) and the radiance read from the two levels around its roughness,
  bilinear in each and blended by GGX alpha (roughness squared, so the mix is as wide as the lobe). The
  box is also the influence volume (its faces included, so a room box lights its own walls); the probe fades out over
  `blend` (default 10% of its smallest side) outside it, and
  where boxes overlap the earlier probe in the list wins, so list nested boxes first. `setReflectionPosition(index,
  position)` moves the capture point and its box-projection origin together, keeping the last baked radiance until the
  next `bake()`. It validates an integer probe index and a finite position inside the box; input vectors are copied.
- **Sphere probes and weighted blending.** `{shape: 'sphere', position, radius}` sphere-projects a probe for curved
  rooms and outdoor areas: the reflected ray is intersected with the sphere of `radius` around `position` (its far
  hit, as seen from inside) and the sphere is the influence, fading out over `blend` (default 10% of the diameter)
  past its surface. `reflections[i].min` and `max` read back its bounding box, and `setReflectionPosition` moves the
  capture point inside the sphere, which stays where it was. `reflectionBlend: 'weighted'` (default `'order'`)
  combines overlapping probes by their fade weights instead of list order, normalised where the weights sum past 1,
  so a reflection crosses smoothly from one probe to the next. Box probes in the default order keep the shader text
  they had; sphere probes and weighted blending add their code only when used:

```ts
import {Engine} from 'margoengine/core';
import {LightProbes} from 'margoengine/environment/probes';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const probes = LightProbes.attach(engine, {
  reflections: [
    {shape: 'sphere', position: [0, 2, 0], radius: 6},            // a round hall
    {position: [8, 1.5, 0], min: [5, 0, -3], max: [12, 3, 3]},    // the corridor next to it
  ],
  reflectionBlend: 'weighted',                                     // smooth across the doorway, whatever the order
});
await probes.bake();
```

  Real-GPU check: `npm run test:reflection-shapes:browser` (LightProbes' own shading declarations, run in a compute
  pass over its packed header and direction-coded texels, equal a CPU mirror of the sphere and box projections and both
  blend modes at 512 random rays within 3.2e-7 on an Apple M6; a real engine bakes and shades sphere and box probes,
  weighted, with no GPU error).
  For a mirror model that should receive reflections without appearing in its own capture, call
  `model.addLighting(probes)` directly instead of `probes.add(model)`.
- **Replacing the ambient term.** Probes replace the ambient light, named `margoAmbient` like `EnvironmentLighting`, so
  SSAO occludes it: diffuse from the volume and specular from the reflection probes, split-sum weighted as
  EnvironmentLighting; where a probe's weight is below 1 the rest comes from `environment` (its SH and prefiltered cube,
  exactly EnvironmentLighting's term) or, without one, from the receiver's own ambient (core's scalar ambient, gltf/pbr's
  hemisphere). Use LightProbes instead of EnvironmentLighting, not with it (patching both throws, naming the fix). Unbaked
  probes have weight 0, so attaching them changes nothing until `bake()` resolves.
- **Baking.** `bake()` renders one ordinary frame (shadow maps and other per-frame inputs come from the previous frame),
  then a frame whose pass at order -0.5 captures every probe: core meshes through core's fully patched lit shader drawn
  from the probe camera, and every added model with a `draw` method, as linear radiance without fog (receivers fog
  themselves); clustered point and spot lights are looped in full (the light lists are culled for the main camera), area
  lights and shadows are as the frame has them; where nothing was drawn the environment's sky (or black) fills in. One
  submit per face, then one compute pass per probe. The full-source convolution of a reflection probe's rough levels
  (the default, no `samples`) then runs in dispatches that each loop over at most 16,384 source texels per output
  texel (and 2^24 reads in all), one submit each, their running sums kept in a small storage buffer between them, so
  the stored texels are the same. As one dispatch per level a 256 px probe loops over all 65,536 texels of its level 0
  for every output texel, and on the WebGL2 layer over ANGLE Metal (Apple M6) that command buffer failed and the
  context was lost (KB-SHOT-COMPATLOST1; 32,768 passed). A 256 px probe takes 96 such submits per bake bounce, a
  128 px probe 8, a 16 px probe 2. `bounces: n` repeats the capture n times, each seeing the previous
  bake's probe light (one more bounce each). The result is also read back to the CPU: a device restore re-uploads it, and
  `irradianceAt(position, normal)` returns the volume's irradiance there, as the shaders compute it.
- **Live reflection filtering.** `bake({samples: 256})` uses a deterministic Hammersley GGX importance filter for the rough
  reflection levels, taking that many directional samples per output texel. `samples` must be a power of two from 64 to
  4096; omit it to retain the full-source convolution. The sharp level 0 and volume SH are unchanged. This bounds filter
  work independently of capture resolution: at 128 px, 256 samples reduce rough-level iterations from 89.4 million to
  1.40 million. Each rough texel's samples are split across a 64-thread workgroup and summed in workgroup memory: one
  thread per texel looping over all 256 samples waited on its texture reads in series (a 2.0 ms median per 128 px probe
  on the RTX A6000, 0.13-0.20 ms split). Samples read the captured cube faces and environment fallback directly, without source mip filtering;
  tiny, very bright sources can require more samples. Invalid options fail before any rendering or probe mutation.
  Bake shader modules and compute pipelines are cached per device and filter mode; changing the sample count uses a
  uniform rather than compiling another shader. Device restoration rebuilds the pipelines from the new device.
- **Live capture.** `setLive({facesPerFrame, priority, samples})` (or the `live` option; `setLive(null)` stops) keeps
  reflection probes current while the scene changes, time-sliced: each frame's capture pass renders up to
  `facesPerFrame` cube faces (1-96, default 1) of one probe at a time, and runs that probe's prefilter with its sixth
  face, so shading switches to complete new radiance at once, never a half-captured probe. The live prefilter is the
  bounded GGX filter above (`samples`, default 256): every refresh costs about the same, so it does not spike a frame.
  `priority: 'nearest'` (default) refreshes every reflection probe once per round, the one whose box is nearest the
  camera first (the camera inside a box is nearest); `'dynamic'` refreshes only probes marked `dynamic: true` and leaves
  the others as baked. With a still camera a change shows within (eligible probes + 1) refreshes of
  `6 / facesPerFrame` frames each. `refresh(index?)` re-captures one probe (all without an index) from code, ahead of
  the live order and sliced the same way, with or without live capture; its promise resolves once the GPU has finished
  the probe's prefilter and rejects if the probes are disposed first. `refreshes` counts completed refreshes. A probe
  captured live lights receivers from its first refresh, baked or not. Live radiance stays on the GPU: `texels`,
  `irradianceAt` and device-loss restore keep the last `bake()`, and after a device loss live probes are dark until
  recaptured (a requested refresh restarts). A `bake()` during live capture restarts the probe in progress. The
  irradiance volume has its own live mode, `setLiveVolume({probesPerFrame})` (the `/gi` entry, below).
  `volume.visibility: true` stops light leaking through thin walls between probes: each capture also stores the
  probe's mean and mean square distance to the scene in 24 direction bins (the six cube faces by quadrant, a depth
  reduction pass per face), and receivers weight each of the eight probes by its Chebyshev visibility of the point
  (biased a quarter cell along the normal) and a smooth backface term, then renormalise (after DDGI, Majercik et al.
  2019). It adds 192 B per probe and one small compute pass per captured face; off, the shader text and buffer are byte for byte as before. Captures draw what the frame draws: core meshes the frame culls for the main camera
  are missing from them, so render with `culling: false` when probes must see what the camera does not.
- **Bindings.** One storage buffer (header, then float16 RGB texels: 72 B per L2 probe, 21,840 texels per 128 px
  reflection probe) and no sampled texture; with an environment the same five IBL bindings EnvironmentLighting uses. So
  gltf/pbr's physical material with shadows, LocalShadows and environment lighting stays at 16 sampled textures; storage
  buffers in the lit fragment become 6 of 8 with clustered + area lights.
- **SSR.** `@margoengine/post/ssr` removes the probes' own specular (`probeSpecular`) where it finds a reflection on
  screen and keeps the probe's elsewhere, so reflection probes are SSR's off-screen fallback.

Measured (Intel Arc 140V, Edge 155, AC; `node examples/package-benchmarks/probes-gpu.mjs`,
[probes-gpu.json](../../examples/package-benchmarks/results/probes-gpu.json)). A closed 4 x 3 x 4 m room whose six walls
radiate exactly their colour, with a 2 x 2 x 2 L2 volume and one 128 px reflection probe filling it:

- Volume SH read back vs a CPU projection of the analytic room (6 x 256^2 samples): every coefficient of every probe
  within 1.7% of the probe's DC term (0.7-1.7%).
- Reflection levels vs the analytic radiance (level 0) and a CPU GGX convolution of it (levels 1-5, roughness 0.2-1):
  median error 0.0002-0.0018, 95th percentile 0.0003-0.0083 (radiance 0.1-0.9); the largest errors (level 0: 0.22, level
  1: 0.04) sit on the texels that straddle a wall-colour boundary.
- Shading through a CPU mirror of the WGSL (trilinear SH, box projection, trilinear levels, split sum, each path's tone
  map): a white core sphere and a white materials sphere (gltf/pbr hook) and a rough (0.5) metal floor within 1/255; a
  mirror metal floor within 2/255 at the 95th percentile (5/255 at most) for wall points 0.4 m or more from a wall edge.
- Box projection is physical: on that mirror floor each pixel shows the wall its reflected ray hits (95th percentile
  2/255). Closer to an edge, where several walls fall in one 128 px octahedral texel seen from the probe, the reflection
  shows texel-sized steps (a finer `resolution` shrinks them).
- No geometry, a synthetic HDR sky: the volume's SH equals the Environment's own within 0.05% of DC, and spheres lit by
  `LightProbes({environment})` match `EnvironmentLighting` within 1/255.
- Unbaked probes: core meshes bit-identical to no probes, gltf/pbr identical (0/255).
- With SSR (two views, mirror floor): on screen, 99% of reflecting pixels are no brighter than both the wall as rendered
  and the probe reflection (adding instead of replacing would exceed both; median difference to the wall 2/255); off
  screen the floor equals the frame without SSR (95th percentile 0/255).
- Cost (diagnostic: the quiet gate passed at 12% CPU, but other jobs were running), GPU time of the whole
  frame at 4x MSAA with the room, both spheres and the volume (4 x 2 x 4) and one reflection probe covering the screen:
  1280 x 720 0.6-1.1 ms -> 3.8-3.9 ms (volume alone 2.5, reflection probe alone 2.1); 1920 x 1080 2.4 ms -> 8.1-9.2 ms
  (5.6 and 4.9). Bake of 8 volume probes (16 px) and one 128 px reflection probe: 114-121 ms, 382 ms the first time
  (pipeline creation included).

Live capture, measured (RTX A6000, Edge 155 headless, quiet gate passed at 18% CPU;
`node examples/package-benchmarks/probes-live-gpu.mjs --bench`,
[probes-live-gpu.json](../../examples/package-benchmarks/results/probes-live-gpu.json)). The room above with one 128 px
live probe (256 samples) and a magenta box moved into its +x view, frames rendered with culling off:

- Latency, frames from the move until the probe's texel toward the box changes, starting at every point of the refresh
  cycle: 1 face per frame 7-11 frames to appear (bound 12) and 6 to vanish; 2 faces 4-5 (bound 6) and 3; 6 faces 1
  (bound 2) and 1. The mirror floor shows the box through the probe (`test-results/probes-live-box-in.png`).
- GPU time of the capture per frame (timestamp queries on its passes; the timer's resolution is 0.066 ms): at 1 face per
  frame the face frames take 0.066 ms or less and the frame with the sixth face and the prefilter a median 0.20 ms (max
  0.33); at 2 faces 0.07-0.13 ms and 0.20 ms (max 0.26); at 6 faces, a whole probe every frame, a median 0.33 ms (95th
  percentile 1.7, max 2.9). The scene's own frame took a median 0.20-0.26 ms. Before the prefilter was split across
  workgroups, the refresh frame at 1 face per frame took a median 2.0 ms and up to 6.3 ms (diagnostic run, quiet gate
  not passed).
- For comparison, a bake of the same probe (six faces and the full-source convolution) spent 23-95 ms of GPU time in
  the prefilter over three runs.

### Terrain, sky and other plugins in probe captures

Captures draw core meshes and the models added with `probes.add`. `probes.addCapture(plugin, options)` adds a plugin's
own render passes too: every bake, live and on-demand capture replays them into each probe face, after the meshes and
models, so the terrain and the sky show in the reflections and the bounce light. The passes run with the face's
context (its camera, encoder, `rgba16float` color and depth, one sample) on the real device, and draw as they draw in the
frame, with their own fog. By default the passes ordered after the main pass (the drawing passes) replay; `passes`
names them instead. Terrain uploads its camera in `'<name>:prepare'`, which runs before the capture: name it, and after
the capture it runs once more with the frame's context, so the frame's terrain draw sees the main camera again. Never name a
pass that advances a simulation: it would advance once per face. `addCapture` returns a remover.

```ts
import { Engine } from 'margoengine/core';
import { LightProbes } from 'margoengine/environment/probes';
import { Sky } from 'margoengine/sky';
import { Terrain } from 'margoengine/terrain';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
// A flat green terrain; replace the tiny demo maps with your heightmap and layers (see @margoengine/terrain).
const terrain = Terrain.attach(engine, {
  resolution: 16, levels: 3, origin: [-50, -50], size: [100, 100], heightScale: 1,
  layers: [0, 1, 2, 3].map(() => ({ height: [-100, 100], slope: [0, 1], scale: 1 })),
  textures(device) {
    const heightmap = device.createTexture({ size: [4, 4], format: 'r32float', usage: 6 }); // TEXTURE_BINDING | COPY_DST
    device.queue.writeTexture({ texture: heightmap }, new Float32Array(16), { bytesPerRow: 16 }, [4, 4]);
    const layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
    device.queue.writeTexture({ texture: layers }, new Uint8Array(16).fill(40).map((v, i) => (i % 4 === 1 ? 200 : i % 4 === 3 ? 255 : v)), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 4]);
    return { heightmap, layers };
  },
});
const sky = Sky.attach(engine);
const probes = LightProbes.attach(engine, {
  reflections: [{ position: [0, 2, 0], min: [-10, -1, -10], max: [10, 10, 10] }],
});
probes.addCapture(terrain, { passes: [terrain.name + ':prepare', terrain.name] });
probes.addCapture(sky); // 'sky:atmosphere' and 'sky:fog'
await probes.bake();
```

Checked on an Apple M6 (Metal, Chromium 156; `npm run test:probe-capture:browser`): a probe over flat green terrain
under a `Sky`, with no environment, bakes black without the hook; with it, its downward texels average linear
(0.029, 0.47, 0.029) and its upward ones (0.27, 0.42, 0.81). During live capture the terrain's camera upload replays
once per face with the probe's position, and the frame's last upload before its submit holds the main camera.

### Sky light indoors: `sky`

A `Sky` with `lighting.ambient` (every `dayPreset`) lights every surface with the whole sky, so a shed's or a room's
floor is as bright as the open ground: the sky light has no visibility term. Pass the sky as `sky` and put an irradiance
volume over the interior. Inside the volume the sky light comes only through what the probes see of the sky (the door
and the windows), with the walls and the roof between; outside it the sky lights the scene exactly as it does alone
(its own diffuse and specular light, `skyIrradiance` and `skyRadiance`). The sky is added to the captures for you
(`addCapture(sky)`), and until its light is ready (first frame, or no `lighting.ambient`) the sky lights the scene by
itself. `sky` and `environment` are exclusive. Add a model with `probes.add(model)`, not `sky.add(model)`.

```ts
import { Engine, PbrMaterial, box } from 'margoengine/core';
import { LightProbes } from 'margoengine/environment/probes';
import { Sky } from 'margoengine/sky';
import { dayPreset } from 'margoengine/sky/day-presets';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const wood = new PbrMaterial({ color: '#8a6a48', roughness: 0.9 });
engine.createMesh().setGeometry(box(80, 0.2, 80)).setMaterial(new PbrMaterial({ color: '#b8a888' })).setPosition([0, -0.1, 0]);
engine.createMesh().setGeometry(box(4.2, 2.5, 0.1)).setMaterial(wood).setPosition([0, 1.25, -2.05]); // back wall
engine.createMesh().setGeometry(box(0.1, 2.5, 4.2)).setMaterial(wood).setPosition([-2.05, 1.25, 0]); // side walls
engine.createMesh().setGeometry(box(0.1, 2.5, 4.2)).setMaterial(wood).setPosition([2.05, 1.25, 0]);
engine.createMesh().setGeometry(box(4.4, 0.1, 4.4)).setMaterial(wood).setPosition([0, 2.55, 0]); // roof, open front
const sky = Sky.attach(engine, dayPreset('overcast'));
const probes = LightProbes.attach(engine, {
  sky,
  volume: { min: [-2, 0, -2], max: [2, 2.5, 2], counts: [4, 3, 4], visibility: true }, // the shed's inside
});
await probes.bake({ bounces: 2 });
engine.start();
```

Checked on an NVIDIA RTX A6000 (Chromium 157; `npm run test:sky-occlusion:browser`, add `--compat` for the WebGL2
layer): a 4 m x 4 m shed, 2.5 m high, with a 1 m x 2 m door and two 1 m x 0.8 m windows, on open sand under the overcast
preset. The floor's linear luminance seen from inside, against the open sand: 1.0 with the sky alone (KB-SCENES-SKYOCC1),
0.093 with the probes and `sky` (a daylight factor of a few per cent, as such a room gets under the CIE overcast sky),
0.017 with the door and windows shut; the open sand stays at the sky-alone value (0.1006) to the last digit, and
disposing the probes gives the sky its light back. Same figures on the WebGL2 layer (0.0929, 0.0174).
Sources: G. Greger, P. Shirley, P. Hubbard, D. Greenberg, "The Irradiance Volume", IEEE CG&A 18(2), 1998
(https://doi.org/10.1109/38.656788); R. Ramamoorthi, P. Hanrahan, "An Efficient Representation for Irradiance
Environment Maps", SIGGRAPH 2001 (https://doi.org/10.1145/383259.383317); M. McGuire et al., "Real-Time Global
Illumination using Precomputed Light Field Probes", I3D 2017 (https://doi.org/10.1145/3023368.3023378), the Chebyshev
visibility of `visibility`; P. Moon, D. E. Spencer, "Illumination from a non-uniform sky", Illuminating Engineering 37,
1942, the overcast sky behind the daylight factor; M. Sattler, R. Sarlette, G. Zachmann, R. Klein, "Hardware-accelerated
ambient occlusion computation", VMV 2004, weighed and not used: shadow maps from many sky directions give the visibility
but not the light the walls bounce in, which the probes' captures carry.

Not yet replayable: `Water` (its surface reads the frame's viewport-sized scene depth and throws in a probe face) and
`VFX` particle systems (their draw reads the camera their simulation pass uploaded, so they would draw the frame's view
into every face, and their visible list is culled for the main camera). Both need a change in their own package.

Limits: the irradiance volume is static: a moving object or light needs a re-bake (CPU encode plus GPU, see above);
reflection probes can follow the scene with live capture, a few frames behind (see Live capture); without `visibility`, light leaks through walls
thinner than the probe spacing (place volume boxes per room); one volume per LightProbes;
reflection probes are box- or sphere-projected (no other shapes); the receiver's normal map and occlusion shade the probe
light (terrain takes the core-style patch like EnvironmentLighting); core meshes and models with a `draw` method
(gltf/pbr, materials) are captured, terrain, sky and other plugins only through `addCapture` (above; not water or VFX
particles yet), and the environment fills in where nothing was drawn; GPU-culled
(`CulledMeshes`) parts use the main camera's culling in the capture. WebGPU only.

## Blending two environments

`@margoengine/environment/blend` fades between two environments, for example day to night or indoor to outdoor, with matching image-based lighting. `blend.environment` is an ordinary `Environment` holding `(1 - t) x from + t x to` in its source cube, every prefiltered specular mip and its SH, so `EnvironmentLighting`, `EnvironmentBackground` and `LightProbes` light and draw with it unchanged:

```ts
import {Engine} from 'margoengine/core';
import {Environment, EnvironmentBackground, EnvironmentLighting, loadEnvironmentImage} from 'margoengine/environment';
import {EnvironmentBlend} from 'margoengine/environment/blend';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const day = await Environment.attach(engine, await loadEnvironmentImage('/day.hdr'), {name: 'day'});
const night = await Environment.attach(engine, await loadEnvironmentImage('/night.hdr'), {name: 'night', intensity: 0.4});
const blend = await EnvironmentBlend.attach(engine, day, night, {t: 0});
EnvironmentLighting.attach(engine, blend.environment);
EnvironmentBackground.attach(engine, blend.environment);
engine.onFrame((_, delta) => (blend.t = Math.min(1, blend.t + delta / 10))); // a ten second fade
engine.start();
```

How it works. Prefiltering and SH projection are linear in the radiance, so blending the two sources' results equals processing the blended image (up to rgba16float rounding) and no prefiltering runs per change: setting `t` renders one full-screen triangle per output mip and face that reads each source at the same direction and roughness (two texture reads per texel), and blends the SH on the CPU (each source's SH turned by its `rotation` with `rotateSH`, an exact quadrature, and weighted by its `intensity`). Each source's `rotation` and `intensity` are baked into the blend, so `blend.environment.rotation` and `.intensity` stay free for the whole. The output takes the larger of the two sources' `size`, `specularSize` and `specularMips` (or `size`, `specularSize`, `specularMips` options); a smaller source is read at the matching mip. Bind groups made from `blend.environment` stay valid through every reblend. `set(from, to, t)` swaps the sources (dusk to night after day to dusk); call `update()` after changing a source's `rotation` or `intensity` or after `refresh()`ing a source. `engine.use(blend)` (or `attach`) restores both sources and the output after a device loss and blends again; `dispose()` frees the output only.

Limits: a linear crossfade of radiance, not a time-of-day model (use `@margoengine/sky` for a sun that moves); the output keeps a full source cube and prefiltered cube of its own (the memory of a third environment); the background shows the blended cube, not either source's equirect; the output's BRDF LUT uses `brdfSize` and `brdfSamples` (Environment defaults unless set). Real-GPU check: `npm run test:blend:browser` (every cube and specular mip and the SH equal the weighted sources within rgba16float rounding at t 0, 0.25 and 1; a source turned a quarter turn with intensity 2 lands texel for texel; mixed sizes; a device restore blends again).

## Saving and loading a processed environment

`@margoengine/environment/prefiltered` saves an `Environment` (its source and specular mips, both SH sets, the BRDF
LUT, rotation, intensity and radiance scale) to one lossless KTX2 file, and loads it back with no GPU filtering:

```js
import { Environment, parseHDR } from '@margoengine/environment';
import { loadPrefilteredEnvironment, savePrefilteredEnvironment } from '@margoengine/environment/prefiltered';

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error('WebGPU adapter required');
const device = await adapter.requestDevice();
const image = parseHDR(await (await fetch('/studio.hdr')).arrayBuffer());
const environment = await Environment.create(device, image, { size: 64, specularSize: 64 });
if (environment.refreshPending) await environment.refresh(); // a save during a refresh rejects with code 'state'
const file = await savePrefilteredEnvironment(environment); // Uint8Array, KTX2
const baked = await loadPrefilteredEnvironment(device, file); // or a URL
```

The file holds the lighting as it was when `savePrefilteredEnvironment` was called: the settings and SH are copied and
every texture copy is submitted at once, before the first await, so a later `blend.t`, `update()` or `refresh()` does
not reach it. While `environment.refreshPending` is true (from `refresh()` until its promise settles) the textures and
SH are part old, part new, and the save rejects with MargoError `state`; it also rejects when the environment is
restored or disposed before the readback ends.

## Ground projected environment

`@margoengine/environment/ground` projects the environment onto a floor disc and a dome around the point it was photographed above, so a product or car stands on the photographed floor instead of floating inside an infinitely distant sphere. `GroundProjectedBackground` is an `EnvironmentBackground` (same pass, order, exposure, rotation, blur, depth test and outputs) with three more settings: `height`, the photo camera's height above the floor in metres (the tripod's, default 1.6); `radius`, the radius of the floor disc and of the dome it ends in (default 50); and `center`, the world floor point under the photo's camera (default `[0, 0, 0]`):

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Environment, EnvironmentLighting, loadEnvironmentImage} from 'margoengine/environment';
import {GroundProjectedBackground} from 'margoengine/environment/ground';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu', camera: {position: [0, 1.5, 4], target: [0, 0.5, 0]}});
const environment = await Environment.attach(engine, await loadEnvironmentImage('/garage.hdr'));
EnvironmentLighting.attach(engine, environment);
GroundProjectedBackground.attach(engine, environment, {height: 1.6, radius: 20});
engine.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial({color: '#c08040'})).setPosition([0, 0.5, 0]);
engine.start();
```

How it works. Per pixel the view ray from the eye meets the floor plane at the center's height (when it points down and the eye is above the floor) or the dome, a sphere of `radius` around `center`, whichever is nearer; the lookup direction then runs from the photo's camera, `height` above `center`, to that point, so the floor of the image stays in place in the world as the camera moves. Exact ray-plane and ray-sphere geometry in the background's fragment shader; outside the dome the plain view ray is used. `height`, `radius` and `center` are live (a uniform write); `height` must stay below `radius` (each setter checks the pair and a refused value changes nothing).

Limits: the floor is flat at the center's height and the dome is a sphere, so anything in the photo that is not on the floor (walls, cars, trees) is projected onto the dome and bends as the camera moves; keep the camera inside the dome and above the floor; the projection only moves the background, models get no contact shadow from it (add `@margoengine/shadows` or a shadow catcher). Real-GPU check: `npm run test:ground:browser` (every pixel equals the environment along the CPU-mirrored projected direction from two cameras, a floor point keeps its colour from both cameras while a plain background does not, geometry is never covered, blur draws, and a real engine draws a box on the projected floor with no validation error).

## Procedural studio environment

`@margoengine/environment/studio` makes a photo studio for product lighting with no HDR file to download: `studio(options)` returns an equirect `FloatImage` (linear RGBA, width x width / 2) of a grey room, a darker floor, lighter walls rising to a brighter ceiling, lit by rectangular softboxes. Hand it to `Environment.attach` or `EnvironmentLighting.load` as any decoded image. The default `STUDIO_LIGHTS` are three-quarter product lighting for a camera on +Z looking at the origin: a large overhead softbox, a key light to the front left, a dimmer fill to the front right and a narrow rim strip behind:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Environment, EnvironmentBackground, EnvironmentLighting} from 'margoengine/environment';
import {STUDIO_LIGHTS, studio} from 'margoengine/environment/studio';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu', camera: {position: [0, 1, 3], target: [0, 0.5, 0]}});
const image = studio({
  walls: [0.25, 0.25, 0.28],
  lights: [...STUDIO_LIGHTS, {direction: [0, 0.1, 1], width: 0.5, height: 0.3, intensity: 2, color: [1, 0.9, 0.8]}], // a warm front card
});
const environment = await Environment.attach(engine, image);
EnvironmentLighting.attach(engine, environment);
EnvironmentBackground.attach(engine, environment, {blur: 0.4});
engine.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial({color: '#c08040', roughness: 0.3})).setPosition([0, 0.5, 0]);
engine.start();
```

How it works. Each texel's radiance is the room plus every softbox over it. The room is a function of elevation alone: the floor colour below the horizon, a smoothstep over the `horizon` band (default 0.08 rad) to the wall colour, then toward the ceiling colour by the sine of the elevation. A softbox is a rectangle of `width` x `height` radians around its `direction`: a texel's direction is projected onto the light's plane (gnomonic projection) and its two angles from the centre compared with the half sizes, with a smoothstep fade over the last `softness` share of each (default 0.15; 0 is a hard edge); inside it adds `intensity x color`. Pure and deterministic: the same options give the same bytes. Options: `width` (512, a power of two 16 to 4,096), `floor` (0.12 grey), `walls` (0.3 grey), `ceiling` (0.45 grey), `horizon` (0.08 rad), `lights` (`STUDIO_LIGHTS`); per light `direction`, `width`, `height` (radians, each in (0, PI)), `intensity` (0 to 65,504), `color` ([1, 1, 1]) and `softness` (0.15). Invalid values throw `RangeError`.

Limits: an image, not a lit scene, so softboxes are infinitely far away (no parallax, no falloff with distance) and there is no contact shadow (add `@margoengine/shadows`); the image is made on the CPU in one pass over its texels, so a 4,096 wide studio is 8.4 M texels of work (keep the default 512 for lighting, where the prefilter blurs it anyway); cost not timed. The stage viewer's built-in studio (`addViewer` without an `environment`) is its own fixed 128 x 64 image, not this entry. Real-GPU check: `npm run test:studio:browser` (an Environment made from the studio keeps it in its source cube toward every softbox, the floor and a wall, its GPU SH equals the CPU projection of the image, the key side of the irradiance is over 1.5x the fill side and the floor side the darkest, and it lights a real engine with no GPU error).

## Dynamic global illumination

`@margoengine/environment/gi` gives bounce light that follows moving lights and objects each frame, so opening a door or moving the sun lights the room, with no bake. `DynamicGI` is `LightProbes` with an irradiance volume over a box in live mode: every frame it captures `probesPerFrame` volume probes (six cube faces at `resolution` each, then their SH) in a fixed sweep, so the whole volume is captured again every `sweepFrames` frames:

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {DynamicGI} from 'margoengine/environment/gi';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu', camera: {position: [0, 1.5, 4], target: [0, 1, 0]}});
engine.createMesh().setGeometry(box(6, 0.1, 6)).setMaterial(new PbrMaterial({color: '#cccccc'}));
engine.createMesh().setGeometry(box(0.2, 3, 6)).setPosition([-2, 1.5, 0]).setMaterial(new PbrMaterial({color: '#cc1010'}));
const gi = DynamicGI.attach(engine, {min: [-1.8, 0, -2], max: [2, 2.5, 2], counts: [4, 3, 4], probesPerFrame: 4});
const frame = () => {
  engine.render({culling: false}); // the probes see the whole room, not only what the camera sees
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```

How it works. Each capture renders the scene as the frame lights it, probe light included, so every sweep adds one more bounce: the volume converges to the multi-bounce light as a radiosity iteration does (Goral et al. 1984), changes in the scene reach the light within one sweep and further bounces settle over the following sweeps. Receivers read the volume as they read a baked one (trilinear between probe centres, L1 or L2 SH, `blend` metres of fade to the fallback outside the box); the volume lights them from the end of the first sweep, and after a device restore from the end of the first sweep on the new device. `gi.sweeps` counts finished sweeps; `setLiveVolume(null)` stops capturing (the last light stays) and `setLiveVolume({probesPerFrame})` starts it again; `await gi.readback()` copies the GPU light to the CPU copy that `irradianceAt` reads. `LightProbes` itself takes the same `liveVolume` option. Each entry is self-contained, so `DynamicGI` extends its own copy of `LightProbes` (`instanceof` against the class of `/probes` is false).

Limits: the cost is `6 x probesPerFrame` scene renders of `resolution` squared pixels a frame (not timed); a change takes up to one sweep to show and each further bounce one more sweep; light between probe centres is interpolated, so a small volume grid leaks light through thin walls; captures draw what the frame draws, so render with `culling: false`; no specular bounce (reflections stay as they are). Real-GPU check: `npm run test:gi:browser` (a sunlit red wall bounces red light into the room after one sweep; with the sun behind the wall, or the wall moved away, the red bounce falls within one sweep; with live capture off the light holds still; after a device restore it comes back).

## Mirrors, glass and cube cameras

Optional entries that render the scene a second time through another camera, into their own HDR target, before the
frame: `Reflector` (`@margoengine/environment/reflector`, a planar mirror), `Refractor` (`/refractor`, a planar
see-through surface such as glass or water) and `CubeCamera` (`/cube-camera`, a cube render target). The root entry
does not change.

```ts
import {Reflector} from 'margoengine/environment/reflector';
import {Refractor} from 'margoengine/environment/refractor';
import {CubeCamera} from 'margoengine/environment/cube-camera';
import {EngineKernel} from 'margoengine/core';
import {Environment, EnvironmentLighting} from 'margoengine/environment';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
// A flat normal map (RGBA8, +Z up); any width x height of RGBA bytes works.
const ripples = {width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255])};

const mirror = Reflector.attach(engine, {width: 4, height: 3, color: '#e8e8e8'});
mirror.node.setPosition([0, 1.5, -2]);           // the mirror is a core mesh node: move, rotate, scale, parent it
mirror.roughness = 0.2;                           // blur; normalMap + distortion ripple it

const water = Refractor.attach(engine, {width: 20, height: 20, normalMap: ripples, normalScroll: [0.02, 0.01]});
water.node.setRotation([-Math.PI / 2, 0, 0]);     // local XY plane, facing +Z: lay it flat facing up

const cube = CubeCamera.attach(engine, {size: 128, position: [0, 1, 0], mips: true});
cube.update();                                    // six faces now; or {facesPerFrame: 1..6} to keep it current
// cube.texture (rgba16float, 6 layers) and cube.view (dimension 'cube') are standard cube maps.
const environment = await Environment.create(engine, cube);   // image-based lighting from the capture
EnvironmentLighting.attach(engine, environment);
cube.update();
await environment.refresh();                      // later: capture again and reprocess in place
```

`MeshReflector` (from `@margoengine/environment/reflector-pbr`, drei's MeshReflectorMaterial) draws the reflection
over a flat mesh's own lit surface instead of replacing it: each pixel keeps (1 - w) of the mesh's colour and adds the
mirrored scene times w, where w is the Schlick Fresnel reflectance of `f0` (default 0.04), raised toward 1 by `mirror`
(0 to 1, default 0), times `mixStrength` (default 1), clamped to 1. `blur` ([x, y] capture pixels, default [0, 0]) box
blurs the image and `mixBlur` (default 1) sets how much of the blur shows; `depthScale` (default 0, off) turns a
reflected point's distance from the plane into a depth that fades and blurs it between `minDepthThreshold` (0.9) and
`maxDepthThreshold` (1), plus `depthToBlurRatioBias` (0.25) of blur everywhere; `mixContrast` (1) is a contrast about
linear 0.5; `reflectorOffset` (0) moves the mirror plane along the normal without moving the surface; `normalMap` and
`distortion` ripple it as on `Reflector`. Parent it to the mesh, match its size and leave the mesh out of the capture:

```ts
import { Engine, Geometry, PbrMaterial } from '@margoengine/core';
import { MeshReflector } from '@margoengine/environment/reflector-pbr';

const engine = await Engine.create(document.querySelector('canvas')!);
const quad = new Geometry([-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3]);
const floor = engine.createMesh().setGeometry(quad).setMaterial(new PbrMaterial({ color: [0.3, 0.3, 0.3] }));
floor.setRotation([-Math.PI / 2, 0, 0]);          // the quad's +Z side faces up
MeshReflector.attach(engine, { parent: floor, width: 10, height: 10, exclude: [floor], mixStrength: 2, blur: [16, 4] });
engine.start();
```

**Rough reflections with contact hardening.** `contactHardening: true` on `Reflector`, `Refractor` or `PBRReflector`
reads `roughness` as the surface's perceptual (GGX) roughness and blurs each pixel by the reflection cone it covers:
sharp where a chair leg meets a polished floor, blurrier the farther the reflected point is from the surface, the far
background blurriest. Without it (the default), `roughness` stays one blur for the whole surface (0 sharp, 1 the
coarsest mip). `reflectionConeTangent(roughness)` and `reflectionConeLevel(roughness, distance, pixelsPerUnit,
maxLevel)` (from `/reflector`) are the same maths on the CPU.

```ts
import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { Reflector, reflectionConeLevel } from '@margoengine/environment/reflector';
import { PBRReflector } from '@margoengine/environment/reflector-pbr';

const engine = await EngineKernel.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: { position: [0, 2.5, 9], target: [0, 0, 0] },
});
engine.createMesh().setGeometry(box(0.2, 2, 0.2)).setMaterial(new PbrMaterial({ color: '#ffffff' })).setPosition([0, 1, 0]);
// A glossy dark floor: sharp at the post's foot, soft toward its top.
const floor = PBRReflector.attach(engine, { width: 20, height: 20, roughness: 0.3, contactHardening: true, baseColor: '#202020' });
floor.node.setRotation([-Math.PI / 2, 0, 0]);
// A mirror on the wall with the same cone; roughness 0 stays a perfect mirror.
const mirror = Reflector.attach(engine, { width: 3, height: 2, roughness: 0.15, contactHardening: true });
mirror.node.setPosition([0, 1.5, -3]);
console.log(reflectionConeLevel(0.3, 1, 100, 7)); // mip read 1 world unit from the floor at 100 texels per unit
engine.start();
```

How it works. GGX alpha = roughness² (Karis 2013) used as a Beckmann width gives the Phong exponent
n = 2 / alpha² - 2 (Walter et al. 2007); the cone around the half vector that holds 3/4 of the cosⁿ lobe has
cos^(n+1) = 1/4, and the reflected cone is twice that angle (capped at 1.4 rad, reached near roughness 0.76). The cone
idea for screen-space reflections is Uludag's (GPU Pro 5, 2014). Per pixel, the capture depth under the lookup (the
nearest of its 2x2 texels) gives the distance s along the reflected ray to what the pixel shows; the cone covers a disc
of diameter 2 s tan(angle) there, and the mip whose texel spans that disc in the capture is read (trilinear in the
box-filtered chain). A contact (s = 0) reads mip 0. `PBRReflector`'s `blurDistance` ramp is replaced by the cone, and
`Refractor` uses the distance behind the glass. `MeshReflector` keeps drei's own depth blur (`depthScale` and its
thresholds) and rejects `contactHardening`. Water's planar reflection takes the same cone (`@margoengine/water/reflector`,
`contactHardening`). Sources: Brian Karis, *Real Shading in Unreal Engine 4*, SIGGRAPH 2013 course notes,
https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf ; Bruce Walter, Stephen R.
Marschner, Hongsong Li and Kenneth E. Torrance, *Microfacet Models for Refraction through Rough Surfaces*, EGSR 2007,
https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf ; Yasin Uludag, *Hi-Z Screen-Space Cone-Traced
Reflections*, in W. Engel (ed.), GPU Pro 5, CRC Press, 2014, https://www.routledge.com/product/isbn/9781482208634 . Limits: the blur is
the capture's 2x2 box mip chain (at most 8 levels, so a footprint over 128 capture texels stops growing), isotropic
(no stretching along the view), and the level steps where depth changes sharply (an object's silhouette against the
far background); a normal-map distortion moves the lookup but not the ray the distance is measured on.

- **How a capture runs.** `engine.render({camera, delta: 0})` through the capture camera, with a filtered copy of the
  frame graph: only the scene passes run (`scenePasses`: order below -110, or from -25 up to 9: GPU culling, sky, shadow
  maps, clustered light lists, shader patches, core's main draw, glTF PBR, terrain, water, decals, transmission).
  Post-processing (TAA, PostStack, SSAO, bloom, DOF, tone mapping, FXAA), overlays and labels do not run, so TAA's
  history and auto exposure never see the capture camera. The output is linear radiance (core's display transform is
  removed for the capture, as post effects do). Each capture is culled against its own camera, so meshes the main
  camera culls (behind it, say) still appear. Pass `passes: (pass) => boolean` to choose differently.
- **Reflector**: a `width` x `height` rectangle in its `node`'s local XY plane, reflecting on the +Z side. The capture
  camera is the main camera mirrored in the plane (position, target and up), with the main camera's projection
  (perspective, or `CameraProjection`'s orthographic) made oblique so that its near plane is the mirror plane (Lengyel,
  "Modifying the Projection Matrix to Perform Oblique Near-Plane Clipping", JGT 2005): nothing behind the mirror shows.
  The surface samples the image with projective texture coordinates from the capture camera's matrix, so TAA's jitter
  and MSAA apply to the surface like any mesh. Seen from behind, it draws nothing (put a box behind it as its back).
- **Refractor**: the same rectangle seen through: the capture camera is the main camera with the near plane on the
  surface, keeping only what lies beyond it (from either side). Tint and normal-map distortion; no IOR bending.
- **Options** (both, all live properties except `parent`, `order`, `name`): `width`, `height` (1), `color` (tint, white),
  `resolution` (capture size as a fraction of the canvas, 1), `clipBias` (world distance the clip plane moves into the
  captured side, 0), `roughness` (0..1, a box-filtered mip chain of the capture, 0), `normalMap` (`(device) =>
  GPUTexture`, made again after a device restore; a `GPUTexture`, dropped and reported once after a restore; or RGBA8
  pixels), `distortion` (0.03 screen fractions per unit normal), `normalRepeat` ([1, 1]), `normalScroll` ([0, 0] repeats
  per second), `layers` (every layer), `exclude` (meshes), `autoUpdate` (true: captures in an `engine.onFrame` callback
  before every `engine.start()` frame; with your own `engine.render()` loop call `update()` first), `passes`, `order`
  (surface draw order, 1). `texture` is the latest capture, `camera` the capture camera.
- **Film time**: `surface.advanceTime(delta)` moves the `normalScroll` clock (`surface.time`) without drawing, and
  `fog.advanceTime(delta)` moves the fog's `wind` drift (`fog.time`). Each frame update runs them once, however many views
  draw (before 2026-11-16 the draw pass moved them, which a seek does not run), so `seek` from
  `@margoengine/cutscene/seek` starts a film scene where a continuous run is.
- **CubeCamera**: six 90-degree face cameras at `position` render into `texture` (`rgba16float`, `size` x `size`, 6
  layers, all mips with `mips: true`) in the standard WebGPU face layout (a face is captured, then copied into its layer
  flipped in x, since cube faces are mirror images of a right-handed camera's view). `update(faces = 6)` renders the
  next `faces` faces now; `facesPerFrame` (0..6) renders that many before every `engine.start()` frame. `near`, `far`,
  `layers`, `exclude` and `passes` as above. `background` (default none) is drawn by the faces in place of the scene's
  background passes (those of EnvironmentBackground, ImageBackground and ColorBackground), at the first one's order or
  0.5: an `EnvironmentBackground`, `ImageBackground` or `ColorBackground` used through `record` without `engine.use`,
  so the main view keeps its own (drei's CubeCamera `envMap`). `version` changes when a device restore replaces `texture`. Structurally a
  `{texture, view}` cube map. `Environment.create(engine, cube)` copies its level 0 and processes it like `CubeFaces`
  (mips, prefiltered specular, SH, BRDF LUT); `environment.refresh()` reprocesses an updated capture into the same
  textures, so bind groups stay valid (`version` unchanged). After a device restore a `CubeCamera` source gives the new
  device's texture and the environment is rebuilt from it. A plain `{ texture }` belongs to the device that made it: it is
  dropped, `engine.onError` hears of it once ([#borrowed-lost](https://margoengine.com/errors#borrowed-lost)), the
  environment reads as restoring (`device` is null, so `EnvironmentLighting` binds none) and the frame keeps drawing;
  `await environment.setSource({ texture: newCube })` (second argument: the device or engine, default the engine it is
  attached to) processes the new texture. A source object whose `texture` getter returns the current device's texture
  works the same as a `CubeCamera`.
- **Layers**: `layers` is a 32-bit mask read from `@margoengine/cameras/layers` (`setRenderLayers`); meshes outside it,
  and `exclude`d meshes, are hidden (`mesh.visible`) for the capture only. Without that module every mesh is on layer 0.
- **Cost**: each capture is a full scene render (shadow maps included) at the capture size; a cube camera is six.
- **Limits**: WebGPU and the installed WebGL2 compatibility layer; the native preview throws linked `unsupported`. Captures are sequential renders before the frame, not nested passes: `update()` from inside a
  frame pass throws (core rejects nested renders). Scene passes that keep canvas-sized targets (transmission's opaque
  copy, selection's 1x ID buffer) are re-sized by captures of another size; keep `resolution: 1` with them. Another
  mirror seen in a capture shows its previous frame's image (one bounce per frame). A cube capture of a mirror shows the
  mirror's image for the main camera. The capture camera follows the main camera at the moment of capture: an
  `onFrame` callback registered after the surface that moves the camera shows one frame late (register it first, or
  call `update()` yourself). `Environment.refresh()` needs the environment created from the GPU cube with `keepSource`
  (default) and the same size; after a device loss, update the cube camera and refresh again.

Captures use their own viewport and restore the outer view, including when a scene background creates
an explicit canvas view or the canvas resizes. Roughness mip reductions use four explicit texel reads,
with nearest binary16 rounding before storage so attachment rounding does not introduce a dark bias.
The real-product floor check in `packages/studio/test/floor-browser.mjs` proves every mip component
against independent 2x2 means within half-float rounding, exact tie/subnormal/maximum probes, resize,
empty captures and every restored display pixel on WebGPU and WebGL2 compatibility. This is image blur,
not a GGX rough-surface transport model. The reflection and clipping API examples above are unchanged.
- **Checked on a real GPU** (`scripts/env-mirror-gpu-check.js`, NVIDIA Ampere, Edge/Chromium 155, 1x and 4x MSAA): mirror
  pixels against core drawing the scene reflected in the mirror plane (light reflected too, no mirror): mean 0.15 and
  99th percentile 4 of 255 at 4x (edges inside the reflection resolve MSAA before tone mapping), max 1 at 1x; same for an
  orthographic camera; a box behind the mirror changes no capture texel (control: `clipBias: -1` lets it in); glass
  against the scene drawn without it: mean 0.06 and 99th percentile 1 at 4x, max 1 at 1x; a box between eye and glass
  changes no capture texel; with TAA, a box moved under accumulated history converges to the image of a fresh history
  (mean 0.07, max 6 of 255); hidden surfaces leave the frame byte-identical; cube faces hold the expected linear colours (within 0.0003) in the
  standard orientation; an `Environment` from the cube follows the box colours and `refresh()` updates it in place.

### Lightformer

`Lightformer` (`@margoengine/environment/lightformer`) is an emissive studio card for environment captures, as drei's:
`form` `'rect'` (1 x 1, the default), `'circle'` (1 across), `'ring'` (1 across, open inside radius 0.25) or `'box'`
(1 x 1 x 1), in its `node`'s local frame (cards lie in XY and show from both sides; scale the node to size it).
It is unlit and emits `color x intensity` (`color` default white, `intensity` default 1, finite and >= 0; both live,
as is `form`): linear on HDR targets, which every capture is, and through the display transform on the canvas. Place
it with `node` and capture it with a `CubeCamera` into an `Environment` (image-based lighting as in P. Debevec,
"Rendering Synthetic Objects into Real Scenes", SIGGRAPH 1998, https://doi.org/10.1145/280814.280864); a hidden node
or intensity 0 draws nothing. Other options: `parent` (default the scene root), `order` (frame-graph order, default 1,
inside the capture's scene passes) and `name` (`'lightformer-N'`). WebGPU and the WebGL2 compatibility layer.

```ts
import {Engine} from 'margoengine';
import {Environment} from 'margoengine/environment';
import {CubeCamera} from 'margoengine/environment/cube-camera';
import {Lightformer} from 'margoengine/environment/lightformer';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
// A 4 x 4 softbox 3 units along +X, turned to face the origin.
const softbox = Lightformer.attach(engine, {intensity: 5});
softbox.node.setPosition([3, 0, 0]).setRotation([0, -Math.PI / 2, 0]).setScale([4, 4, 1]);
const cube = new CubeCamera({size: 256, near: 0.1, far: 100});
engine.use(cube);
cube.update(6);
softbox.node.visible = false; // lights the scene through the environment only
const environment = await Environment.create(engine, cube);
engine.use(environment);
```

Checked on a real GPU (`npm run test:lightformer:browser`, WebGPU and `MARGO_COMPAT=1`): each form writes exactly
`color x intensity` where it covers and 0 elsewhere (circle corners and the ring's hole open), hidden or intensity 0
draws nothing, a captured softbox lights the environment's irradiance from its side (1.84 toward it against 0.07 away)
and `refresh()` after doubling the intensity doubles it (within 1%).

## Display P3 and HDR output

Input colours can be Display P3 too: every environment colour (`Fog`, `ColorBackground`, `HemisphereLight`...) takes CSS `'color(display-p3 r g b)'` (math's `parseColor`), whose linear sRGB channels stay negative outside sRGB, so materials and lights carry the wide-gamut colour through Tonemap's excess output to a P3 canvas. A background colour outside sRGB is clipped on an sRGB canvas.

```ts
import {Engine} from 'margoengine/core';
import {ColorOutput} from 'margoengine/environment';
import {Tonemap} from 'margoengine/tonemap';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const output = ColorOutput.attach(engine); // defaults: {gamut: 'p3', hdr: true, peak: 4}
Tonemap.attach(engine, {curve: 'neutral'}); // HDR highlights and colours outside sRGB come from Tonemap
console.log(output.gamut, output.hdr); // what the canvas actually is: 'srgb' | 'p3', true | false
```

One class for both because they share one canvas configuration (`format`, `colorSpace` and `toneMapping` are one
`configure()` call; two plugins would overwrite each other) and one output pass.

**What "on" means.** Each feature turns on only when the display reports it (`matchMedia('(color-gamut: p3)')`,
`matchMedia('(dynamic-range: high)')`; `force: true` skips the queries) and the browser keeps it (checked with
`getConfiguration()`). Otherwise nothing happens: no configure call, no pass, the GPU calls are those of an engine
without the plugin.
- **P3 on**: the canvas is `colorSpace: 'display-p3'` and the final pass converts the engine's working space (linear
  sRGB / Rec.709 primaries) to linear P3 before the sRGB transfer function. sRGB-authored content therefore looks the same
  as on the sRGB canvas (measured: 0 to 1 eight-bit P3 units apart) - P3 does not make sRGB colours more saturated,
  which would be wrong. What it adds is room for colours outside sRGB: linear Rec.709 values with negative components
  (a P3-authored texture or colour converted into the working space, an external HDR `source`), which Tonemap clips to
  the P3 gamut instead of the sRGB gamut. Core's own shader, materials and hex colours are sRGB, so without such input
  a scene looks identical either way.
- **HDR on**: the canvas is `rgba16float` with `toneMapping: {mode: 'extended'}`, so values above 1 (SDR white) reach the
  display, up to what it can show. Tonemap's curves stay the SDR ones below the 0.76 knee; above it Khronos PBR
  Neutral's highlight rolloff aims at `peak` (relative to SDR white, 1 to 16, default 4) instead of 1, and AgX/ACES are
  scaled by the same rolloff ratio of the brightest channel. `peak: 1` gives the SDR curve. There is no web API for the
  display's real headroom; set `peak` for the target display (values above its headroom are clipped by the browser).

**How it works.** Core configures the canvas and draws into `getCurrentTexture()` (into its 4x target, resolved to that
texture). ColorOutput reconfigures the same context, merging with `getConfiguration()` so TransparentCanvas's
`alphaMode` and any `usage` survive (TransparentCanvas now merges the same way, so either attach order works). It
replaces `getCurrentTexture` on that context object with an offscreen texture in the preferred canvas format, so core
and every package keep drawing exactly what they drew before (sRGB-encoded, canvas format). At order 1e5 it resolves
core's multisampled target into that texture and draws one full-screen pass into the real canvas texture: decode sRGB,
add Tonemap's excess, convert to P3, clamp to 0..1 (SDR) or 0..`peak` (HDR), encode (extended sRGB transfer function on
the float canvas). Between its passes (order -1e5 to 1e5) it leaves a contract on the pass context
(`Symbol.for('margoengine.color-output')`) that Tonemap reads, alone or as a PostStack's display effect: Tonemap then
compiles an output variant of its shader that writes the SDR part to the canvas target as before and the part outside
0..1 (highlights above white, negative components outside sRGB, linear) into a 1x rgba16float excess texture. Device
restore: core reconfigures sRGB, then `onDeviceRestored` reapplies (and re-checks what the browser kept); `dispose()`
restores the sRGB/SDR canvas and the original `getCurrentTexture`.

**Cost**: one full-screen pass, a resolve when MSAA is on, a canvas-size texture in the canvas format and, with Tonemap,
a canvas-size rgba16float excess texture and a second full-screen Tonemap pass. Root entry +1,791 B min+gzip
(environment, includes the TransparentCanvas merge), tonemap +684 B (the output shader variant, compiled only under
ColorOutput); core and stage +0.

**Limits.** HDR highlights and out-of-sRGB colours come only from `Tonemap`; Bloom, SSAO, DOF alone and creative
PostProcessing tone map to 0..1 themselves, so with them the canvas is P3/HDR but the image stays SDR-range. Passes that
draw after Tonemap (FXAA, TAA, overlays) see the SDR image; the excess is added back under them, so an opaque overlay
drawn over a highlight above white is lifted by that highlight, and FXAA/TAA do not filter the excess. LUT grading
applies to the 0..1 part (the excess above 1 is added back unchanged; the out-of-sRGB part is not graded). The
out-of-sRGB part is scaled by the curve's compression of the brightest channel, not passed through the curve. SceneFade
captures the offscreen image (pre-conversion), which is also what it blends into, so it should keep working (not
tested). Creative's `Planet` and `GrassField` build canvas pipelines with `navigator.gpu.getPreferredCanvasFormat()`,
which still matches the offscreen texture (also untested). Composition with TransparentCanvas needs `getConfiguration()` (Chrome/Edge 131+); without it the
last plugin to configure wins. WebGL2 fallback: no-op (`gamut` 'srgb', `hdr` false). Display changes (moving the window
to another monitor) are not followed until the next device restore or a new ColorOutput.

**Proofs.** `packages/environment/tests/output.test.js` (fake GPU through a real core engine): on an sRGB/SDR display
the configure calls and GPU calls equal an engine without ColorOutput; P3/HDR configuration, offscreen redirect,
final pass, device restore, dispose, both attach orders with TransparentCanvas, a browser that drops `toneMapping`, and
the Tonemap contract. `examples/package-benchmarks/proofs/color-output.proof.js`: without ColorOutput, Tonemap (alone,
DOF-sourced, in a PostStack before FXAA), TransparentCanvas and ColorBackground make exactly the GPU calls of `7dcc958`
(6,174 recorded calls, 1x and 4x). Real GPU: `examples/package-benchmarks/color-output-gpu.mjs` (Edge 155 and Chrome 155,
Intel Arc 140V; results `results/color-output-gpu-{msedge,chrome}.json`). The laptop's display reports `color-gamut:
srgb` only and `dynamic-range: standard`, so `auto` stays sRGB/SDR there (and renders like no plugin); with `force` the
canvas reports the requested `display-p3` / `rgba16float` / `extended`. A Display P3 green patch (outside sRGB) reads
back through a Display P3 2D canvas as (0, 188, 0) with P3 on and (86, 188, 55) (clipped to sRGB green) with it off; a
grey highlight at 3x white reads 1.373 (extended sRGB, linear 2.07) from the float16 canvas texture and from a float16
P3 2D canvas with HDR on, 252/255 with it off; in-gamut content is 0 to 1 P3 units apart on and off; after
`rebootDevice()`, with TransparentCanvas (premultiplied) and with a Bloom + Tonemap + FXAA PostStack: same values, no
validation errors.

## RGBM and LogLuv

`@margoengine/environment/encoded-hdr` decodes HDR colour packed into 8-bit RGBA pictures, and encodes it back. `decodeRGBM(image, {maxRange, gamma})` returns linear `rgb^gamma * a * maxRange` (defaults 6 and 1; Brian Karis, "RGBM Color Encoding", 2009); `encodeRGBM(image, options)` rounds the multiplier up so the stored colour stays within 1, and values past `maxRange` clip. `decodeLogLuv(image)` and `encodeLogLuv(image)` read and write Ward's 32-bit LogLuv (Gregory Ward Larson, "LogLuv Encoding for Full-Gamut, High Dynamic Range Images", JGT 1998) as the RGBA bytes of the big-endian word `LLLLLLLL LLLLLLLL uuuuuuuu vvvvvvvv` (r and g the 15-bit log-luminance with its sign bit, b = u', a = v'), linear Rec. 709 out; use a lossless picture, as JPEG breaks the luminance bytes. `loadRGBM(bytes, {maxRange, gamma, decode, signal})` and `loadLogLuv(bytes, {decode, signal})` decode a PNG, WebP or JPEG file first (`createImageBitmap` and `OffscreenCanvas` by default; pass `decode` in Node). All return a `FloatImage` for `Environment.create`. The HDR JPEG of phones and cameras is a gain-map JPEG: `decodeHDRJPG` (the same function as `decodeUltraHDR`) reads it, and `loadEnvironmentImage` picks it by signature.

```ts
import { decodeRGBM, encodeRGBM, decodeLogLuv, encodeLogLuv } from '@margoengine/environment/encoded-hdr';

const sky = { width: 2, height: 1, data: new Float32Array([0.5, 3, 5.5, 1, 0.01, 0.02, 0.03, 1]) };
const rgbm = decodeRGBM({ ...sky, data: encodeRGBM(sky) }); // 8-bit RGBA pictures round trip to within one step
const logluv = decodeLogLuv({ ...sky, data: encodeLogLuv(sky) }); // 40 stops of range in 32 bits
console.log(rgbm.data[2].toFixed(1), logluv.data[2].toFixed(1)); // about 5.5 5.5
```

## UltraHDR

`decodeUltraHDR(bytes, {decode?, weight?})` reads gain-map JPEGs (Android UltraHDR, Adobe gain maps) with the `hdrgm` XMP metadata: `parseUltraHDR` walks the JPEG segments, takes the next JPEG stream after the primary image as the gain map, and reads `GainMapMin`, `GainMapMax`, `Gamma`, `OffsetSDR`, `OffsetHDR` and `HDRCapacityMin/Max` (single values or per-channel `rdf:Seq`) from either image's XMP. `applyGainMap` then computes `(sdr + offsetSdr) * 2^(weight * mix(min, max, gain^(1/gamma))) - offsetHdr` with the base image decoded from sRGB and the gain map bilinearly upsampled; `weight` defaults to 1 (full HDR, right for lighting). JPEG pixels come from `createImageBitmap` and `OffscreenCanvas` by default; in Node pass `decode`. `loadEnvironmentImage` picks it automatically for JPEG signatures; the synchronous `parseEnvironmentImage` cannot (JPEG decoding is asynchronous). Not supported: ISO 21496-1 binary-only metadata, HDR base renditions, and color-gamut conversion (Display P3 bases are treated as sRGB).

The parsers also work on their own, in the browser or Node:

```ts
import {parseHDR, parseEXR} from 'margoengine/environment';
const bytes = await (await fetch('/studio.exr')).arrayBuffer();
const {width, height, data} = parseEXR(bytes); // data: Float32Array RGBA, row 0 at the top
```

An EXR that names another colour space decodes to linear sRGB / Rec.709 (D65) in all three readers (`parseEXR`,
`parseTiledEXR` and `decodeEXR`). They follow the Color Interop Forum's [reading order](https://github.com/AcademySoftwareFoundation/ColorInterop/blob/main/Recommendations/04_OpenEXRFiles/OpenEXRFiles.md):

1. `acesImageContainerFlag` 1 means ACES2065-1.
2. `colorInteropID` `data` is never converted.
3. A [Color Interop ID](https://github.com/AcademySoftwareFoundation/ColorInterop/blob/main/Recommendations/01_TextureAssetColorSpaces/TextureAssetColorSpaces.md)
   names the space: `lin_ap1_scene` (ACEScg), `lin_ap0_scene`, `lin_rec709_scene`, `lin_p3d65_scene`,
   `lin_rec2020_scene`, `lin_adobergb_scene`, `lin_ciexyzd65_scene`, and the encoded `srgb_rec709_scene`,
   `g24_rec709_scene`, `g22_rec709_scene`, `g18_rec709_scene`, `srgb_ap1_scene`, `g22_ap1_scene`, `srgb_p3d65_scene` and
   `g22_adobergb_scene` (decoded to linear first). One namespace prefix (`studio:lin_ap1_scene`) is dropped if needed.
4. Otherwise (no ID, `unknown` or one not listed) other `chromaticities` are converted.

Primaries use the RP 177 matrix and a Bradford white adaptation, as `parseHDR` does for Radiance `PRIMARIES`.
`image.colorInteropID` and `image.primaries` (the `chromaticities`) report the attributes, null when absent, and
`image.primariesConverted` whether the RGB changed; luminance-only files are left as they are. `encodeEXR` writes the
attributes when you pass them:

```ts
import {parseEXR} from 'margoengine/environment';
import {encodeEXR} from 'margoengine/environment/exr-write';
const red = new Float32Array([1]), zero = new Float32Array([0]);
const ap1 = await encodeEXR({width: 1, height: 1, chromaticities: [0.713, 0.293, 0.165, 0.83, 0.128, 0.044, 0.32168, 0.33767],
  channels: [{name: 'B', type: 'FLOAT', data: zero}, {name: 'G', type: 'FLOAT', data: zero}, {name: 'R', type: 'FLOAT', data: red}]});
const image = parseEXR(ap1);
console.log(image.primariesConverted, Array.from(image.data.subarray(0, 3), (v) => v.toFixed(3))); // true ['1.705', '-0.130', '-0.024']
const named = parseEXR(await encodeEXR({width: 1, height: 1, colorInteropID: 'lin_ap1_scene',
  channels: [{name: 'B', type: 'FLOAT', data: zero}, {name: 'G', type: 'FLOAT', data: zero}, {name: 'R', type: 'FLOAT', data: red}]}));
console.log(named.colorInteropID, named.primariesConverted); // lin_ap1_scene true
```

### Reading tiled and mipmapped EXR

`parseTiledEXR(bytes, {levels?})` (from `@margoengine/environment/exr-tiled`, CPU only, Node or browser) reads single-part
tiled OpenEXR files as studio tools write them: one level, mipmaps or ripmaps, rounding down or up, with NONE, RLE, ZIPS,
ZIP or PIZ. It returns the full-resolution level as `parseEXR` does, plus `tiling` and `levels`; `levels: 'all'` also
decodes every lower level. Scanline files are passed to `parseEXR`, so it reads any EXR the package reads.

```ts
import {parseTiledEXR} from 'margoengine/environment/exr-tiled';
import {encodeEXR} from 'margoengine/environment/exr-write';
// A self-contained scanline input also works; replace bytes with your tiled EXR bytes.
const bytes = await encodeEXR({width: 2, height: 2, channels: [
  {name: 'Y', type: 'FLOAT', data: new Float32Array([0, 0.25, 0.5, 1])},
]});
const image = parseTiledEXR(bytes, {levels: 'all'});
console.log(image.levels.map((l) => `${l.width}x${l.height}`)); // ['2x2']
```

`parseTiledEXR` is synchronous and clean-room, and decodes every mip or rip level. It refuses PXR24, B44, B44A, DWAA
and DWAB; `decodeEXR` from `@margoengine/environment/exr-codecs` (asynchronous, a worker with the prebuilt OpenEXR
decoder) reads those and the full-resolution level of tiled files.

### Writing EXR

`encodeEXR` (from `@margoengine/environment/exr-write`, CPU only, Node or browser) writes any named channels as a
single-part scanline EXR, row 0 at the top. `compression` is `'NONE'` (default), `'ZIPS'` (zlib, one line a chunk) or
`'ZIP'` (zlib, 16 lines a chunk, usually the smallest); all three are lossless, and the zlib ones need
`CompressionStream` (current browsers, Node 18+). HALF and FLOAT take a `Float32Array`, UINT a `Uint32Array`;
`offset` and `stride` pick one lane of interleaved data. Channels are stored in name order; dotted names are layers.

```ts
import {encodeEXR} from 'margoengine/environment/exr-write';
import {parseHDR} from 'margoengine/environment';
const [width, height] = [640, 360];
const rgb = new Float32Array(width * height * 3), depth = new Float32Array(width * height);
const ids = new Uint32Array(width * height), signal = new AbortController().signal;
const exr = await encodeEXR({width, height, channels: [
  {name: 'R', type: 'HALF', data: rgb, offset: 0, stride: 3},
  {name: 'G', type: 'HALF', data: rgb, offset: 1, stride: 3},
  {name: 'B', type: 'HALF', data: rgb, offset: 2, stride: 3},
  {name: 'depth.Z', type: 'FLOAT', data: depth},
  {name: 'id', type: 'UINT', data: ids},
]}, {compression: 'ZIP', nonFinite: 'preserve', signal});
```

FLOAT and UINT keep their exact bits; HALF rounds to nearest even and refuses finite values above 65504 (use FLOAT).
NaN or infinity throws unless `nonFinite: 'preserve'`. Limits: 16,384 pixels a side, 2^26 pixels, 64 channels,
names of 1 to 31 printable ASCII characters, and `maxBytes` (default 256 MiB, at most 512 MiB) for the whole file
(a compressed file is checked as its chunks are written; a chunk that does not shrink is stored raw).
It yields to the event loop after about 10 ms of encoding, reports `onProgress(done, total)` and stops on `signal`.

### Bounded Radiance HDR import

`parseHDR(bytes, options)` decodes into linear floats with the bounds and orders an importer needs. Without options it
behaves as it always has (RGBA, `-Y h +X w` or `+Y h +X w`, other orders refused).

```ts
const bytes = new Uint8Array(await (await fetch('/studio.hdr')).arrayBuffer());
const image = parseHDR(bytes, {
  channels: 3, // RGB triples instead of RGBA
  orientation: 'all', // also mirrored X (-X) and the X-major, column-scanned orders (+X w -Y h ...)
  requireFormat: true, // refuse a file without FORMAT=32-bit_rle_rgbe instead of assuming RGBE
  limits: { maxBytes: 128 << 20, maxWidth: 4096, maxHeight: 2048, maxPixels: 4096 * 2048, maxHeaderBytes: 32768 },
});
image.diagnostics; // {format, orientation: '-Y 512 +X 1024', scanAxis: 'X', scanlines: {flat, legacyRLE, planarRLE}, headerBytes, trailingBytes}
```

Every scan order lands as row 0 at the top and column 0 at the left. Bounds are checked from the header, before the image
is allocated; a file can never claim more scanlines than it has bytes for. Errors say what and where: exceeded bounds
throw RangeError; XYZE (`32-bit_rle_xyze`), other formats, a missing FORMAT with `requireFormat`, and orders refused by
`'standard'` throw MargoError `'unsupported'` naming the fix; damaged data throws MargoError `'failed'` with the scanline
and byte offset (`Invalid HDR: bad run at scanline 3 (byte 1234)`). Header lines are at most 8,192 bytes and the header
1 MiB by default. Margo Voxel Studio's importer is this call (its profile is in `tests/hdr.test.js`): 42,000 generated
and corrupted files decoded bit for bit as its own decoder did, or were refused by both.

## How it works

- **Parsers.** `parseHDR` reads Radiance `32-bit_rle_rgbe` files with adaptive run-length, flat and old-style run scanlines, in `-Y h +X w` or `+Y h +X w` orientation (every Radiance scan order with `orientation: 'all'`). `parseEXR` reads single-part scanline OpenEXR with NONE, RLE, ZIPS, ZIP and PIZ compression and HALF, FLOAT or UINT channels, using R, G, B and A, or Y for luminance-only files. ZIP uses a built-in synchronous inflate; PIZ is the full Huffman, wavelet and LUT pipeline. Both return linear float RGBA (alpha 1 when absent) and bounds-check every read: truncated or corrupt files throw MargoError `'failed'` (EXR features it does not decode `'unsupported'`, exceeded bounds RangeError), never read out of range. Images are capped at 2^26 pixels.
- **Source cube.** The equirect is uploaded as rgba16float, or as rgba32float when the device has `float32-filterable` enabled, since only then can float32 be filtered. NaN, infinite and negative texels carry no finite energy and are stored as 0. A compute pass resamples it into an rgba16float cube (with up to 4x4 supersampling when the equirect is much larger than the cube), followed by a box-filtered mip chain down to 1x1. Six `CubeFaces` can be passed instead.
- **Bright sources.** Half floats stop at 65,504, and an unclipped sun is often 10^5 to 10^7. When the brightest finite texel of the equirect or `CubeFaces` is above 60,000, every RGB texel is divided by `radianceScale` = peak / 60000 (a float32) before upload, so the cube, the prefilter and the SH stay finite and keep the sun's energy; lighting multiplies it back (`paramsBuffer` w is `intensity * radianceScale`, and `irradianceAt`, the background, `EnvironmentBlend`, baked KTX2 files and materials' `envMap` all apply it). `radianceScale` is 1 for anything dimmer, so those environments are unchanged. Stored values keep half-float precision (2^-11 relative); a texel about 10^9 times dimmer than the peak (60,000 against the smallest normal half float, 6.1e-5) falls into the half-float subnormals and loses precision. Code reading `cubeTexture`, `specularTexture`, `equirectTexture`, `shBuffer` or `sh` itself multiplies by `radianceScale`:

  ```js
  import { Environment } from '@margoengine/environment';

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter required');
  const device = await adapter.requestDevice();
  const data = new Float32Array(64 * 32 * 4).fill(1);
  data.set([1e6, 1e6, 1e6, 1], (10 * 64 + 40) * 4); // a sun texel
  const environment = await Environment.create(device, { width: 64, height: 32, data });
  console.log(environment.radianceScale); // 16.666666 (1e6 / 60000)
  const ambient = environment.sh.radiance[0] * environment.radianceScale; // L0 radiance, sun included
  ```
  `environment.storedPeak` is the largest RGB value the textures hold in stored units (exact for an equirect or `CubeFaces`, 65,504 for a GPU texture or a baked file). `EnvironmentBlend` sums its sources' weighted peaks and, past 65,504, divides its own output down to 60,000 the same way, so two unscaled sources at `intensity` 2 cannot overflow.
- **Specular prefilter.** Mip `m` of the specular cube is the GGX-prefiltered source for roughness `m / (specularMips - 1)`, with N = V = R (Karis split sum). Each importance sample reads the source mip whose texel solid angle matches the sample's solid angle (filtered importance sampling), so small bright sources do not produce fireflies at 256 samples. Mip 0 is the unblurred source. This runs as a fragment pass per face and mip.
- **Irradiance.** A single 64-thread compute workgroup projects the cube (the mip of at most `shSize` texels) onto the nine real L2 spherical harmonics with exact per-texel solid angles. The result is read back once, so `environment.sh` is also available on the CPU.
- **BRDF LUT.** A compute pass integrates the split-sum scale and bias with the same GGX distribution and separable Smith-GGX visibility as core's direct lighting. It is a storage buffer, not a texture, so IBL costs one of the 16 sampled textures WebGPU guarantees per shader stage (a physical glTF material with every lighting package needs all 16; see the gltf/pbr README, "Texture bindings"). It depends only on `brdfSize` and `brdfSamples`, so the environments of one device with the same pair share one, filled once and freed with the last of them: a second environment, or a `create` that replaces one still alive, skips the pass. Nothing is shared across devices. Every cell of the default 128 x 128 LUT matches an f64 integration of the same 512 Hammersley samples within its f16 rounding plus 3e-4, the smooth rows included (`npm run test:browser`).
- **Background.** A full-screen triangle at reversed-Z depth 0 with a read-only `greater-equal` depth test runs after core's main pass (order 1), so it only touches pixels whose depth still holds the cleared 0 and never covers geometry. It samples the equirect (sharpest), the source cube, or a prefiltered mip when `blur > 0`. Output matches core's shader: Khronos PBR Neutral then the exact sRGB encode into the canvas format; when the pass target is rgba16float (for example creative's `PostProcessing` HDR capture) it writes linear radiance instead. Steady frames allocate nothing.
- **Device loss.** The CPU source is kept by default. As a plugin (or through the background plugin) the environment rebuilds on the new device in `onDeviceRestored`; `version` increments and `onChange` listeners fire, so consumers can rebuild bind groups. A failed rebuild reaches `engine.onError` once; one whose device is lost while it runs rejects `restore()` with a `MargoError` (`failed`) that the plugins do not report, since the restore onto the next device rebuilds it. Nothing touches `window`, `document`, `navigator` or GPU globals at import time.

## What an IBL shader needs

Five bindings, any group and binding numbers. `iblLayoutEntries(firstBinding)` and `iblBindGroupEntries(environment, firstBinding)` build them, and `IBL_WGSL` provides the functions below.

| Binding | WGSL type | Resource | Format |
| --- | --- | --- | --- |
| specular | `texture_cube<f32>` | `environment.specularView` | rgba16float, `specularMips` mips (filterable float) |
| sampler | `sampler` (filtering) | `environment.sampler` | trilinear, clamp-to-edge |
| BRDF LUT | `var<storage, read> array<u32>`, named `iblBrdf` | `environment.brdfLut` | `brdfSize`² u32, row-major, each `pack2x16float(scale, bias)` |
| SH | `var<uniform> array<vec4f, 9>` | `environment.shBuffer`, offset 0, size 144 | 9 x vec4f, rgb used |
| params | `var<uniform> vec4f` | `environment.paramsBuffer` | (cos rotation, sin rotation, specularMips - 1, intensity * radianceScale) |

- **Rotation.** The environment is rotated by `rotation` radians about +Y. Rotate every world lookup vector `d` with `iblRotate(d, params)`: `(c * d.x - s * d.z, d.y, s * d.x + c * d.z)` with `c, s = params.x, params.y`.
- **Roughness to mip.** With `x = clamp(perceptualRoughness, 0, 1) * (specularMips - 1)` (`roughness * params.z`) and `k = min(floor(x), max(params.z - 1, 0))`, `lod = k + (x * x - k * k) / (2 * k + 1)`, sampled with `textureSampleLevel(specular, sampler, iblRotate(reflect(-v, n), params), lod)`. Mip `k` holds roughness `k / (specularMips - 1)`, so this mixes the two mips around the roughness by GGX alpha (roughness squared, the lobe width, as in core) rather than by roughness, which widened low-roughness lobes (0.045 took 22.5% of the 0.2 mip with 6 mips; now 5.06%). `iblPrefiltered` does this.
- **BRDF LUT.** Read at `(NdotV, perceptualRoughness)` (entry `(x, y)` holds `((x + 0.5) / size, (y + 0.5) / size)`); `iblBrdfTerms(nv, roughness)` filters it bilinearly with clamp to edge, as a texture sampler would. It reads the binding by its name `iblBrdf`, since WGSL cannot pass a storage array to a function. Split-sum specular is `prefiltered * (F0 * scale + bias)`.
- **SH irradiance.** The uniform holds diffuse-ready coefficients `c_k` (irradiance divided by PI), so for a unit rotated normal `n`:

  `diffuse = albedo * max(0, sum_k c_k * Y_k(n))`

  with `Y_0 = 0.282094792`, `Y_1 = 0.488602512 n.y`, `Y_2 = 0.488602512 n.z`, `Y_3 = 0.488602512 n.x`, `Y_4 = 1.092548431 n.x n.y`, `Y_5 = 1.092548431 n.y n.z`, `Y_6 = 0.315391565 (3 n.z^2 - 1)`, `Y_7 = 1.092548431 n.x n.z`, `Y_8 = 0.546274215 (n.x^2 - n.y^2)`. The plain radiance projection `L_k` is at byte offset 256 of the same buffer (and in `environment.sh.radiance`); `c_k = L_k * A_l / PI` with `A_l / PI = 1, 2/3, 1/4` for bands 0, 1, 2.
- **Combined.** `iblShade(specular, sampler, sh, params, n, v, baseColor, metalness, roughness, dielectricF0, dielectricF90)` returns `(diffuse * (1 - F) * (1 - metalness) + prefiltered * F) * intensity` with `F = F0 * scale + F90 * bias`, `F0 = mix(dielectricF0, baseColor, metalness)` and `F90 = mix(dielectricF90, 1, metalness)`. Pass `vec3f(0.04), 1.0` for a plain metal/rough material; gltf/pbr passes the F0 and F90 that `KHR_materials_ior` and `KHR_materials_specular` set. It outputs linear radiance; tone map like core.
- **Conventions.** Cube layers are +X, -X, +Y, -Y, +Z, -Z (WebGPU). Equirect `u = 0.5 + atan2(d.x, -d.z) / 2PI` (image center faces -Z), `v = acos(d.y) / PI` (row 0 is +Y).

## Options

`Environment.attach(engine, source, options)` resolves once the IBL is built and the environment is attached (it then rebuilds itself after a device loss); `Environment.create(engineOrDevice, source, options)` builds one without attaching it, for example on a bare `GPUDevice`. `EnvironmentLighting.load(engine, urlOrSource, options)` does the whole IBL setup in one call (`loadEnvironmentImage` for a URL, `Environment.attach`, `EnvironmentLighting.attach`) and resolves with the lighting, whose `dispose()` also removes that environment; it takes the options below plus `decode`/`weight` (UltraHDR) and `signal`, and rejects with `AbortError`, attaching nothing, when `signal` aborts or the engine is disposed first (the stage's `addEnvironment(stage, source)`, from `margoengine/stage/environment`, calls it). Options:

| Option | Default |
| --- | --- |
| `size` | Source cube edge (power of two). Equirect width / 4 rounded down to a power of two, clamped to 16..1024. Cube faces: their size |
| `specularSize` | `min(256, size)` |
| `specularMips` | Down to 8 px, at least 2 (256 gives 6 mips) |
| `samples` | 256 GGX samples per prefiltered texel |
| `brdfSize`, `brdfSamples` | 128, 512 |
| `shSize` | 64 (largest source mip integrated for SH) |
| `float32` | true: upload the equirect as rgba32float when `float32-filterable` is enabled |
| `keepEquirect` | true: keep the equirect texture for the sharp background |
| `keepSource` | true: keep CPU data so device restore can rebuild |
| `rotation`, `intensity` | 0 radians, 1 (also settable later) |
| `name` | `'environment'` (plugin name) |

`EnvironmentBackground.attach(engine, environment, options)` (the class is also exported as `Skybox`):

| Option | Default |
| --- | --- |
| `exposure` | 1, linear multiplier before tone mapping |
| `blur` | 0; 0..1 picks the prefiltered mip for that roughness |
| `source` | `'auto'`: equirect if kept, else cube. `'equirect'` or `'cube'` force one when `blur` is 0 |
| `rotation` | 0, added to `environment.rotation` |
| `order` | 1, frame graph order (must be above 0) |
| `name` | `'environment:background'` |

`EnvironmentBackground.record(context)` draws into any WebGPU pass context without an engine.

| Class | Options (default) |
| --- | --- |
| `EnvironmentLighting(environment, options)` | `name` (`'environment:lighting'`). Intensity and rotation come from the environment |
| `Fog(options)` | `color` (`'#ffffff'`), `near` (1), `far` (1000), `density` (0 = linear fog), `heightFalloff` (0 = off), `height` (0), `name` (`'fog'`) |
| `ColorBackground(options)` | `color` (`'#000000'`), `bottom` (none), `order` (0.5, above 0), `name` (`'background'`); `record(context)` works without an engine |
| `ImageBackground(options)` | `shape` (`'box'`, `'sphere'` or `'cylinder'`), `images` (6 faces or 1 panorama), `filter` (`'linear'`), `height` (cylinder: 2 * PI * h / w), `rotation` (0), `order` (0.5), `name` (`'background'`); `ImageBackground.load` decodes URLs and image sources |
| `TransparentCanvas(options)` | `order` (0.5), `name` (`'transparent-canvas'`) |
| `VolumetricFog(options)` (`/volumetric`) | `visibility` (23,000 m: clear air; extinction 3.912 / visibility), `density` (from `visibility`; give one), `heightFalloff` (1 / 1,200 m, or 0 with `density`), `height` (0), `color` (albedo, [1, 1, 1]), `anisotropy` (0.5), `multipleScattering` (0 m: single scattering only), `ambient` (the horizon sky with a sky, else engine ambient), `sky` (the scene's `sky` plugin; null for none), `noise` (0), `noiseScale` (8 m), `wind` ([0, 0, 0] m/s), `range` (100 m), `grid` ([160, 90, 64]), `temporal` (0.9), `shadows`, `lights`, `depth`, `volumes`, `lightning` (none; `albedo` `CLOUD_ALBEDO`, 0.8); `fog.add(model or effect)` fogs transparents |
| `DensityVolume(options)` (`/density-volume`) | `voxelSize` (0.5 m), `origin` ([0, 0, 0]) or `matrix`, `density` (1 per m), `color` ([1, 1, 1]), `maxBricks` (32,768), `maxPages` (16,777,216); `splat` `radius` (1 m), `weight` (1) |
| `FogVolumes(volumes)` (`/fog-volumes`) | per volume: `shape` (`'box'` with `min`, `max`; `'sphere'` with `center`, `radius`), `density` (0.1 per m), `color` ([1, 1, 1]), `edge` (0 m), `noise` (0), `noiseScale` (2 m) |
| `studio(options)` (`/studio`) | `width` (512), `floor` (0.12 grey), `walls` (0.3 grey), `ceiling` (0.45 grey), `horizon` (0.08 rad), `lights` (`STUDIO_LIGHTS`); per light `direction`, `width`, `height`, `intensity`, `color` ([1, 1, 1]), `softness` (0.15) |
| `ColorOutput(options)` | `gamut` (`'p3'`), `hdr` (true), `peak` (4, 1..16), `force` (false); name `'color-output'` |
| `Reflector(options)`, `Refractor(options)` (`/reflector`, `/refractor`) | `width`, `height` (1), `parent`, `color` (white), `resolution` (1), `clipBias` (0), `roughness` (0), `normalMap`, `distortion` (0.03), `normalRepeat` ([1, 1]), `normalScroll` ([0, 0]), `layers` (all), `exclude`, `autoUpdate` (true), `passes` (`scenePasses`), `order` (1), `name` (`'reflector-N'`, `'refractor-N'`) |
| `EnvironmentBlend.create(target, from, to, options)` (`/blend`) | `t` (0), `size`, `specularSize`, `specularMips` (the larger source's), `brdfSize` (128), `brdfSamples` (512), `name` (`'environment-blend'`) |
| `CubeCamera(options)` (`/cube-camera`) | `size` (256, power of two 8..2048), `position` ([0, 0, 0]), `near` (0.05), `far` (1000), `mips` (false), `facesPerFrame` (0), `layers` (all), `exclude`, `passes` (`scenePasses`), `background` (none: the scene's), `name` (`'cube-camera-N'`) |
| `Lightformer(options)` (`/lightformer`) | `form` (`'rect'`; `'circle'`, `'ring'`, `'box'`), `color` (white), `intensity` (1), `parent` (scene root), `order` (1), `name` (`'lightformer-N'`) |

### Entries without the decoders: `/main` and `/loaders`

The root re-exports two files, so a bundler that takes the root namespace keeps both. `@margoengine/environment/main` is everything the root exports except the image decoders (`Environment`, the backgrounds, `AmbientLight`, `Fog`, the lighting plugins); `@margoengine/environment/loaders` is the decoders alone (`parseHDR`, `parseEXR`, `parseUltraHDR`, `decodeUltraHDR`, `loadEnvironmentImage`). Code that reads no image file imports `/main`, and the 36 KB of decoders stay out of its build. An app that loads files pays for the formats it meets only: `@margoengine/environment/load` is `loadEnvironmentImage` alone, and it picks the decoder from the file's signature and imports it (`dist/hdr.js`, `exr.js` or `ultrahdr.js`) on first use, so an app that loads `.hdr` files never requests the EXR or UltraHDR decoders. `/loaders` and the root export the same function beside the decoders, so a bundler that keeps their static imports keeps every decoder (Vite's bundler does, even for unused ones). `parseEnvironmentImage` is synchronous and holds the HDR and EXR parsers; an app that uses it beside `loadEnvironmentImage` keeps those two parsers once, in its main chunk, and still fetches the UltraHDR decoder only for a JPEG. `@margoengine/react` does this: only `<Environment src>` fetches `/loaders`.

```js
import { Fog } from '@margoengine/environment/main';

console.log(typeof Fog); // 'function', and no decoder is in the build
```

```js
import { loadEnvironmentImage } from '@margoengine/environment/load';

console.log(typeof loadEnvironmentImage); // 'function'; a .hdr file requests the HDR decoder alone
```

## Limits

WebGPU only: `EnvironmentBackground.setup` throws on the WebGL2 backend and `Environment.create` needs a device. EXR tiled images (in the main entry; `/exr-tiled` reads them), multi-part, deep and subsampled (chroma) images and PXR24, B44, B44A, DWAA, DWAB and HTJ2K compression are rejected with an error, as are Radiance `xyze` files and, unless `parseHDR` is given `orientation: 'all'`, mirrored or transposed orientations. Huffman codes longer than 44 bits are rejected (OpenEXR writers do not produce them for normal images). `EXPOSURE`, `GAMMA` and `COLORCORR` headers are reported (`image.exposure`, `image.gamma`, `image.colorCorrection`), not applied. A Radiance `PRIMARIES` line other than sRGB / Rec.709 or the Radiance standard primaries is converted to linear sRGB (D65) with the RP 177 RGB to XYZ matrix and a Bradford white adaptation; `diagnostics.primaries` and `diagnostics.primariesConverted` report it, and colours outside sRGB keep negative components (lighting reads them as 0). OpenEXR files are converted the same way from `acesImageContainerFlag`, else a listed Color Interop `colorInteropID` (its transfer function undone first), else `chromaticities` (`image.colorInteropID`, `image.primaries`, `image.primariesConverted`). `data` and luminance-only files are not converted; OpenColorIO config names, `<config>:local:` IDs and the `_display` IDs are not resolved and fall back to `chromaticities`. Equirects larger than the device's texture limit are box-downsampled on the CPU. The diffuse term is L2 SH (no ringing suppression). `iblShade` adds back the energy single-scattering GGX loses between microfacets (Fdez-Aguera, "A Multiple-Scattering Microfacet Model for Real-Time Image Based Lighting", JCGT 8(1), 2019, https://jcgt.org/published/0008/01/03/); `iblPrefiltered` and `iblBrdfTerms` on their own are single scattering. Source and specular sizes must be powers of two.

Two portability measures are deliberate: the specular prefilter samples the cube in a fragment pass (cube sampling with explicit LOD in compute shaders returned wrong seam texels on SwiftShader), and the WGSL avoids `atan2(-0.0, x)` (SwiftShader returns PI).

## Tests

Test fixtures are required: a missing file or Git LFS pointer fails with its path and recovery command.
From the repository root, `node packages/environment/scripts/fetch-fixtures.mjs` downloads the two real
OpenEXR images at pinned hashes. Restore other tracked fixtures with `git restore -- <fixture-path>`;
`node packages/environment/scripts/make-hdr-fixture.js` regenerates the Margo HDR file.

`npm test` in `packages/environment` runs Node checks: every binary16 value round trip; 20 EXR fixtures written by the reference OpenEXR library (NONE, RLE, ZIPS, ZIP and PIZ, each with HALF RGBA, FLOAT RGB, HALF Y and a mixed HALF/FLOAT/UINT layout) decoding bit-exactly; an independent in-test EXR writer (including raw-fallback chunks, decreasing Y and stored, fixed and dynamic deflate blocks); `tests/exr-tiled.test.js`: every reference-library chunk of the 31 EXR fixtures repackaged as tiles (in file and reverse order) decodes bit-exactly as its scanline file, and Margo-written edge-tile, mipmap and ripmap files (both rounding modes, the Technical Introduction's 15 x 17 level table) decode exactly, with PXR24, B44 and DWA refused; real files `BrightRings.exr` (ZIP) and `AllHalfValues.exr` (PIZ, every half value) from the OpenEXR test images (sources in `tests/fixtures/NOTICE.md`) and the Margo-made `sun_sky.hdr` (written by `scripts/make-hdr-fixture.js`), matched against reference digests; HDR adaptive, flat and old-style runs in both orientations; truncation and random-corruption fuzzing; `tests/hdr.test.js`: all eight Radiance scan orders, RGB output, bounds before allocation, FORMAT and XYZE refusals, located damage, Margo Voxel Studio's own HDR fixtures and a 600-file generated corpus whose SHA-256 digest Studio's decoder produced; CPU SH; and SSR safety. `tests/scene.test.js` checks the scene pieces on a mock GPU: `EnvironmentLighting` and `Fog` patch core's shader as left by shadows, sky, clustered and the HDR captures, leave it untouched when not ready, on another device or disposed, follow device restores and rebuild bind entries on `environment.version`; a real glTF PBR model gets lit and fogged pipelines for opaque and blended primitives and returns to the unpatched pipelines when removed; `ColorBackground` writes exact sRGB or linear values, allocates nothing in steady frames or on resize and releases its uniform; and UltraHDR parsing (attribute and element metadata, corruption fuzzing) and gain-map math against the formula.

`tests/probes-capture.test.js` checks `addCapture` on a mock GPU: only the drawing passes replay by default, once per captured face, with the face's context (real device, `rgba16float`, no frame attachment), named passes in order, the restore with the frame's context, validation, removal and disposal. `npm run test:probe-capture:browser` checks it on a real GPU (section above). `npm run test:sky-occlusion:browser` (add `--compat` for the WebGL2 layer) checks `sky` on a real GPU: the shed under the overcast sky (Sky light indoors, above).

`tests/probes.test.js` checks LightProbes on a mock GPU: validation and buffer layout, the ambient patch on core's shader variants (with and without an environment, with a sky, terrain, clustered) and on a glTF PBR model, the bake's capture shader (rebound frame, linear output, no fog, every clustered light), its submits and dispatches, the opt-in bounded filter's bindings and atomic validation, and the CPU irradiance mirror. `npm run test:probes:browser` checks the bounded filter on a real GPU: constant HDR energy, an independent spherical integral for a directional environment including every cube seam, a rendered colored room against full-source GGX, and byte-identical sharp level 0 / volume SH. It writes `test-results/probe-samples-browser.json`. The broader real-GPU checks are `examples/package-benchmarks/probes-gpu.mjs` (README section above). `tests/probes-live.test.js` checks live capture on the mock GPU: validation, one face per frame with the prefilter on the sixth, the face budget across probes, both priorities, `refresh()` promises, a bake during live capture, pooled resources and device restoration; `examples/package-benchmarks/probes-live-gpu.mjs` measures its latency and GPU cost on a real GPU (Live capture, above).

`tests/blend.test.js` checks `rotateSH` against direct evaluation at random directions and angles and the blend's argument checks; `npm run test:blend:browser` checks the blend on a real GPU (section above) and writes `test-results/blend-browser.json`. `tests/ground.test.js` checks the ground projection's settings (height and radius as a pair, center); `npm run test:ground:browser` checks it on a real GPU (section above) and writes `test-results/ground-browser.json`. `tests/gi.test.js` checks DynamicGI's defaults, options and sweep length, and `tests/probes-live.test.js` the live volume on the mock GPU (the sweep, lighting after the first sweep, sharing a frame with live reflections, a device restore, `readback`); `npm run test:gi:browser` checks it on a real GPU (section above) and writes `test-results/gi-browser.json`. `tests/fog-volumes.test.js` checks FogVolumes' validation and buffer layout, VolumetricFog's composition with it and that without it the froxel shader is byte for byte the text before the option; `npm run test:fog-volumes:browser` checks it on a real GPU (section above). `tests/volumetric-transparent.test.js` checks `fog.add` on the mock GPU: the transparent pass after the composite, depth read only, the hook declarations, a skipped frame drawing unfogged, removers and dispose, and that without `add` the fog's shaders and uniform bytes are unchanged; `npm run test:fog-transparent:browser` checks it on a real GPU (section above). `tests/volumetric-compat-route.test.js` checks that on a WebGL2-layer device every fog compute entry point (with lights, shadows, volumes and multiple scattering) plans to the layer's GPU tier and that native WebGPU keeps the column kernel; `npm run test:fog-route:browser` (add `--compat` for the layer) checks on a real GPU that the column and per-froxel integrations store the same volume (value for value on WebGPU, within one half-float step of the layer's CPU tier on the layer). `tests/reflection-shapes.test.js` checks sphere probes' and `reflectionBlend`'s validation, the packed header (a sphere's bounding box, min.w 1, max.w its radius), moving a sphere's capture point and that box probes in order keep the shading WGSL byte for byte; `npm run test:reflection-shapes:browser` checks them on a real GPU (section above). `tests/studio.test.js` checks the procedural studio's validation, image layout, room gradient, each softbox's radiance and soft edge, the default lights and that the same options give the same bytes; `npm run test:studio:browser` checks it on a real GPU (section above). `tests/visibility.test.js` checks the volume `visibility` option, its buffer layout and that without it the shading WGSL is byte for byte the text before the option; `npm run test:visibility:browser` checks it on a real GPU: a thin wall between a sunlit side and a dark room, where the dark floor by the wall loses the light that leaked through (in the read-back CPU mirror and on screen), the sunlit side keeps its light, and the probe 1 m from the wall stores about 1 m toward it.

`tests/mirror.test.js` checks Reflector, Refractor and CubeCamera on a mock GPU: captures run only the scene passes and the full frame graph comes back, the mirror camera lands mirror points x-flipped on its near plane and clips what is behind, the glass clips what is in front, excluded and off-layer meshes are hidden only during a capture, and every cube face matches the standard WebGPU addressing after its x flip, culled against its own face. Run `npm run test:gpu:mirror --workspace @margoengine/environment` from the repository root for the real-GPU check on WebGPU and WebGL2 compatibility (65 assertions each, including TAA). Its fixture queues a canvas-texture readback before the texture expires and maps it after completion, including the first lazy compute submission.

That gate also runs `tests/capture-stability-browser.mjs`: twelve exact capture pairs after restoring a refractor's clip plane, with a negative clipping control and saved component coordinates. Later equal pairs do not clear an earlier mismatch. Add `--gpu-load=3000` to run it while a second WebGL2 canvas keeps the GPU busy: a load-dependent driver path once evaluated core's uniform-only light normalize an ulp apart, which a quiet GPU hides (`docs/known-bugs.md`).

`npm run test:browser` (a real-GPU script, not in CI) runs Chromium WebGPU checks (set `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE` and `BROWSER_ARGS` as in the repository brief): a constant environment gives constant values at every prefiltered mip and L0-only SH; a single bright direction gives SH matching both a CPU projection and the analytic delta projection, with no fireflies in the prefiltered mips; prefiltered mip 0 equals the source; the cube follows the documented face convention; GPU SH matches a CPU projection of the same cube texels; six `CubeFaces` give the same SH as the equirect; the BRDF LUT matches brute-force quadrature, the smooth-surface analytic limit and Karis's published mobile fit; the background renders the expected color in each direction (equirect, cube, rotation, exposure, blur, HDR and tone-mapped targets) and never draws over non-cleared depth; `ImageBackground` shows the predicted texel of an 8-bit image at every sampled pixel for the box (three views), the sphere (rotated, looking up) and the cylinder (default and clamped height), decoded to linear on HDR targets and returned byte for byte on the canvas, with live filter switching; `IBL_WGSL` compiles against `iblLayoutEntries` and passes a white furnace test; a real `.hdr` goes through the whole pipeline; and in a real engine the background leaves every pixel of a core mesh untouched, matches core's tone mapping elsewhere, allocates nothing in steady frames and comes back after `engine.rebootDevice()`; in a real engine `ColorBackground` writes exact bytes on cleared depth only, `EnvironmentLighting` lights a core mesh and a glTF PBR triangle with direct and ambient light off, full `Fog` turns the whole frame (including the blended triangle) into its color, and removing all three restores the original frame byte for byte; and an UltraHDR file assembled from two browser-encoded JPEGs decodes through `createImageBitmap`. Every check runs under WebGPU error scopes with zero validation errors. `tests/fixtures/generate.py` regenerates the synthetic fixtures (`pip install OpenEXR numpy`).

Apache-2.0 licensed. Test fixtures: see `tests/fixtures/NOTICE.md`.

### Attaching from a second scene

`EnvironmentLighting.load` puts its environment and lighting in the scene that was active when you called it, not the one active when the download finishes. Start it inside a second scene's plugin `setup` and the plugin belongs to that scene; start it anywhere else and it belongs to the default scene. An abort or a failure leaves nothing in either scene.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

Studio softbox directions are scaled before normalization, so
`[Number.MAX_VALUE, Number.MAX_VALUE, 0]` matches `[1, 1, 0]`.

Planar surfaces, cube captures and probe baking use the plugin's owning scene. Explicit disposal
detaches from that scene, including when another scene has a plugin with the same name. Surface,
colour and image background passes apply each view's viewport and independent scissor. Captures and
mip filters use their own full local targets. Studio softbox directions are scaled before
normalization, so `[Number.MAX_VALUE, Number.MAX_VALUE, 0]` matches `[1, 1, 0]`.

The reflection-shapes GPU proof registers each LightProbes shader fixture with
the real engine and checks owner removal before the next fixture uses its name:

```sh
npm run test:reflection-shapes:browser --workspace @margoengine/environment
```

The review56 proof compares matching partial-view frames. Two deliberate unscoped
surface controls must leak pixels; the six repaired viewport/scissor cases preserve
every outside RGB component exactly on both backends.

## Froxel fog with scene depth

```js
import { Engine, box, PbrMaterial } from '@margoengine/core';
import { Tonemap } from '@margoengine/tonemap';
import { VolumetricFog } from '@margoengine/environment/volumetric';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: { position: [3, 2, 5], target: [0, 0, 0] },
});
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#4090c0' }));
Tonemap.attach(engine);
const fog = VolumetricFog.attach(engine, { density: 0.03, grid: [160, 90, 64] });
fog.options.density = 0.04;
```

The grid is compared by its three numeric dimensions each frame, including in-place
edits. Resize and device restoration rebuild the same volume resources. Injection,
temporal reprojection, the four-tap integration and the composite keep their full
workload; this scheduling change claims no measured speed gain.
