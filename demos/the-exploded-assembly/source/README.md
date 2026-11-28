# The Exploded Assembly

An original eight-leaf optical iris shown as a live assembly drawing. Drag **Assembly spread**, or use **Explode** and **Assemble**. Hover or tap the model to identify a component, or select its name from the keyboard-accessible menu.

The assembly contains six axial rings, eight curved leaves and eight pins. A fixed 20.8 mm radius models the optical pupil. The radial offsets separate leaves and pins while the axial offsets reveal the mount, carrier, cam race, washer, housing and bezel. Full spread adds 156 mm from the stationary mount to the front bezel. Blade actuation is outside this assembly drawing.

## Source and build

Original CAD solid geometry and finish assignments are in `generate.mjs` and `iris.mjs`. The Margo B-rep API revolves the beveled rings and uses eight exact cylindrical cuts on the cam race. The blade uses an extruded arc-bounded profile. All eight unique shapes passed the solid validity check and tessellated without failed faces. The 22 parts (six rings, eight leaves, eight pins), each a named node at its assembled place, ship as one meshopt GLB (`assets/iris.glb`, about 75 kB).

The page opens `studio/bench` and `machinery/bench`: the iris stands on the gabbro surface plate in the light tent, each part takes a measured finish (anodised aluminium for the frame, bronze for the cam ring, steel, stainless leaves, brass pins) with feature edges, and the camera follows the stack as it opens. `machinery/exploded` moves the parts, `tween` times the two buttons, and `selection` picks a part under the pointer on both WebGPU and the WebGL2 layer. The controls honor reduced-motion preferences.

Set `MARGO_ENGINE_CHECKOUT` to a built Margo Engine checkout and run `node demos/the-exploded-assembly/source/generate.mjs` from the repository root to regenerate the GLB.

## References

- Wilmot Li, Maneesh Agrawala, Brian Curless and David Salesin. *Automated Generation of Interactive 3D Exploded View Diagrams*, 2008. [University of Washington](https://grail.cs.washington.edu/projects/exview3D/)
- ASME. *Y14.24 Types and Applications of Engineering Drawings*. [ASME](https://www.asme.org/codes-standards/find-codes-standards/y14-24-types-applications-engineering-drawings)
- *Iris diaphragm and blade therefor*, 1972. [U.S. patent 3,685,418](https://patents.google.com/patent/US3685418A/en)
