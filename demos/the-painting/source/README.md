# The Painting

An original animated oil-painting study of a rocky headland, with a wind-shaped pine, a slate-roofed shelter, ochre cliff ledges, distant skerries, and drifting cloud. A single generated 3D landscape runs through Margo on desktop and phone. The camera angle and crop fit the layout.

The terrain mesh and water share the same analytic coastline. The ocean mesh displaces vertically, narrow foam bands follow the coast, and wind bends the pine tips and field stems. Procedural pigment follows the surfaces. The sky drifts on its own time scale. Those are authored visual models of shore, weather and light. All colors and motion are computed in the current frame.

Margo `@margoengine/creative/paint-aniso` applies an eight-sector, polynomial-weighted anisotropic Kuwahara filter to the rendered landscape. Fine and Broad vary the structure-tensor-adapted brush radius and blend. Unfiltered shows the same landscape and clock with that filter pass disabled. The directional filter gives oil-like shapes and preserves boundaries. It does not simulate brushes, pigment transport, or drying. Pause freezes the current composition. The browser's reduced-motion setting opens with the clock paused.

WebGPU is preferred. The full Margo WebGL2 compatibility route keeps the same scene and anisotropic filter. Append `?backend=webgl2` to select it. Devices without the effect's required format support receive the engine notice.

## References

- Jan Eric Kyprianidis, Henry Kang and Jürgen Döllner. *Image and Video Abstraction by Anisotropic Kuwahara Filtering*. Computer Graphics Forum, 2009. The source method for structure-tensor-oriented painterly abstraction. [Paper](https://www.kyprianidis.com/p/pg2009/)
- Aaron Hertzmann. *Painterly Rendering with Curved Brush Strokes of Multiple Sizes*. SIGGRAPH, 1998. Directed texture and the visual distinction between fine marks and broad masses. [Paper](https://mrl.cs.nyu.edu/publications/painterly98/)
- Claude Monet. *Cliff Walk at Pourville*, 1882. Art Institute of Chicago. Reference for a reframed cliff vista and wind in layered field strokes. [Collection record](https://www.artic.edu/artworks/14620/cliff-walk-at-pourville)
- Winslow Homer. *High Cliff, Coast of Maine*, 1894. Smithsonian American Art Museum. Reference for strong bluff values and broken surf. [Collection record](https://americanart.si.edu/artwork/high-cliff-coast-maine-10725)

All shipped landscape meshes, colors, cloud/surf fields, and motion are original. The references are for the look and rendering approach.
