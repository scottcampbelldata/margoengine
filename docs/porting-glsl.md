# Porting GLSL materials to Margo

`ShaderMaterial` from `@margoengine/shader/glsl-material` takes a whole GLSL ES 1.00 or 3.00 program, as the web
engines' shader materials do, and draws it on WebGPU and on the WebGL2 layer. The engine's matrices and vertex streams
reach the program under the names your engine used, chosen with `builtins`. This page maps each engine to its
`builtins` value and lists what to change when you paste a program. The package README has the full option list and a
running example.

The names below come from each engine's public documentation, cited in docs/clean-room.md ("Job 185.1 push 2").

## Which `builtins` to use

| Coming from | `builtins` | Notes |
| --- | --- | --- |
| three.js `ShaderMaterial` | `'modelViewMatrix'` | The matrices and attributes may stay undeclared, as three.js declares them for you. |
| three.js `RawShaderMaterial` | `'modelViewMatrix'` | Keep your declarations; a declared built-in name is filled by the engine unless you list it in `uniforms`. |
| Babylon.js `ShaderMaterial` | `'worldViewProjection'` | Declare the uniforms you listed in the material's `uniforms` option, as in Babylon. `uv2` is the second uv set and `color` a vec4. |
| PlayCanvas `ShaderMaterial` or `createShaderFromCode` | `'matrix_model'` | Map `vertex_texCoord0` and others with `attributes: {vertex_texCoord0: 'uv'}`. |
| Anything else | `'auto'` (default) or `false` | `'auto'` picks the convention whose names the program uses; `false` supplies nothing. |

`'auto'` refuses a program whose names belong to two conventions (for example `modelMatrix` and `matrix_view`) with
MargoError `failed` and a help link. Pick one with `builtins`, or list the names you supply yourself in `uniforms`.

## The names each convention supplies

