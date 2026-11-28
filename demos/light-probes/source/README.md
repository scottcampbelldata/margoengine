# Light Probes

Brief 92. A polished, inlaid sphere rolls on a slate and brass track past three original painted alcoves. Drag **Sphere position** to stop at any point on the rail. The distance and turn are linked by the sphere’s radius, so the inlay rotates with the roll. **Satin finish** raises the sphere’s material roughness with the room and probes fixed.

Margo `LightProbes` captures the actual scene meshes with the sphere temporarily excluded. A three-cell irradiance volume projects the captures into second-order spherical harmonics. Margo interpolates between the cell centers as the sphere travels. Three weighted, box-projected reflection probes capture 64-pixel cube faces and use 64 importance samples for filtering the rougher specular levels. Forward color panels are part of the gallery geometry and appear in the reflection when it points at them. The reflection blur changes with the metal’s surface roughness.

The settled RGB readout uses `irradianceAt` at the sphere’s center on a fixed, slightly downward-facing normal. It reports relative linear color from the captured volume. The swatch applies the standard display transfer to those values. The underlying reflection and diffuse contributions are rendered separately in the engine, and the probes do not include the moving sphere’s self-reflection or its shadow.

The WebGL2 opening immediately shades the sphere with Margo SHLight and the baked coefficients of this exact gallery. On the single-axis track it blends the two neighboring L2 cell captures at the sphere’s real position. The room then recaptures the same volume and builds the three reflection maps in separate passes. Both paths settle to the same room, capture meshes, grid, reflection resolution and filter settings.

## Reproduce the opening probes

Capture the room without the sphere using the marked Margo volume sweep in the source. With the resulting snapshot, use irradianceAt at the three cell centers on a grid of unit normals. The fitted coefficients in irradiance.js reproduce those samples. The local QA harness uses 64 Fibonacci directions and the linear L2 basis with Lambert band weights 1, 2/3 and 1/4. The normal-sample residual of each fit is below 4 × 10⁻⁹ linear units.

## References

- Ravi Ramamoorthi and Pat Hanrahan, [An Efficient Representation for Irradiance Environment Maps](https://aperture.stanford.edu/papers/envmap/), SIGGRAPH 2001. The low-frequency spherical-harmonic approximation for diffuse irradiance.
- Paul Debevec, [Rendering Synthetic Objects Into Real Scenes](https://www.pauldebevec.com/Research/IBL/), SIGGRAPH 1998. Sampling directional radiance and using it to light and reflect from objects.
- Sébastien Lagarde and Antoine Zanuttini, [Local Image-Based Lighting with Parallax-Corrected Cubemap](https://seblagarde.wordpress.com/wp-content/uploads/2012/08/parallax_corrected_cubemap-gameconnection2012.pdf), 2012. Correcting local reflections by intersecting bounding geometry.
- Studio Olafur Eliasson, [Your uncertain shadow (colour)](https://olafureliasson.net/artwork/your-uncertain-shadow-colour-2010/), 2010. Reference for arranging colored light as an installation. The model, composition and geometry here are original.
- [Margo LightProbes package documentation at the pinned public engine revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/environment#light-probes-irradiance-volumes-and-reflection-probes).
