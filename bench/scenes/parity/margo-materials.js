// Margo implementation of the parity material scenes (../parity.js, area 'materials'). Every scene uses the
// @margoengine/materials classes and createMesh (docs/threejs-parity.md section 5 names that package for each row);
// the yard floor and the shadow-casting boxes of p-shadow-catcher are core meshes, as in the catalog scenes.
import { app, engineFor, floor, meshes, palette } from '../margo.js';

const geometryPackage = () => import('@margoengine/geometry');
const boxGeometry = async (size) => (await geometryPackage()).boxGeometry(size, size, size);

/** One materials-package mesh per catalog item, moved through its model root. */
function place(engine, createMesh, geometry, def, material) {
  return def.items.map((b, i) => {
    const mesh = createMesh(engine, geometry, material(b, i));
    mesh.root.setPosition(b.position).setRotation(b.rotation);
    return mesh;
  });
}

/** Catalog colours as materials-package materials of one class. */
async function colours(Class, options = {}) {
  const { PALETTE } = await import('../catalog.js');
  return PALETTE.map((color) => new Class({ color, ...options }));
}

/** A frame scene of one materials class in the catalog colours on the catalog boxes. */
function coloured(className, options = () => ({}), note = 'materials meshes') {
  return async (canvas, data, marks) => {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      M = await import('@margoengine/materials'),
      paints = await colours(M[className], await options(M, data)),
      geometry = await boxGeometry(data.size);
    place(engine, M.createMesh, geometry, data, (b) => paints[b.color]);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note });
  };
}

/** One materials class shared by every catalog box. */
function shared(make, note = 'materials meshes') {
  return async (canvas, data, marks) => {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      M = await import('@margoengine/materials'),
      material = make(M, data),
      geometry = await boxGeometry(data.size);
    place(engine, M.createMesh, geometry, data, () => material);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note });
  };
}

/** Camera rotation (yaw about y, then pitch about x) as a quaternion [x, y, z, w], so a +z quad faces the camera. */
function facing(position, target) {
  const dx = position[0] - target[0],
    dy = position[1] - target[1],
    dz = position[2] - target[2],
    yaw = Math.atan2(dx, dz),
    pitch = -Math.atan2(dy, Math.hypot(dx, dz)),
    [sy, cy, sx, cx] = [Math.sin(yaw / 2), Math.cos(yaw / 2), Math.sin(pitch / 2), Math.cos(pitch / 2)];
  // q = qy(yaw) * qx(pitch)
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}

