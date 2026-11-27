# The Glass Stack

An original installation puts four crossed tinted panes and eight colored smoke sheets over a machined turntable. Turn the artwork or reverse the actual rendering submission order. The smoke uses original procedurally generated opacity, with the same layers and colors in all three modes.

On WebGPU, the exhibit uses the Margo weighted, moment, and exact OIT packages. The exact mode keeps twelve fragments for each pixel, enough for the twelve single-sided intersections in this installation. It composites the intersections far to near. All modes depth-test against the original solid fixture and gallery. The weighted and moment modes estimate the transparent mix and can produce different colors where layers cross.

On WebGL2, a compact Margo frame-graph pass intersects rays with the same twelve transparent sheets and the live opaque scene depth. It uses weighted coverage, reconstructs cumulative optical depth from three weighted trigonometric moments, or sorts the twelve true intersections for exact compositing. The moment reconstruction and filtering differ from the native pass. The same camera, meshes, translucent sheet sizes, opacity settings and controls are used.

The scene models transparency and optical coverage. The panes do not include refracted surfaces or physically simulated smoke.

## References

- Morgan McGuire and Louis Bavoil, *Weighted Blended Order-Independent Transparency*, 2013. https://jcgt.org/published/0002/02/09/
- Cedrick Münstermann, Stefan Krumpen, Reinhard Klein, and Christoph Peters, *Moment-Based Order-Independent Transparency*, 2018. https://momentsingraphics.de/Media/I3D2018/Muenstermann2018-MBOITSupplementary.pdf
- Loren Carpenter, *The A-Buffer, an Antialiased Hidden Surface Method*, 1984. https://www.cs.cmu.edu/afs/cs.cmu.edu/academic/class/15869-f11/www/readings/carpenter84_abuffer.pdf
