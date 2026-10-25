// Margo implementation of the parity special-object scenes (../parity.js, area 'objects').
import { PbrMaterial, box } from '@margoengine/core';
import { PALETTE } from '../catalog.js';
import { app, engineFor, floor, meshes, palette, sceneSamples, single } from '../margo.js';

function random(seed = 1) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
/** A frame app whose engine.render gets the frame's delta (packages that animate by frame time: water). */
function timedApp(engine, camera, update = () => {}, note) {
  let last = 0;
  return {
    samples: sceneSamples(),
    render(t) {
      const delta = Math.max(0, t - last);
      last = t;
      update(t, delta);
      engine.camera.position = camera.at(t);
      engine.render({ delta });
    },
    idle: () => engine.gpu.queue.onSubmittedWorkDone(),
    info: () => ({ drawCalls: engine.stats.drawCalls, note }),
  };
}
/** The shared 64 x 64 RGBA sprite / decal image: a soft orange disc with a white rim, alpha 0 outside (both engines). */
export function discPixels(size = 64) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5,
        dy = (y + 0.5) / size - 0.5,
        r = Math.hypot(dx, dy) * 2,
        rim = r > 0.75 && r < 0.95,
        a = r < 0.95 ? 1 : r < 1 ? (1 - r) / 0.05 : 0,
        o = (y * size + x) * 4;
      px.set(rim ? [255, 255, 255, Math.round(a * 255)] : [240, 140, 40, Math.round(a * 230)], o);
    }
  return px;
}
/** Per-point colour of point i: its position in the 20 m cube mapped to 0..1 (linear), as on the three side. */
export const pointColors = (positions) => Float32Array.from(positions, (v) => (v + 10) / 20);
/** p-lines: the segment, dashed segment and polyline data (identical on the three side). */
export function lineData(data) {
  const segments = new Float32Array(data.items.length * 6),
    h = data.size / 2;
  data.items.forEach((b, i) => {
    const [x, y, z] = b.position;
    segments.set([x - h, y - h, z - h, x + h, y + h, z + h], i * 6);
  });
  const dashed = new Float32Array(1000 * 6);
  for (let i = 0; i < 1000; i++) {
    const [x, y, z] = data.items[i * 10].position;
    dashed.set([x - h, y + h, z + h, x + h, y + h, z - h], i * 6);
  }
  const polylines = Array.from({ length: 100 }, (_, k) => {
    const p = new Float32Array(64 * 3),
      r = 3 + (k % 10) * 1.6,
      y0 = Math.floor(k / 10) * 2 - 9;
    for (let j = 0; j < 64; j++) {
      const a = (j / 63) * Math.PI * 2 + k * 0.3;
      p.set([Math.cos(a) * r, y0 + Math.sin(a * 3) * 0.5, Math.sin(a) * r], j * 3);
    }
    return p;
  });
  return { segments, dashed, polylines };
}
export const LINE_COLORS = { segments: '#80c0ff', dashed: '#ffaa00', dash: 0.05, gap: 0.05, width: 4 };
/** p-decals: 200 decal centres, 100 on the floor and 100 on box tops (seeded; the three side uses the same). */
export function decalSpots(data) {
  const pick = random(23),
    spots = [];
  for (let i = 0; i < 100; i++)
    spots.push({ position: [(pick() - 0.5) * data.extent, 0, (pick() - 0.5) * data.extent], box: -1 });
  for (let i = 0; i < 100; i++) {
    const k = Math.floor(pick() * data.items.length),
      [x, y, z] = data.items[k].position;
    spots.push({ position: [x, y + data.size / 2, z], box: k });
  }
  return spots;
}
/** p-marching-cubes: ball centres at time t in the unit cube [0, 1]^3 and the field settings (both engines). */
export const BALLS = { strength: 0.3, subtract: 12, isolation: 80 };
export function ballCentres(n, t, out = []) {
  for (let i = 0; i < n; i++) {
    const a = t * (0.4 + 0.05 * i) + i * 1.7;
    out[i] = [0.5 + 0.25 * Math.sin(a), 0.5 + 0.25 * Math.sin(a * 0.8 + i), 0.5 + 0.25 * Math.cos(a * 1.1 + 2 * i)];
  }
  return out;
}

