# Ground Projection

The Aster GT is an original four-and-a-half-metre electric coupe. Its shaped body, open wheel wells, bronze wheel accents, aerodynamic cabin and four wheels are generated in a worker. On WebGPU, Margo glTF PBR loads the same model from a quantized GLB. The **Grounded** and **Sphere** buttons switch the projection of the same high-dynamic-range photograph while leaving the model, material and camera untouched.

The ground projection intersects the view ray with a 68-metre dome or the floor, then samples the photographic direction from 1.58 metres above that floor. This calibrated height is an estimate for the scene. Directional details such as distant scenery, curbs and the horizon are projected from one photograph. It cannot reconstruct real objects at their actual depth.

Margo’s ground projection and product contact-shadow packages make the native render. WebGL2 uses a compact Margo frame-graph pass for the same geometry, calibrated projection, GGX metallic-roughness shading and prefiltered sky. It rasterizes the same car into a small contact texture. Its contact filter and final shading differ slightly. Both routes use the same texture, original surface geometry, camera and controls.

## Assets and references

- Greg Zaal, *Beach Parking* HDRI, Poly Haven, CC0. Source is the Radiance 1K download with SHA-256 `813a4fbba50d44fe6a1e6fe2629724c9a17d1a4f0be8ea0f0f6fdbc445e70d6b`. The WebP stores 1,024 × 512 log-coded radiance values, decoded to linear light for rendering. The compact Margo KTX2 lighting data is prefiltered from those same values. https://polyhaven.com/a/beach_parking
- Paul Debevec, *Rendering Synthetic Objects into Real Scenes*, 1998. https://www.pauldebevec.com/Research/IBL/
- Khronos, *PBR Neutral Tone Mapping*. https://www.khronos.org/news/press/khronos-pbr-neutral-tone-mapper-released-for-true-to-life-color-rendering-of-3d-products
- Lucid Motors, *Air Sapphire*, aerodynamic proportions and material references. The Aster model and mesh are original. https://lucidmotors.com/air-sapphire

Generate the original GLB on the command line with `node tools/build-car.mjs aster.glb`.
