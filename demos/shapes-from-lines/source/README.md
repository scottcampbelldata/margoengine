# Shapes From Lines

An original sail-shaped pull begins as a 15-point outline. The drafting grid shows the source outline, its edited boundary and the separate ring used in the union. The facing view presents the same result as a lacquer-faced, bevel-edged solid.

Drag a loop on the grid to replace the outline. **Smooth curve** switches between the sampled Catmull–Rom spline and its straight segments. A signed **Outline offset** grows or insets the filled regions. **Union ring** adds a separate part with a real inner boundary. **Thickness** sets the total face-to-face depth, starting at zero for a flat profile. **Bevel** rolls the edge inside that thickness. **Reset outline** restores the complete starting example.

The source outline and ring share a meter scale. The readout reports the actual area in square centimeters and the counts of disconnected regions and openings. Freehand crossings use an even–odd fill. When an inset removes the outline, it can still leave the separately selected ring. Narrow details can restrict the applied bevel. The editor checks that the proposed inset preserves the region topology and that the beveled cap faces retain the correct orientation. It shows the effective bevel when it differs from the requested value.

## Build and proof

The gallery builds from public Margo Engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. The source calls `Spline`, the Margo polygon offset and Boolean operations, and Margo extrusion with constrained Delaunay cap triangulation. Both views render in Margo at the same quality on phone and desktop. The phone stacks the viewports to leave space for drawing. The scene is generated in code.

The isolated Node QA tests the default union and its real opening, negative and positive offsets, exact un-beveled prism volume, a narrow profile and a self-crossing stroke. The normal test shapes have paired edges and outward winding. Touching components of a self-crossing sketch stay separate in the polygon result.

The browser QA drives the signed offset through trusted touch and verifies an actual changed frame. It also exercises the real union control, verifies the 34 mm maximum against geometry bounds, switches the bevel off and back on, draws a new outline through trusted touch or mouse motion, checks the spline switch, and restores the original. With an uncached 390 px Chrome viewport, 150 ms latency, 1.6 Mbps and fourfold CPU slowdown, the first changed frame arrived at 1.124 s on WebGPU, 1.846 s on forced WebGL2 and 1.864 s on automatic WebGL2. The unthrottled desktop reached it at 0.310 s native and 0.202 s forced. All five profiles ran without browser errors. See `qa-output/shapes-from-lines/check.mjs`, the per-profile reports and the rendered screenshots.

## References

- Edwin Catmull and Raphael Rom. *A Class of Local Interpolating Splines*, 1974. [Publisher record](https://doi.org/10.1016/B978-0-12-079050-0.50020-5)
- Bala R. Vatti. *A Generic Solution to Polygon Clipping*, 1992. [Publisher record](https://doi.org/10.1145/129902.129906)
- W3C. *SVG Strokes*. Reviewed the construction of round joins at offset boundaries. [Join geometry](https://www.w3.org/TR/svg-strokes/)