export const builders = {
  async 'p-lod'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length * 4 + 16, marks),
      s = performance.now(),
      [{ LODSystem }, { sphereGeometry, toGeometry }] = await Promise.all([
        import('@margoengine/lod'),
        import('@margoengine/geometry'),
      ]),
      r = data.size / 2,
      levels = data.levels.map(([w, h, distance]) => ({
        geometry: w ? toGeometry(sphereGeometry(r, w, h)) : box(data.size, data.size, data.size),
        distance,
      })),
      materials = palette(data);
    floor(engine, data.floor);
    const lods = LODSystem.attach(engine, { hysteresis: 0 });
    for (const b of data.items) {
      const mesh = engine
        .createMesh()
        .setGeometry(levels[0].geometry)
        .setMaterial(materials[b.color])
        .setPosition(b.position);
      lods.add(
        mesh,
        levels.map((l) => (l.distance ? { object: l.geometry, distance: l.distance } : { object: l.geometry })),
      );
    }
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note: 'LODSystem geometry levels, hysteresis 0' });
  },

  async 'p-points'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 16, marks),
      s = performance.now(),
      { PointsPlugin, PointCloud } = await import('@margoengine/points'),
      points = PointsPlugin.attach(engine, { pointBudget: data.n });
    points.add(
      new PointCloud({
        positions: data.positions,
        colors: pointColors(data.positions),
        colorSpace: 'linear',
        material: { size: 2 },
      }),
    );
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'one PointCloud, square 2 px points, budget = n (all drawn)',
    });
  },

  async 'p-sprites'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 16, marks),
      s = performance.now(),
      { PointsPlugin, SpriteBatch } = await import('@margoengine/points'),
      image = await createImageBitmap(new ImageData(new Uint8ClampedArray(discPixels(64).buffer), 64, 64), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      }),
      sprites = PointsPlugin.attach(engine).add(new SpriteBatch({ material: { map: image } }));
    for (const b of data.items) sprites.add({ position: b.position, size: 0.4 });
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'one SpriteBatch of 10,000 (Margo has no per-object sprite; one instanced draw), unsorted alpha blend',
    });
  },

  async 'p-lines'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 16, marks),
      s = performance.now(),
      { Lines, Line, LineMaterial } = await import('@margoengine/lines'),
      lines = Lines.attach(engine),
      d = lineData(data);
    lines.add(new Line({ mode: 'segments', positions: d.segments, color: LINE_COLORS.segments }));
    lines.add(
      new Line({
        mode: 'segments',
        positions: d.dashed,
        material: new LineMaterial({
          color: LINE_COLORS.dashed,
          dashed: true,
          dashSize: LINE_COLORS.dash,
          gapSize: LINE_COLORS.gap,
        }),
      }),
    );
    d.polylines.forEach((positions, k) =>
      lines.add(new Line({ positions, color: PALETTE[k % 16], width: LINE_COLORS.width })),
    );
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: '1 segments line, 1 dashed segments line, 100 fat polylines',
    });
  },

  async 'p-css-labels'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
      s = performance.now(),
      { LabelRenderer } = await import('@margoengine/labels');
    floor(engine, data.floor);
    const list = meshes(engine, data, palette(data)),
      labels = LabelRenderer.attach(engine);
    list.forEach((mesh, i) => labels.add(labelElement(i), { mesh, offset: [0, data.size, 0] }));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note: 'LabelRenderer: 500 labels on their meshes' });
  },

  async 'p-reflector'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
      s = performance.now(),
      { Reflector } = await import('@margoengine/environment/reflector');
    meshes(engine, data, palette(data));
    const side = data.floor.size[0],
      mirror = Reflector.attach(engine, { width: side, height: side, resolution: data.scale, autoUpdate: false });
    mirror.node.setRotation([-Math.PI / 2, 0, 0]);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(
      engine,
      (t) => {
        engine.camera.position = data.camera.at(t); // the capture uses this frame's camera
        mirror.update();
      },
      {
        camera: data.camera,
        note: 'Reflector (white, half resolution) in place of the floor slab, captured before every frame',
      },
    );
  },

  async 'p-water'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
      s = performance.now(),
      { Water } = await import('@margoengine/water');
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    Water.attach(engine, { size: [100, 100], height: -0.5 }); // below the slab: its waves reach above -0.05
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return timedApp(
      engine,
      data.camera,
      undefined,
      'Water 100 x 100 m around the yard slab, 0.5 m below its top (Gerstner waves, Fresnel sky reflection; it reflects the sky, not the boxes, and has no half-resolution mirror)',
    );
  },

  async 'p-decals'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
      s = performance.now(),
      [{ Tonemap }, { Decals }] = await Promise.all([
        import('@margoengine/tonemap'),
        import('@margoengine/post/decals'),
      ]);
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    const device = engine.gpu,
      atlas = device.createTexture({
        size: [256, 256],
        format: 'rgba8unorm-srgb',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    device.queue.writeTexture({ texture: atlas }, discPixels(256), { bytesPerRow: 256 * 4 }, [256, 256]);
    Tonemap.attach(engine, { curve: 'neutral' });
    Decals.attach(engine, { atlas }).setDecals(
      decalSpots(data).map((d) => ({ position: d.position, direction: [0, -1, 0], width: 0.5, height: 0.5 })),
    );
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'screen-space Decals (multiply) after a Tonemap capture; three.js builds DecalGeometry meshes (lit)',
    });
  },

  async 'p-marching-cubes'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 16, marks),
      s = performance.now(),
      { marchingCubes } = await import('@margoengine/procedural'),
      mesh = engine
        .createMesh()
        .setMaterial(new PbrMaterial({ color: '#d08a50', roughness: 0.4, metalness: 0.1, ...single })),
      res = data.resolution,
      centres = [];
    // three's metaball field in unit-cube coordinates: sum of max(0, strength / d^2 - subtract), surface at isolation.
    const field = (x, y, z) => {
      const ux = (x + 1) / 2,
        uy = (y + 1) / 2,
        uz = (z + 1) / 2;
      let v = 0;
      for (const c of centres) {
        const d2 = (ux - c[0]) ** 2 + (uy - c[1]) ** 2 + (uz - c[2]) ** 2;
        v += Math.max(0, BALLS.strength / Math.max(d2, 1e-6) - BALLS.subtract);
      }
      return BALLS.isolation - v;
    };
    let triangles = 0;
    const update = (t) => {
      ballCentres(data.balls, t, centres);
      const g = marchingCubes(field, { resolution: [res, res, res] });
      if (g) {
        mesh.setGeometry(g); // marchingCubes returns a core Geometry
        triangles = g.indices.length / 3;
      }
    };
    update(0);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return {
      ...app(engine, update, { camera: data.camera }),
      info: () => ({
        drawCalls: engine.stats.drawCalls,
        triangles,
        note: 'procedural marchingCubes (marching tetrahedra, more triangles) on the CPU each frame, new core Geometry each frame',
      }),
    };
  },
};

/** The label element (same text and CSS on both sides). */
export function labelElement(i) {
  const el = document.createElement('div');
  el.textContent = `#${i}`;
  el.style.cssText =
    'font: 11px sans-serif; color: #fff; background: rgba(0,0,0,0.55); padding: 1px 4px; border-radius: 3px';
  return el;
}
