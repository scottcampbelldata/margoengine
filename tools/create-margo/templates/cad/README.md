# Margo CAD viewer

A mounting bracket modeled in code with Margo's own B-rep kernel: a union of two plates and four holes cut by
Booleans, with its exact volume, area and mass. It's shown with SolidWorks-style mouse navigation, a view cube, live
dimensions, a section plane and click-to-measure (snaps to corners and edges). Open your own STEP, IGES, STL, OBJ or
glTF part with the file picker or by dropping it on the page. Built with the `margoengine/cad` kit. Needs a browser
with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
```

The viewer is `src/main.ts`. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/brep`, `margoengine/machinery/dimensions`), and the build keeps only what you import.

## Three things to try next

1. **Change the part.** In `bracket()`, make the holes bigger (`0.005` is the radius in metres) or add a third one;
   the volume, mass and dimensions update. `model.fillet` and `model.chamfer` round or bevel named edges.
2. **Your CAD program's mouse.** Swap `SOLIDWORKS` for `INVENTOR`, `FUSION`, `ONSHAPE`, `RHINO`, `AUTOCAD`, `BLENDER`
   or `MAYA` in `cadControls`.
3. **Export it.** `model.bodiesToSTEP([part])` returns the part as a STEP file any CAD program opens; `exportSTL` and
   `exportGLB` from `margoengine/cad` export the mesh.
