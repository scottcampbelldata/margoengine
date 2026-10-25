// Margo implementation of the parity core scenes (../parity.js, area 'core').
import { Camera, box } from '@margoengine/core';
import { app, engineFor, floor, meshes, palette, sceneSamples } from '../margo.js';

const done = (marks, s) => (marks.buildMs = +(performance.now() - s).toFixed(1));

export const builders = {
  async 'p-hierarchy'(canvas, data, marks) {
    // Groups are core meshes with no geometry; boxes are children of their group, groups children of the root.
    const engine = await engineFor(canvas, data.camera, data.items.length + data.groups.length + 8, marks),
      s = performance.now(),
      materials = palette(data),
      geometry = box(data.size, data.size, data.size),
      root = engine.createMesh(),
      groups = data.groups.map((g) => engine.createMesh(root).setPosition(g.position));
    for (const b of data.items)
      engine
        .createMesh(groups[b.group])
        .setGeometry(geometry)
        .setMaterial(materials[b.color])
        .setPosition(b.position)
        .setRotation(b.rotation);
    done(marks, s);
    return app(
      engine,
      (t) => {
        root.rotation.y = t * 0.1;
        for (const g of groups) g.rotation.y = t * 0.5;
      },
      { camera: data.camera, note: 'core meshes: 1 root, 50 groups, 5,000 boxes' },
    );
  },

  async 'p-scenes'(canvas, data, marks) {
    // Two core scenes (engine.createScene), each drawn by its own view into one half of the canvas.
    const { a, b, offset } = data,
      engine = await engineFor(canvas, a.camera, a.items.length + 8, marks),
      s = performance.now(),
      shift = (p) => p.map((v, i) => v + offset[i]),
      sceneB = engine.createScene('b');
    // Only the first view clears colour by default and a partial view clears just its own rectangle, so scene B
    // names core's clear colour (display [0.018, 0.023, 0.035]) as its background.
    sceneB.background = '#050609';
    meshes(engine, a, palette(a));
    const materials = palette(b),
      geometry = box(b.size, b.size, b.size);
    for (const item of b.items)
      sceneB
        .createMesh()
        .setGeometry(geometry)
        .setMaterial(materials[item.color])
        .setPosition(shift(item.position))
        .setRotation(item.rotation);
    const cameraB = new Camera({
      fov: b.camera.fov,
      near: b.camera.near,
      far: b.camera.far,
      position: shift(b.camera.at(0)),
      target: shift(b.camera.target),
    });
    const views = [
      { camera: engine.camera, viewport: [0, 0, 0.5, 1] },
      { camera: cameraB, viewport: [0.5, 0, 0.5, 1], scene: sceneB },
    ];
    done(marks, s);
    return {
      samples: sceneSamples(),
      render(t) {
        engine.camera.position = a.camera.at(t);
        cameraB.position = shift(b.camera.at(t));
        engine.render({ views });
      },
      idle: () => engine.gpu.queue.onSubmittedWorkDone(),
      info: () => ({ drawCalls: engine.stats.drawCalls, note: 'two core scenes, two views (stats: last scene drawn)' }),
    };
  },

  async 'p-background'(canvas, data, marks) {
    // environment ImageBackground: six 8-bit sRGB faces (+X -X +Y -Y +Z -Z, row 0 at the top) as a box skybox.
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { ImageBackground } = await import('@margoengine/environment');
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    ImageBackground.attach(engine, { shape: 'box', images: data.faces });
    done(marks, s);
    return app(engine, () => {}, { camera: data.camera, note: 'core meshes + environment ImageBackground (box)' });
  },

  async 'p-alpha'(canvas, data, marks) {
    // environment TransparentCanvas: premultiplied canvas, alpha 0 where nothing is drawn.
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { TransparentCanvas } = await import('@margoengine/environment');
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    TransparentCanvas.attach(engine);
    done(marks, s);
    return app(engine, () => {}, { camera: data.camera, note: 'core meshes + environment TransparentCanvas' });
  },

  async 'p-culling'(canvas, data, marks) {
    // Core's kernel culls every mesh's bounding sphere against the camera frustum each frame (on by default).
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now();
    meshes(engine, data, palette(data));
    done(marks, s);
    return {
      ...app(engine, () => {}, { camera: data.camera }),
      info: () => ({
        drawCalls: engine.stats.drawCalls,
        visible: engine.stats.visible,
        note: 'core CPU frustum culling (kernel)',
      }),
    };
  },

  async 'p-layers'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { layerMask, setCameraLayers, setRenderLayers } = await import('@margoengine/cameras/layers');
    const list = meshes(engine, data, palette(data));
    list.forEach((mesh, i) => setRenderLayers(mesh, layerMask(data.items[i].layer)));
    setCameraLayers(engine.camera, layerMask(data.cameraLayer));
    done(marks, s);
    return {
      ...app(engine, () => {}, { camera: data.camera }),
      info: () => ({ drawCalls: engine.stats.drawCalls, visible: engine.stats.visible, note: 'cameras/layers masks' }),
    };
  },

  async 'p-math'(_canvas, data, marks) {
    const s = performance.now(),
      { Box3, Euler, Frustum, Matrix4, Quaternion, Ray, Sphere, Vector3 } = await import('@margoengine/math');
    marks.createMs = 0;
    const { n, positions, eulers, points, rays } = data,
      parent = new Matrix4().makeRotationY(0.5).setPosition(1, 2, 3),
      local = new Matrix4(),
      world = new Matrix4(),
      p = new Vector3(),
      q = new Quaternion(),
      e = new Euler(),
      one = new Vector3(1, 1, 1),
      v = new Vector3(),
      // 45 degree perspective at the canvas aspect, near 0.1, far 100 (WebGL clip depth in both engines), times a
      // view 25 m back along +z looking at the origin.
      top = 0.1 * Math.tan(Math.PI / 8),
      right = (top * 16) / 9,
      viewProjection = new Matrix4()
        .makePerspective(-right, right, top, -top, 0.1, 100, false)
        .multiply(new Matrix4().makeTranslation(0, 0, -25)),
      frustum = new Frustum().setFromProjectionMatrix(viewProjection, false),
      bounds = new Box3(),
      size = new Vector3(1, 1, 1),
      ray = new Ray(),
      sphere = new Sphere(new Vector3(0, 0, 0), 5),
      hit = new Vector3();
    let out = null;
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return {
      task() {
        let matrices = 0,
          vectors = 0,
          inFrustum = 0,
          rayHits = 0,
          rayPoints = 0;
        for (let i = 0; i < n; i++) {
          const k = i * 3;
          local.compose(
            p.set(positions[k], positions[k + 1], positions[k + 2]),
            q.setFromEuler(e.set(eulers[k], eulers[k + 1], eulers[k + 2])),
            one,
          );
          world.multiplyMatrices(parent, local);
          const w = world.elements;
          matrices += w[12] + w[13] + w[14] + w[0];
        }
        for (let i = 0; i < n; i++) {
          const k = i * 3;
          v.set(points[k], points[k + 1], points[k + 2])
            .applyMatrix4(parent)
            .normalize();
          vectors += v.x + v.y + v.z;
        }
        for (let i = 0; i < n; i++) {
          const k = i * 3;
          bounds.setFromCenterAndSize(p.set(positions[k], positions[k + 1], positions[k + 2]), size);
          if (frustum.intersectsBox(bounds)) inFrustum++;
        }
        for (let i = 0; i < n; i++) {
          const k = i * 6;
          ray.origin.set(rays[k], rays[k + 1], rays[k + 2]);
          ray.direction.set(rays[k + 3], rays[k + 4], rays[k + 5]).normalize();
          if (ray.intersectSphere(sphere, hit)) {
            rayHits++;
            rayPoints += hit.x + hit.y + hit.z;
          }
        }
        out = { matrices, vectors, inFrustum, rayHits, rayPoints };
      },
      output: () =>
        out && {
          n,
          matrices: +out.matrices.toFixed(3),
          vectors: +out.vectors.toFixed(3),
          inFrustum: out.inFrustum,
          rayHits: out.rayHits,
          rayPoints: +out.rayPoints.toFixed(3),
        },
      info: () => ({ note: '@margoengine/math (Float64 matrices)' }),
    };
  },
};
