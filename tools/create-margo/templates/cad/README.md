# Margo CAD viewer

A STEP part (`public/plate.step`, an 80 x 50 x 8 mm plate) read with OpenCascade and shown with SolidWorks-style mouse
navigation, a view cube, live dimensions, a section plane and click-to-measure (snaps to corners and edges). Open your
own STEP, IGES, STL, OBJ or glTF part with the file picker or by dropping it on the page. Built with the
`margoengine/cad` kit. Needs a browser with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
```

The viewer is `src/main.ts`. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/cad`, `margoengine/machinery/dimensions`), and the build keeps only what you import.

## Three things to try next

1. **Change the part.** Replace `public/plate.step` with your own STEP file (or change the path in `show('/plate.step', ...)`).
   Lengths come in as metres, so the dimensions and the section plane follow the part you load.
2. **Your CAD program's mouse.** Swap `SOLIDWORKS` for `INVENTOR`, `FUSION`, `ONSHAPE`, `RHINO`, `AUTOCAD`, `BLENDER`
   or `MAYA` in `cadControls`.
3. **Export it.** `exportSTL` and `exportGLB` from `margoengine/cad` export the loaded mesh.
