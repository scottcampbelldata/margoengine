# Portals

Move the viewpoint from left to right. A bronze instrument sits in the copper vault and a cyan tower stands inside the blue meridian chamber. Their parallax changes as the camera moves. A brass post in the foreground interrupts the copper vault where it crosses the opening.

Both rooms exist in the same Margo scene. Each room's meshes are turned inwards from its arch by a rigid transform, approximately −13.64° and +13.24° about the vertical axis. The chamber volumes meet behind the wall. Geometry is clipped to the back side of the aperture plane. The package's native `Portals.add({mask, contents})` binds a different stencil reference to each arch and its room. The package writes the visible aperture after drawing the foreground, then accepts pixels from its own contents. This lets the brass post occlude the view.

The original castings, arches, handrails, limestone stairs, glazed specimen, meridian tower and wall panels are procedural geometry. A worker builds their vertex buffers and transfers them to the page once. The app renders each new viewpoint with the same geometry, stencil path and multi-sample anti-aliasing on phone and desktop.

## Verification

Fresh-process cold phone tests used a 390 × 844 CSS-pixel viewport at 2× device scale, 150 ms network latency, 1.6 Mbps download and 4× CPU throttling. The first input was a trusted touchscreen tap on the slider. The end mark follows the GPU fence for the translated viewpoint.

| Renderer | First completed phone movement |
| --- | ---: |
| Native WebGPU | 1.741 s |
| Automatic Margo WebGL2 | 2.509 s |
| Forced Margo WebGL2 | 2.545 s |

Desktop and phone browser tests verified both stencil references and both keyboard endpoints. At least 240,216 pixels changed by five or more RGB levels between the phone endpoints on each route. The three phone renderer routes produced pixel-identical centred captures. Image checks also sample each portal interior and the occluding foreground post. The geometry audit checks that all room content stays behind the masking plane and confirms that a sample point belongs to both transformed chamber volumes.

From the showcase checkout, with `MARGO_ENGINE_CHECKOUT` set to the verified engine root:

```powershell
node qa-output/portals/verify-layout.mjs
node "$env:MARGO_ENGINE_CHECKOUT/scripts/run-with-timeout.mjs" --max=2 -- node qa-output/portals/check.mjs
python qa-output/portals/measure.py
```

## Sources

- David Luebke and Chris Georges, *Portals and Mirrors: Simple, Fast Evaluation of Potentially Visible Sets* (I3D 1995). [Paper](https://doi.org/10.1145/199404.199422)
- Mark J. Kilgard, *Improving Shadows and Reflections via the Stencil Buffer* (1999). [Presentation archive](https://opengl.org/archives/resources/features/StencilTalk/)
- W3C, *WebGPU*, depth and stencil state. [Specification](https://www.w3.org/TR/webgpu/#depth-stencil-state)
- 7132 Therme, architect Peter Zumthor's quartzite construction, material reference for the original gallery wall. [Architecture brochure](https://7132.com/media/rqvnkqir/7132-broschuere-spa.pdf)
- Margo Engine `0efd9cff8230507a32deb49907ecd499d46925f5`. [Materials stencil portal API](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/materials/README.md#stencil-portals-optional-portal)