`'modelViewMatrix'`: `modelMatrix`, `viewMatrix`, `modelViewMatrix`, `projectionMatrix`, `normalMatrix` (mat3, the
inverse transpose of the model view's upper 3 x 3), `cameraPosition`, `isOrthographic`; attributes `position`,
`normal`, `uv`, `uv1`, `color` (vec3), `tangent` (vec4), `instanceMatrix` (mat4, per instance) and `instanceColor`
(vec3, per instance).

`'worldViewProjection'`: `world`, `view`, `projection`, `worldView`, `worldViewProjection`; attributes `position`,
`normal`, `uv`, `uv2`, `color` (vec4).

`'matrix_model'`: `matrix_model`, `matrix_normal` (mat3, world space), `matrix_view`, `matrix_viewInverse`,
`matrix_view3`, `matrix_projection`, `matrix_viewProjection`, `view_position`, `camera_params` (1 / far, far, near,
1 when orthographic), `screen_size` (the whole target) and `viewport_size` (the view drawn, in a multi-view frame),
each as width, height, 1 / width, 1 / height, `view_index` (0);
attributes `vertex_position` and `vertex_normal`.

## What to change when you paste

- **Mesh.** Build the mesh with `shaderMesh(geometry, material, {instances})` and add it with `RawShaders.attach(engine)`
  and `raw.add(mesh)`. Geometry is `{positions, normals, uvs, uvs1, colors, tangents, indices}` or a core `Geometry`.
- **Clip space.** Projection matrices follow GL (clip z from -1 to 1); the material maps that onto Margo's reversed
  depth, so GLSL meshes and core meshes sort by depth together. `clipSpace: 'webgpu'` takes a program that already
  writes z from 0 to 1.
- **Colour.** GL shows the colour a program writes as sRGB on screen; so does Margo by default
  (`outputColorSpace: 'srgb'`). A program written for a linear pipeline, such as one that ends with three.js's
  `#include <tonemapping_fragment>` and `#include <colorspace_fragment>`, keeps those two lines: Margo has both chunks.
  Other three.js chunks are not built in; pass their GLSL with `includes: {name: '...'}`.
- **Render state.** `side`, `depthFunc`, `polygonOffset`, `polygonOffsetFactor`, `polygonOffsetUnits` and
  `blending: 'custom'` with `blendSrc`, `blendDst` and `blendEquation` take three.js's meanings. Babylon's
  `backFaceCulling` is `cull: 'back'` or `side: 'front'`; its `alphaMode` and `needAlphaBlending` are `transparent: true`
  with a `blending` mode.
- **Handedness.** Margo is right handed with y up, as three.js and PlayCanvas are. Babylon.js scenes are left handed by
  default, so a mesh brought over with its coordinates may appear mirrored in z; flip the mesh, not the shader.
- **Uniform shapes.** Structs, arrays of structs, uniform blocks, non-square matrices and sampler arrays take the same
  values three.js's `uniforms` take (an object per struct, a list per array), and the leaves keep GL's names
  (`lights[1].color`). Integer samplers take a `GPUTexture` of integers; shadow samplers take a depth texture, or
  `{texture, sampler}` with the sampler's `compare`.
- **Points.** A program that writes `gl_PointSize` draws squares of that size with `topology: 'point-list'`, as
  three.js's `Points` and Babylon's `pointsCloud` do; per-instance attributes on a point list are refused.
- **Flat varyings.** GL takes a flat value from each primitive's last vertex; `shaderMesh` reorders the index so Margo
  does the same. A `RawMesh` built by hand keeps WebGPU's first-vertex rule.
- **Wireframe.** `wireframe: true` as in three.js and Babylon; lines are 1 pixel wide.
- **Saving.** A saved scene keeps its ShaderMaterials when the codecs include `glslMaterialCodec(ShaderMaterial)`.
- **Post passes.** A full-screen program becomes a `ShaderPass` of `@margoengine/shader/glsl-pass` in a PostStack:
  three.js `ShaderPass` programs keep `tDiffuse` and `vUv`, Babylon.js `PostProcess` programs `textureSampler` and
  `vUV`, PlayCanvas post effects `uColorBuffer` and `vUv0` (map `aPosition` with `attributes: {aPosition: 'position'}`).
  Leave the vertex stage out and the pass supplies one; one of your own reads `position` and `uv` with identity matrices.
- **Shadertoy.** Paste the Image tab into `new Shadertoy(source)` of `@margoengine/shader/shadertoy`; channels go in
  `{image: {source, iChannel0: texture}}`. Draw it with `toy.pass()`, `toy.texture` or `toy.material()`. The Common
  tab is `common`, Buffer A to D are `bufferA` to `bufferD` (`{source, iChannel0: 'A'}`), and a channel can be
  `'keyboard'`, a `<video>` or an `AnalyserNode` for Shadertoy's keyboard, video and sound inputs. The Cube A tab is
  `cubeA: {source, size}` (read as `'cubeA'`), the Sound tab is `sound: {source}` played with `await toy.sound()`, and
  `vr: true` calls `mainVR` with each pixel's ray.
- **Lights and fog.** three.js `lights: true` and `fog: true` read three.js chunk uniforms, which Margo does not copy.
  Margo's `lights: true` and `fog: true` hand over its own names instead: `sunDirection`, `sunColor`, `ambientLight`,
  `pointLights[N]` and `spotLights[N]` (arrays of your own struct) with their counts, and `fogColor`, `fogNear`,
  `fogFar`, `fogDensity`, `fogHeight`, `fogHeightFalloff`. Rename your uniforms to these, and set the scene with
  `shaderScene(raw).setFog(fog).setLights(clustered)`. A program that takes its light values
  as plain uniforms of its own works unchanged without either flag.
- **Motion vectors.** A vertex stage that moves points draws a trail under TAA unless TAA knows where each vertex was.
  `velocity: true` runs the stage again with last frame's matrices and time; name the uniforms of your own motion with
  `velocity: {wave: 'waveBefore'}`.
