# The Engineering Mesh

A ceramic sleeve in a machined sectioning rig illustrates how temperature falls through a cylindrical wall. Move **Cut plane** sideways through the bore. The exposed face, intersected-cell count, and hottest interpolated value follow the plane. **Show cell edges** outlines the tetrahedra the plane crosses. **Volume** directly ray casts the retained tetrahedra; drag the specimen to see the depth.

## Model

The sleeve is 476 mm long with a 67 mm bore radius and a 137 mm outer radius. Its bore is held at 320 °C and its exterior at 70 °C. The idealized material has constant thermal conductivity. The model assumes no heat generation and no axial heat flow. Its steady temperature in degrees Celsius is

\[
T(r)=70+250\,\frac{\ln(0.137/r)}{\ln(0.137/0.067)}.
\]

The geometry uses an original, conforming VTK-style tetrahedral grid with 1,631 vertices and 6,609 tetrahedra. It uses irregular angular, radial and axial intervals. A consistent diagonal through shared prism faces keeps the mesh conforming. Selected tetrahedra are refined at the centroid without changing neighboring faces. The radial temperature solution is sampled at mesh vertices. Each tetrahedron uses piecewise-linear interpolation.

The triangulated wall approximates the true cylinders. Independent checks verified positive signed volumes and one face-connected component. Mesh volume was 1.01% below the analytic cylinder-wall volume. Across eight test offsets spanning the controls, the section area differed from analytic chord areas by at most 3.38%, and the hottest value on the slice differed from the analytic value by at most 1.64 °C.

## Rendering

- In **Section**, Margo SciViz runs `sliceGrid` for the colored faces and `clipGrid` for the retained shell. The overlay traces the intersected cell boundaries and omits triangulation diagonals within each cell. The live hottest-temperature readout refers to the slice plane in both modes.
- In **Volume**, `tetrahedralVolume` follows face adjacency in the original tetrahedral field. A normalized clip plane discards the same side as the section. The displayed color blends along the ray, so material deeper than the cut can still contribute.
- Native WebGPU starts first. WebGL2 uses a Margo FrameGraph section pass with the same geometry, scalar interpolation, projection, palette and instrument. **Volume** opens the full official WebGL2 compatibility layer when selected. The current camera and plane persist. The graphics requirements link appears if the browser can draw the section but cannot run the tetrahedral ray caster. Use `?backend=webgl2` to exercise the fallback.

All data and scene geometry are authored in this exhibit. Engine packages are built from [the public Margo pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## Sources

- U.S. Department of Energy, 1992. [DOE Fundamentals Handbook, Thermodynamics, Heat Transfer, and Fluid Flow, Vol. 2](https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1012-92_VOL2.pdf). Cylindrical-wall conduction in the conduction heat transfer chapter.
- Jonathan Richard Shewchuk, 1998. [Tetrahedral Mesh Generation by Delaunay Refinement](https://people.eecs.berkeley.edu/~jrs/papers/delref3d.pdf). Mesh conformity and interpolation background. This exhibit uses its own annular prism subdivision.
- Will Schroeder, Ken Martin and Bill Lorensen. [The Visualization Toolkit, Fundamental Algorithms](https://book.vtk.org/en/latest/VTKBook/06Chapter6.html). Plane cutting and clipped scalar interpolation.
- Science Museum Group. [Sectioned Brush Ljungstrom steam turbine, 1956](https://collection.sciencemuseumgroup.org.uk/objects/co8420291/steam-turbine-steam-turbine). Reference for the visual presentation of a retained casing and machined cutaway hardware.
