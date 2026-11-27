# CAD viewer

A STEP part (`plate.step`, an 80 x 50 x 8 mm mounting plate) read with Margo's B-rep kernel and shown with SolidWorks
style mouse navigation, a view cube, live dimensions, a section plane and click-to-measure that snaps to corners and
edges. Open your own STEP, IGES, STL, OBJ or glTF part with the file picker or by dropping it on the page. Needs a
browser with WebGPU.

```sh
npm run build:packages
npm run dev:examples
# http://127.0.0.1:5173/examples/cad-viewer/
```

The viewer is `main.ts`. It uses `addCAD` from `@margoengine/cad-import/stage` (STEP and IGES through `@margoengine/brep` in a
worker, in metres), `cadControls` and the mouse profiles from `@margoengine/controls`, and `Dimensions`,
`SectionPlanes` and `snapFeature` from `@margoengine/machinery`. In an app, the same names come from one install,
`margoengine`, as subpaths (`margoengine/cad/stage`, `margoengine/machinery/dimensions`).

## Three things to try next

1. **Change the part.** Replace `plate.step` with your own STEP file, or change the path passed to `show`. Lengths come
   in as metres, so the dimensions and the section plane follow the part you load.
2. **Your CAD program's mouse.** Swap `SOLIDWORKS` for `INVENTOR`, `FUSION`, `ONSHAPE`, `RHINO`, `AUTOCAD`, `BLENDER`
   or `MAYA` in `cadControls`.
3. **Export it.** `exportSTL` and `exportGLB` from `@margoengine/exporters` export the loaded mesh.
