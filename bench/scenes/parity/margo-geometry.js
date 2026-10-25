// Margo implementation of the parity geometry scenes (../parity.js, area 'geometry'): @margoengine/geometry for the
// CPU tasks, @margoengine/materials meshes for the custom-attribute frame scene.
import { PALETTE } from '../catalog.js';
import { app, engineFor } from '../margo.js';

const geometry = () => import('@margoengine/geometry');
const tris = (g) => g.indices.length / 3;
const verts = (g) => g.positions.length / 3;

/** The Klein bottle (the classic "bottle" parametrisation), u and v in [0, 1]. */
export function klein(u, v, target) {
  u *= Math.PI;
  v *= 2 * Math.PI;
  const cu = Math.cos(u),
    su = Math.sin(u),
    cv = Math.cos(v),
    sv = Math.sin(v);
  target[0] = (-2 / 15) * cu * (3 * cv - 30 * su + 90 * cu ** 4 * su - 60 * cu ** 6 * su + 5 * cu * cv * su);
  target[1] =
    (-1 / 15) *
    su *
    (3 * cv -
      3 * cu ** 2 * cv -
      48 * cu ** 4 * cv +
      48 * cu ** 6 * cv -
      60 * su +
      5 * cu * cv * su -
      5 * cu ** 3 * cv * su -
      80 * cu ** 5 * cv * su +
      80 * cu ** 7 * cv * su);
  target[2] = (2 / 15) * (3 + 5 * cu * su) * sv;
}

