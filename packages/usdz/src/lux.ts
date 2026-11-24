// UsdLux lights and UsdGeom cameras as KHR_lights_punctual lights and glTF cameras, so a lit stage opens lit. From OpenUSD's
// public schema pages (LightAPI, the light schemas, ShapingAPI, UsdGeomCamera). Sizes count the transform stack's scale, as
// LightAPI says of normalize. A light's luminance is
// intensity * 2^exposure * color, in nits, and punctual lights take what that gives from afar: candela for a shape, its
// luminance times the area it shows along its axis; lux for a distant light, its luminance times the disc it fills in the sky.
import type { GLTFLightDefinition } from '../../shared/gltf.js';
import type { ExtensionHooks, SceneRead, USDExtension } from './extension.js';

const degrees = Math.PI / 180;

/**
 * The colour of a black body at `kelvin`, clamped to the schema's 1000 to 10000, at a luminance of 1 in linear Rec. 709. The
 * Planckian locus is Krystek's rational fit (An algorithm to calculate correlated colour temperature, 1985), in CIE 1960 uv.
 */
export function blackbody(kelvin: number): [number, number, number] {
  const t = Math.min(10000, Math.max(1000, kelvin)),
    u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t),
    v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t),
    d = 2 * u - 8 * v + 4,
    x = (3 * u) / d,
    y = (2 * v) / d,
    X = x / y,
    Z = (1 - x - y) / y;
  return [
    Math.max(0, 3.2404542 * X - 1.5371385 - 0.4985314 * Z),
    Math.max(0, -0.969266 * X + 1.8760108 + 0.041556 * Z),
    Math.max(0, 0.0556434 * X - 0.2040259 + 1.0572252 * Z),
  ];
}

/** A stage's dome light. A punctual light cannot hold one, so it comes back as data for an `Environment`. */
export interface USDDomeLight {
  path: string;
  /** `inputs:texture:file` as authored, when the light has one. */
  file?: string;
  /** Luminance in nits: intensity times 2 to the exposure. */
  intensity: number;
  color: number[];
}
/** The stage's first dome light, when `lights()` read one. */
export function domeLight(asset: { document: { extras?: unknown } }): USDDomeLight | undefined {
  return (asset.document.extras as { usdDomeLight?: USDDomeLight } | undefined)?.usdDomeLight;
}

type Node = { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; children?: number[] };
const local = ({ matrix, translation: t = [0, 0, 0], rotation: q = [0, 0, 0, 1], scale: k = [1, 1, 1] }: Node): number[] => {
  if (matrix) return matrix;
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * k[0], 2 * (x * y + w * z) * k[0], 2 * (x * z - w * y) * k[0], 0,
    2 * (x * y - w * z) * k[1], (1 - 2 * (x * x + z * z)) * k[1], 2 * (y * z + w * x) * k[1], 0,
    2 * (x * z + w * y) * k[2], 2 * (y * z - w * x) * k[2], (1 - 2 * (x * x + y * y)) * k[2], 0,
    t[0], t[1], t[2], 1,
  ];
};
const times = (a: number[], b: number[]) => {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};
/** How much each node's world matrix stretches its own x, y and z: sizes in the schema are scene units before the transform stack. */
function worldScales(nodes: Node[]): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>(),
    walk = (id: number, parent: number[]) => {
      const world = times(parent, local(nodes[id]));
      out.set(id, [Math.hypot(world[0], world[1], world[2]), Math.hypot(world[4], world[5], world[6]), Math.hypot(world[8], world[9], world[10])]);
      for (const child of nodes[id].children ?? []) walk(child, world);
    };
  walk(0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return out;
}

