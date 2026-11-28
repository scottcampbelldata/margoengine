# The Exploded Assembly

An original eight-leaf optical iris shown as a live assembly drawing. Drag **Assembly spread**, or use **Explode** and **Assemble**. Hover or tap the model to identify a component, or select its name from the keyboard-accessible menu.

The assembly contains six axial rings, eight curved leaves and eight pins. A fixed 20.8 mm radius models the optical pupil. The radial offsets separate leaves and pins while the axial offsets reveal the mount, carrier, cam race, washer, housing and bezel. Full spread adds 156 mm from the stationary mount to the front bezel. Blade actuation is outside this assembly drawing.

## Source and build

Original CAD solid geometry and finish assignments are in `generate.mjs` and `iris.mjs`. The public Margo B-rep API revolves the beveled rings and uses eight exact cylindrical cuts on the cam race. The blade uses an extruded arc-bounded profile. All eight unique shapes passed the solid validity check and tessellated without failed faces. Their 5,840 unique triangles ship as a 61,477-byte compressed mesh with instanced positions from the same source on phone and desktop.

Set `MARGO_ENGINE_CHECKOUT` to the built public Margo Engine checkout at `0efd9cff8230507a32deb49907ecd499d46925f5` and run `node src/the-exploded-assembly/generate.mjs` from the gallery root to regenerate the mesh. The gallery build bundles Margo core, `machinery` for exploded placement, `tween` for the two animation buttons, and `selection` for rendered pointer picking. It serves native WebGPU first, plus the public Margo WebGL2 compatibility implementation. The controls honor reduced-motion preferences.

The local gallery browser regression inspected both real renderer paths and the automatic fallback. A fresh 390 px browser context with 150 ms latency, 1.6 Mbps throughput and 4× CPU slowdown reached the first changed frame after a trusted slider touch at 1.116 s native, 1.929 s forced WebGL2, and 1.890 s automatic WebGL2. The unthrottled desktop WebGPU case reached it at 0.206 s. Every case compared all 22 world placements at full spread and after return within 1 µm and identified the visible front bezel through genuine pointer picking. These times are local emulation results. Evidence is under the ignored `qa-output/the-exploded-assembly` folder.

## References

- Wilmot Li, Maneesh Agrawala, Brian Curless and David Salesin. *Automated Generation of Interactive 3D Exploded View Diagrams*, 2008. [University of Washington](https://grail.cs.washington.edu/projects/exview3D/)
- ASME. *Y14.24 Types and Applications of Engineering Drawings*. [ASME](https://www.asme.org/codes-standards/find-codes-standards/y14-24-types-applications-engineering-drawings)
- *Iris diaphragm and blade therefor*, 1972. [U.S. patent 3,685,418](https://patents.google.com/patent/US3685418A/en)
