# Marching Cubes

Lumen 03 is an original copper-and-glass lava lamp with a continuously changing wax surface. Raise or lower the iso threshold to see disconnected forms or joined necks, pause the same animation phase for a direct comparison, and show the actual extracted triangle edges.

## Surface and animation

Seven moving kernels populate a bounded 23 × 60 × 23 lattice in meters. Each kernel has the compact support used by Margo’s `Metaballs` class, with contribution `strength × (1 − d²/r²)³` inside radius r and zero outside. The surface follows the total field’s selected threshold. Increasing the threshold reduces the region classified inside. The drawn regions can split or join as the kernels approach.

The stock Margo implementation evaluates the scalar field and runs Marching Cubes, with roots on grid edges, gradient normals, outward triangle orientation and the asymptotic decider for ambiguous faces. The browser worker recomputes geometry as the kernel positions and threshold change. It transfers actual indexed geometry back to the Margo renderer. The counter counts components by the mesh’s indexed connectivity and triangles by the index count. The edge overlay draws that same geometry’s unique triangle edges.

The smooth source trajectories are authored for the exhibit. The visual model demonstrates an evolving implicit surface. It abstracts the convection and viscosity of a physical wax lamp.

## Original art and compatibility

The model includes the spun base, marked ceramic display plinth, nickel rails, copper rings, double-wall glass and opaque lip under the wax reservoir. The wax uses a height-directed color and emission treatment. The glass uses depth-tested translucent blending with approximate Fresnel reflectance from shaped light sources. Its optical treatment approximates a thin vessel surface. The banded room, hand-drawn plaque lettering and all rendered geometry were made for this exhibit.

WebGPU opens first. The full Margo WebGL2 compatibility path renders the same worker results, cast contact shadow, wax shader, vessel and geometry overlay. The room, glass and interactive wax render first. The unchanged static studio-shadow pass then paints the table perimeter without blocking the threshold control. Append `?backend=webgl2` to test compatibility directly. [Verified public Margo revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## References

- William E. Lorensen and Harvey E. Cline, *Marching Cubes: A High Resolution 3D Surface Construction Algorithm*, 1987. [SIGGRAPH paper](https://graphics.stanford.edu/courses/cs348a-21-winter/Papers/Marching_Cubes.pdf).
- Geoff Wyvill, Craig McPheeters and Brian Wyvill, *Data Structure for Soft Objects*, 1986. [Compact-support scalar fields](https://people.eecs.berkeley.edu/~jrs/meshpapers/Wyvill.pdf).
- Gregory M. Nielson and Bernd Hamann, *The Asymptotic Decider: Resolving the Ambiguity in Marching Cubes*, 1991. [IEEE Visualization](https://doi.org/10.1109/VISUAL.1991.175782).
- Christophe Schlick, *An Inexpensive BRDF Model for Physically-based Rendering*, 1994. [Surface reflectance approximation](https://doi.org/10.1111/1467-8659.1330233).
- Mathmos, *Lava Lamp Heritage*. [Historical reference for gravity-driven lamp silhouettes](https://mathmos.com/heritage/).