export const builders = {
  async 'p-primitives'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      G = await geometry();
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        const list = [];
        for (let i = 0; i < data.count; i++)
          list.push(
            G.sphereGeometry(1, 64, 32),
            G.cylinderGeometry(1, 1, 1, 64, 8),
            G.torusGeometry(1, 0.4, 32, 64),
            G.capsuleGeometry(0.5, 1, 16, 32),
            G.icosahedronGeometry(1, 4),
            G.boxGeometry(1, 1, 1, 8, 8, 8),
          );
        out = list;
      },
      info: () => ({
        note: 'three.js capsules keep 2 x 32 zero-area pole triangles that Margo leaves out (same vertices)',
      }),
      output: () => ({
        geometries: out.length,
        vertices: out.reduce((n, g) => n + verts(g), 0),
        triangles: out.reduce((n, g) => n + tris(g), 0),
      }),
    };
  },

  async 'p-extrude'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      G = await geometry(),
      star = [];
    for (let k = 0; k < 10; k++) {
      const a = Math.PI / 2 + (k * Math.PI) / 5,
        r = k % 2 ? 0.5 : 1;
      star.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const path = data.path.map((p) => [...p]),
      profile = data.profile.map((p) => [...p]);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        const shape = new G.Shape();
        shape.moveTo(...star[0]);
        for (const p of star.slice(1)) shape.lineTo(...p);
        shape.closePath();
        const extruded = G.extrudeGeometry(shape, {
            depth: 1,
            bevelEnabled: true,
            bevelThickness: 0.1,
            bevelSize: 0.1,
            bevelSegments: 3,
            curveSegments: 24,
          }),
          lathe = G.latheGeometry(profile, 128),
          tube = G.tubeGeometry(new G.CatmullRomCurve3(path), 512, 0.1, 16, false);
        out = { extruded, lathe, tube };
      },
      output: () =>
        Object.fromEntries(Object.entries(out).map(([k, g]) => [k, { vertices: verts(g), triangles: tris(g) }])),
    };
  },

  async 'p-edges'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      G = await geometry(),
      k = data.knot;
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        const knot = G.torusKnotGeometry(k.radius, k.tube, k.tubular, k.radial, k.p, k.q);
        out = { edges: G.edgesGeometry(knot, data.threshold), wireframe: G.wireframe(knot), knot };
      },
      output: () => ({
        knotTriangles: tris(out.knot),
        edgeSegments: out.edges.length / 2,
        wireframeSegments: out.wireframe.length / 2,
      }),
    };
  },

  async 'p-attributes'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      [G, { Material, createMesh }] = await Promise.all([geometry(), import('@margoengine/materials')]);
    // One custom indexed geometry: the box's position, normal and uv, an independent uv1, MikkTSpace-style tangents
    // and a per-vertex colour that runs from 0.35 grey at the bottom to white at the top (times the box colour).
    const box = G.computeTangents(G.boxGeometry(data.size, data.size, data.size)),
      n = box.positions.length / 3,
      uvs1 = new Float32Array(n * 2),
      colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      uvs1[i * 2] = box.uvs[i * 2] * 0.5 + 0.25;
      uvs1[i * 2 + 1] = box.uvs[i * 2 + 1] * 0.5 + 0.25;
      const h = box.positions[i * 3 + 1] / data.size + 0.5,
        c = 0.35 + 0.65 * h;
      colors.set([c, c, c], i * 3);
    }
    const custom = {
        positions: box.positions,
        normals: box.normals,
        uvs: box.uvs,
        uvs1,
        tangents: box.tangents,
        colors,
        indices: box.indices,
      },
      paints = PALETTE.map((color) => new Material({ color, ...data.material, vertexColors: true }));
    for (const b of data.items)
      createMesh(engine, custom, paints[b.color]).root.setPosition(b.position).setRotation(b.rotation);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'materials meshes; vertex colour 0.35 grey (bottom) to white (top) times the box colour',
    });
  },

  async 'p-geometry-utils'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      G = await geometry(),
      base = G.boxGeometry(0.5, 0.5, 0.5),
      // Inputs (not timed): 1,000 boxes moved to their catalog positions, and a non-indexed copy of the grid with
      // uvs (x, z) and no normals (zero).
      moved = data.boxes.map((p) => G.applyMatrix4(base, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1])),
      v = data.grid.positions.length / 3,
      uvs = new Float32Array(v * 2);
    for (let i = 0; i < v; i++)
      (uvs[i * 2] = data.grid.positions[i * 3]), (uvs[i * 2 + 1] = data.grid.positions[i * 3 + 2]);
    const grid = G.toNonIndexed(G.geometryData(data.grid.positions, new Float32Array(v * 3), uvs, data.grid.indices));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        const merged = G.mergeGeometries(moved),
          welded = G.computeTangents(G.computeVertexNormals(G.mergeVertices(grid)));
        out = { merged, welded };
      },
      output: () => ({
        mergedVertices: verts(out.merged),
        mergedTriangles: tris(out.merged),
        gridInputVertices: verts(grid),
        weldedVertices: verts(out.welded),
        weldedTriangles: tris(out.welded),
        tangents: out.welded.tangents.length / 4,
      }),
    };
  },

  async 'p-text'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      { parseTTF, textGeometry } = await import('@margoengine/loaders/font');
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        const font = parseTTF(data.font);
        out = textGeometry(data.text, {
          font,
          size: data.size,
          depth: data.depth,
          curveSegments: data.curveSegments,
          bevelEnabled: false,
        });
      },
      output: () => ({ vertices: verts(out), triangles: tris(out) }),
    };
  },

  async 'p-geometry-misc'(canvas, data, marks) {
    marks.createMs = 0;
    const s = performance.now(),
      G = await import('@margoengine/geometry/extras');
    marks.buildMs = +(performance.now() - s).toFixed(1);
    let out = null;
    return {
      task() {
        out = {
          hull: G.convexGeometry(data.points),
          // three.js's RoundedBoxGeometry segments 8 is 8 facets on each side of a rounded edge's 45-degree seam,
          // which is Margo's 16 (facets per whole 90-degree edge): both give 3,468 triangles.
          rounded: G.roundedBoxGeometry(1, 1, 1, 16, 0.1),
          klein: G.parametricGeometry(klein, 128, 128),
        };
      },
      output: () => ({
        hullTriangles: tris(out.hull),
        roundedTriangles: tris(out.rounded),
        kleinTriangles: tris(out.klein),
      }),
      info: () => ({
        note: 'rounded box with 16 facets per rounded edge (three.js segments 8 counts each half of the edge)',
      }),
    };
  },
};
