# Margo React app

Three shapes in afternoon sun with soft shadows, bloom and an orbit turntable, written as JSX with `margoengine/react`. Needs a browser with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
```

The scene is `src/scene.tsx`. `margoengine` is the only engine dependency: every package is a subpath, and the build keeps
only what you import.

## Three things to try next

1. **A model.** `<Model src="/model.glb" />` from `margoengine/react`; put the file in `public/`.
2. **Studio light.** `<Environment src="/studio.hdr" background />` for image-based lighting.
3. **Physics.** `<Physics>` and `<RigidBody>` from `margoengine/react/physics` with `npm i @dimforge/rapier3d-compat`.
