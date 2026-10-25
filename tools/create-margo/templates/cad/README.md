# Margo app

A CAD viewer: SolidWorks mouse navigation, a view cube, a section plane, and your own STEP, IGES, STL, OBJ or
glTF part from the file picker or by drag and drop. It uses the `margoengine/cad` kit. Needs a browser with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
npm run preview   # serve dist/
```

The app is `src/main.ts`. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/shadows`, `margoengine/controls/orbit`), and the build keeps only what you import. The engine's imports guide
(`docs/guides/imports.md`) lists which import does what.