function scene(read: SceneRead): void {
  const { specs, document: doc } = read,
    scales = worldScales(doc.nodes as Node[]),
    attr = (path: string, name: string): unknown => {
      const f = specs[path + '.' + name]?.fields ?? specs[path + '.inputs:' + name]?.fields;
      if (!f) return undefined;
      const samples = f.timeSamples as { times: number[]; values: unknown[] } | undefined;
      return samples?.times.length ? samples.values[0] : f.default;
    },
    flag = (path: string, name: string) => {
      const v = attr(path, 'inputs:' + name) ?? attr(path, name);
      return v === true || v === 1;
    },
    number = (path: string, name: string, fallback: number) => {
      const v = attr(path, 'inputs:' + name) ?? attr(path, name);
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    };
  const lights: GLTFLightDefinition[] = [],
    cameras = (doc.cameras ??= []);
  for (const [path, id] of read.nodes) {
    const type = specs[path]?.fields.typeName,
      node = doc.nodes![id],
      [sx, sy, sz] = scales.get(id) ?? [1, 1, 1];
    if (type === 'Camera') {
      const near = attr(path, 'clippingRange') as ArrayLike<number> | undefined,
        focal = number(path, 'focalLength', 50),
        wide = number(path, 'horizontalAperture', 20.955),
        tall = number(path, 'verticalAperture', 15.2908),
        znear = (near?.[0] ?? 1) * sz,
        zfar = (near?.[1] ?? 1000000) * sz;
      node.camera = cameras.length;
      cameras.push(
        attr(path, 'projection') === 'orthographic'
          ? // Apertures are in tenths of a scene unit, as the schema has it.
            { type: 'orthographic', name: path, orthographic: { xmag: (wide / 20) * sx, ymag: (tall / 20) * sy, znear, zfar } }
          : { type: 'perspective', name: path, perspective: { yfov: 2 * Math.atan(tall / (2 * focal)), aspectRatio: wide / tall, znear, zfar } },
      );
      continue;
    }
    if (typeof type !== 'string' || !/^(Distant|Sphere|Rect|Disk|Cylinder)Light$/.test(type)) {
      if (type === 'DomeLight' || type === 'DomeLight_1') {
        read.soft(`${path} is a dome light, which punctual lights cannot hold; read it with domeLight() and light the scene with an Environment`);
        const file = attr(path, 'inputs:texture:file');
        doc.extras = {
          usdDomeLight: {
            path,
            ...(typeof file === 'string' ? { file } : {}),
            intensity: number(path, 'intensity', 1) * 2 ** number(path, 'exposure', 0),
            color: Array.from((attr(path, 'inputs:color') ?? [1, 1, 1]) as ArrayLike<number>),
          },
          ...(doc.extras as object | undefined),
        };
      }
      continue;
    }
    const distant = type === 'DistantLight',
      // A text layer may give a bool as 1.
      normalize = flag(path, 'normalize'),
      luminance = number(path, 'intensity', distant ? 50000 : 1) * 2 ** number(path, 'exposure', 0);
    let color = Array.from((attr(path, 'inputs:color') ?? attr(path, 'color') ?? [1, 1, 1]) as ArrayLike<number>);
    if (flag(path, 'enableColorTemperature')) {
      const tint = blackbody(number(path, 'colorTemperature', 6500));
      color = color.map((c, i) => c * tint[i]);
    }
    let amount: number,
      kind: GLTFLightDefinition['type'] = 'point';
    if (distant) {
      kind = 'directional';
      const half = Math.min(Math.PI, Math.max(0, (number(path, 'angle', 0.53) * degrees) / 2)),
        s = Math.sin(half) ** 2,
        size = half === 0 ? 1 : half <= Math.PI / 2 ? s * Math.PI : (2 - s) * Math.PI;
      amount = normalize ? luminance : luminance * size;
    } else {
      const size = Math.cbrt(sx * sy * sz),
        radius = number(path, 'radius', 0.5) * size,
        wide = number(path, 'width', 1) * sx,
        tall = number(path, 'height', 1) * sy,
        long = number(path, 'length', 1) * sx;
      /** The area the light shows along its axis, and its whole surface. */
      const [seen, whole] =
        type === 'SphereLight'
          ? [Math.PI * radius ** 2, 4 * Math.PI * radius ** 2]
          : type === 'RectLight'
            ? [wide * tall, wide * tall]
            : type === 'DiskLight'
              ? [Math.PI * radius ** 2, Math.PI * radius ** 2]
              : [2 * radius * long, 2 * Math.PI * radius * long + 2 * Math.PI * radius ** 2];
      amount = (luminance * seen) / (normalize ? whole : 1);
    }
    // glTF colours stop at 1, and a black body's can pass it: the light's strength takes the rest.
    const largest = Math.max(...color, 1e-9),
      definition: GLTFLightDefinition = { type: kind, name: path, color: color.map((c) => c / largest), intensity: amount * largest },
      cone = number(path, 'shaping:cone:angle', 90);
    if (!distant && cone < 90) {
      const softness = Math.min(1, Math.max(0, number(path, 'shaping:cone:softness', 0)));
      definition.type = 'spot';
      definition.spot = { outerConeAngle: cone * degrees, innerConeAngle: cone * degrees * (1 - softness) };
    }
    node.extensions = { ...node.extensions, KHR_lights_punctual: { light: lights.length } };
    lights.push(definition);
  }
  if (!cameras.length) delete doc.cameras;
  if (!lights.length) return;
  doc.extensions = { ...doc.extensions, KHR_lights_punctual: { lights } };
  if (!(doc.extensionsUsed ??= []).includes('KHR_lights_punctual')) doc.extensionsUsed.push('KHR_lights_punctual');
}

/** UsdLux lights and cameras for the USD readers: pass `extensions: [composition(), lights()]`. They load as `model.lights` and `model.cameras`. */
export function lights(): USDExtension {
  const hook: ExtensionHooks = { name: 'lux', scene };
  return hook;
}
