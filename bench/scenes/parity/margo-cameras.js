// Margo implementation of the parity camera scenes (../parity.js, area 'cameras').
import { app, engineFor, floor, meshes, palette, single } from '../margo.js';

const done = (marks, s) => (marks.buildMs = +(performance.now() - s).toFixed(1));

export const builders = {
  async 'p-ortho'(canvas, data, marks) {
    // cameras CameraProjection: orthographic, a fixed visible height (2 x half height), the catalog clip range.
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { CameraProjection } = await import('@margoengine/cameras');
    CameraProjection.attach(engine, {
      mode: 'orthographic',
      height: data.ortho.halfHeight * 2,
      near: data.camera.near,
      far: data.camera.far,
    });
    meshes(engine, data, palette(data));
    done(marks, s);
    return app(engine, () => {}, { camera: data.camera, note: 'core meshes through cameras CameraProjection' });
  },

  async 'p-cube-camera'(canvas, data, marks) {
    // environment CubeCamera (256 px rgba16float faces with mips) captured every frame at the sphere's centre; the
    // sphere is a materials PbrMaterial mesh with the cube as its envMap, left out of its own capture.
    const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
      s = performance.now(),
      [{ CubeCamera }, { PbrMaterial, createMesh }, { sphereGeometry }] = await Promise.all([
        import('@margoengine/environment/cube-camera'),
        import('@margoengine/materials'),
        import('@margoengine/geometry'),
      ]);
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    const cube = CubeCamera.attach(engine, { size: data.cubeSize, position: data.sphere.position, mips: true }),
      sphere = createMesh(
        engine,
        sphereGeometry(data.sphere.radius, 64, 32),
        new PbrMaterial({ color: '#ffffff', metalness: 1, roughness: 0.05, envMap: cube, ...single }),
      );
    sphere.root.setPosition(data.sphere.position);
    cube.exclude = [sphere.root];
    done(marks, s);
    // The harness drives engine.render() itself (no engine.start loop), so the six faces are captured explicitly.
    return app(engine, () => cube.update(6), {
      camera: data.camera,
      note: 'core meshes; CubeCamera (6 faces per frame) + materials envMap sphere; capture passes not counted',
    });
  },
};