export const builders = {
  async 'p-unlit'(canvas, data, marks) {
    return coloured('UnlitMaterial')(canvas, data, marks);
  },

  async 'p-lambert'(canvas, data, marks) {
    return coloured('LambertMaterial')(canvas, data, marks);
  },

  async 'p-phong'(canvas, data, marks) {
    return coloured('PhongMaterial', () => ({ specular: '#111111', shininess: 30 }))(canvas, data, marks);
  },

  async 'p-toon'(canvas, data, marks) {
    // A 3-texel gradient map (0.2, 0.6, 1), nearest filtered: the toon ramp the spec names. `steps: 3` would give the
    // bands 0, 0.5, 1 instead.
    return coloured(
      'ToonMaterial',
      ({ Texture }) => ({
        gradientMap: new Texture(
          {
            data: new Uint8Array(
              data.steps.flatMap((v) => [Math.round(v * 255), Math.round(v * 255), Math.round(v * 255), 255]),
            ),
            width: data.steps.length,
            height: 1,
          },
          { colorSpace: 'linear', magFilter: 'nearest', minFilter: 'nearest', mipmaps: false },
        ),
      }),
      'materials meshes; gradientMap of 3 texels, nearest',
    )(canvas, data, marks);
  },

  async 'p-matcap'(canvas, data, marks) {
    return coloured(
      'MatcapMaterial',
      ({ Texture }) => ({ matcap: new Texture(data.matcap) }),
      'materials meshes; matcap sRGB, mipmapped, box colour times matcap',
    )(canvas, data, marks);
  },

  async 'p-normal-material'(canvas, data, marks) {
    return shared(
      ({ NormalMaterial }) => new NormalMaterial(),
      'materials meshes; normal*0.5+0.5 written as display values',
    )(canvas, data, marks);
  },

  async 'p-depth-material'(canvas, data, marks) {
    return shared(
      ({ DepthMaterial }) => new DepthMaterial({ depthPacking: 'basic' }),
      'materials meshes; basic packing: reverse-Z depth, near white, written as display values',
    )(canvas, data, marks);
  },

  async 'p-double-sided'(canvas, data, marks) {
    // docs/threejs-parity.md 5.15 names materials Material.side for this row.
    return coloured('PbrMaterial', (_, d) => ({ ...d.material, side: 'double' }), 'materials meshes, side double')(
      canvas,
      data,
      marks,
    );
  },

  async 'p-transparency'(canvas, data, marks) {
    return coloured(
      'PbrMaterial',
      (_, d) => ({ ...d.material, transparent: true, opacity: d.opacity, depthWrite: false }),
      'materials meshes; transparent, sorted back to front by the engine',
    )(canvas, data, marks);
  },

  async 'p-alpha-test'(canvas, data, marks) {
    const size = 256,
      px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const a = ((x >> 5) + (y >> 5)) % 2 ? 255 : 0;
        px.set([a, a, a, 255], (y * size + x) * 4);
      }
    return coloured(
      'PbrMaterial',
      ({ Texture }, d) => ({
        ...d.material,
        alphaMap: new Texture({ data: px, width: size, height: size }, { colorSpace: 'linear' }),
        alphaTest: 0.5,
      }),
      'materials meshes; alphaMap (green), alphaTest 0.5, front side',
    )(canvas, data, marks);
  },

  async 'p-maps'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { PbrMaterial, Texture, createMesh } = await import('@margoengine/materials'),
      texture = (image, colorSpace) => new Texture(image, { colorSpace, mipmaps: true }),
      m = data.maps,
      material = new PbrMaterial({
        roughness: 1,
        metalness: 1,
        emissive: '#ffffff',
        map: texture(m.color, 'srgb'),
        normalMap: texture(m.normal, 'linear'),
        metalRoughnessMap: texture(m.roughnessMetalness, 'linear'),
        aoMap: texture(m.occlusion, 'linear'),
        emissiveMap: texture(m.emissive, 'srgb'),
      });
    floor(engine, data.floor);
    place(engine, createMesh, await boxGeometry(data.size), data, () => material);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'materials meshes, one material; factors roughness 1, metalness 1, emissive white (the maps give the values); core floor',
    });
  },

  async 'p-physical'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { PbrMaterial, createMesh } = await import('@margoengine/materials'),
      { sphereGeometry } = await geometryPackage(),
      sp = data.sphere,
      paints = await colours(PbrMaterial, {
        ...data.material,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
        sheenColor: '#ffccaa',
        sheenRoughness: 0.5,
        iridescence: 1,
        iridescenceIOR: 1.3,
        iridescenceThicknessRange: [100, 400],
        anisotropy: 0.5,
        specularIntensity: 1,
        ior: 1.5,
      });
    floor(engine, data.floor);
    place(
      engine,
      createMesh,
      sphereGeometry(sp.radius, sp.widthSegments, sp.heightSegments),
      data,
      (b) => paints[b.color],
    );
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'materials meshes; sheen 1 is sheenColor #ffccaa (Margo has no separate sheen factor); core floor',
    });
  },

  async 'p-transmission'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 80, marks),
      s = performance.now();
    const [{ PbrMaterial, createMesh }, { Transmission }, { PostStack }, { Tonemap }, { sphereGeometry }] =
      await Promise.all([
        import('@margoengine/materials'),
        import('@margoengine/materials/transmission'),
        import('@margoengine/post/stack'),
        import('@margoengine/tonemap'),
        geometryPackage(),
      ]);
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    // Refraction of the scene needs the HDR capture of a post stack (README: Transmission); the stack's only effect is
    // the same PBR Neutral tone map core applies on its own.
    PostStack.attach(engine, [new Tonemap({ curve: 'neutral' })]);
    const transmission = Transmission.attach(engine),
      glass = new PbrMaterial({
        color: '#ffffff',
        roughness: 0.1,
        metalness: 0,
        transmission: 1,
        ior: 1.5,
        thickness: 0.5,
        attenuationColor: '#aaddff',
        attenuationDistance: 1,
      }),
      geometry = sphereGeometry(SPHERE.radius, SPHERE.widthSegments, SPHERE.heightSegments);
    for (const p of data.spheres) {
      const mesh = createMesh(engine, geometry, glass);
      mesh.root.setPosition(p);
      transmission.add(mesh);
    }
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: `core boxes and floor, 64 materials glass spheres (r ${SPHERE.radius}, ${SPHERE.widthSegments} x ${SPHERE.heightSegments}: the spec gives no size) refracting through Transmission + PostStack(Tonemap neutral)`,
    });
  },

  async 'p-shadow-catcher'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now();
    const [{ ShadowCatcherMaterial, createMesh }, { Shadows }, { planeGeometry }] = await Promise.all([
      import('@margoengine/materials'),
      import('@margoengine/shadows'),
      geometryPackage(),
    ]);
    const shadows = Shadows.attach(engine, { resolution: data.resolution, distance: data.extent * 2 });
    const ground = createMesh(
      engine,
      planeGeometry(data.floor.size[0], data.floor.size[2]),
      new ShadowCatcherMaterial({ opacity: data.opacity }),
    );
    ground.root.setRotation([-Math.PI / 2, 0, 0]);
    shadows.add(ground);
    for (const mesh of meshes(engine, data, palette(data))) shadows.add(mesh);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'core boxes; materials ShadowCatcherMaterial plane (floor size, y 0); Shadows cascades (PCSS) at 2048',
    });
  },

  async 'p-wireframe'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { PbrMaterial, createMesh } = await import('@margoengine/materials'),
      { sphereGeometry } = await geometryPackage(),
      sp = data.sphere,
      paints = await colours(PbrMaterial, { ...data.material, wireframe: true });
    floor(engine, data.floor);
    place(
      engine,
      createMesh,
      sphereGeometry(sp.radius, sp.widthSegments, sp.heightSegments),
      data,
      (b) => paints[b.color],
    );
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note: 'materials meshes, lit standard wireframe; core floor' });
  },

  async 'p-blending'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { UnlitMaterial, createMesh } = await import('@margoengine/materials'),
      { planeGeometry } = await geometryPackage(),
      paints = await colours(UnlitMaterial, {
        transparent: true,
        blending: 'additive',
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
      geometry = planeGeometry(1, 1),
      list = data.items.map((b) => {
        const mesh = createMesh(engine, geometry, paints[b.color]);
        mesh.root.setPosition(b.position);
        return mesh;
      });
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(
      engine,
      (t) => {
        // Camera-facing: every quad takes the camera's rotation each frame.
        const q = facing(data.camera.at(t), data.camera.target);
        for (const mesh of list) mesh.root.setQuaternion(q);
      },
      { camera: data.camera, note: 'materials unlit quads, additive, rotated to the camera each frame' },
    );
  },
};

/** p-transmission sphere: the spec gives positions only. */
const SPHERE = { radius: 0.8, widthSegments: 64, heightSegments: 32 };
