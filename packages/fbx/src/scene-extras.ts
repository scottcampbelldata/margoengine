// FBX cameras and lights as glTF cameras and KHR_lights_punctual lights. Property names and defaults follow the public
// FBX SDK class reference (FbxCamera, FbxLight); the values are checked against files from Blender's exporter.
import type { CameraData, ExportNode, LightData } from '@margoengine/exporters';
import { objectName, property, type FBXNode } from './document.js';
import type { ExtensionHooks, FBXExtension } from './extension.js';
import { decomposeTRS } from './math.js';
import { children, type SceneContext } from './scene.js';

const RADIANS = Math.PI / 180,
  INCH_MM = 25.4;

/**
 * Reads a number from the object, else the class default of the SDK reference; a value of the wrong kind is the default.
 * The file's own `Definitions` are no help: Blender's one light template holds the grey of its null template, and it
 * leaves out a white light's colour.
 */
function reader(source: FBXNode) {
  return (name: string, fallback: number): number => {
    const value = Number(property(source, name, fallback));
    return Number.isFinite(value) ? value : fallback;
  };
}

function colorOf(source: FBXNode): number[] {
  const value = property(source, 'Color', [1, 1, 1]);
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => !Number.isFinite(v) || v < 0))
    throw new RangeError(`Invalid FBX light color: ${objectName(source)}; re-export the file, it looks damaged`);
  return value.map((v) => Math.min(1, v));
}

/** Rotation of a helper node whose -Z and +Y land on the FBX directions, in the converted axes. */
function aim(ctx: SceneContext, forward: readonly number[], up: readonly number[]): number[] {
  const unit = (v: readonly number[]) => {
      const b = ctx.basis,
        x = b[0] * v[0] + b[4] * v[1] + b[8] * v[2],
        y = b[1] * v[0] + b[5] * v[1] + b[9] * v[2],
        z = b[2] * v[0] + b[6] * v[1] + b[10] * v[2],
        length = Math.hypot(x, y, z);
      return [x / length, y / length, z / length];
    },
    f = unit(forward),
    u = unit(up),
    r = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
  return decomposeTRS([r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, 0, 0, 0, 1]).rotation;
}

/** File units to metres, the length of the basis's first column. */
const metres = (ctx: SceneContext): number => Math.hypot(ctx.basis[0], ctx.basis[1], ctx.basis[2]);

function perspective(read: ReturnType<typeof reader>, aspect: number): number {
  const half = (degrees: number) => Math.tan((degrees * RADIANS) / 2),
    mode = read('ApertureMode', 2),
    fit = read('GateFit', 0),
    film = (inches: number) => (inches * INCH_MM) / (2 * read('FocalLength', 0)),
    filmY = film(read('FilmHeight', 0)),
    filmX = film(read('FilmWidth', 0));
  let tangent: number;
  // Film and lens decide the view in focal length mode, and a gate fit says which side of the film the image fills.
  if (mode === 3) tangent = fit === 2 && aspect > 0 && filmX > 0 ? filmX / aspect : filmY;
  else if (mode === 1) tangent = half(read('FieldOfView', 0)) / (aspect > 0 ? aspect : 1);
  else if (mode === 0) tangent = half(read('FieldOfViewY', read('FieldOfView', 0)));
  else tangent = half(read('FieldOfView', 0));
  if (!(tangent > 0) || !Number.isFinite(tangent)) tangent = filmY;
  if (!(tangent > 0) || !Number.isFinite(tangent))
    throw new RangeError('Invalid FBX camera field of view; re-export the file, it looks damaged');
  return 2 * Math.atan(tangent);
}

function camera(ctx: SceneContext, source: FBXNode, name: string): CameraData {
  const read = reader(source),
    unit = metres(ctx),
    width = read('AspectWidth', 0),
    height = read('AspectHeight', 0),
    aspect = width > 0 && height > 0 ? width / height : read('FilmAspectRatio', 0),
    near = read('NearPlane', 10) * unit,
    far = read('FarPlane', 4000) * unit,
    znear = near > 0 ? near : 1e-3 * unit;
  if (read('CameraProjectionType', 0) === 1) {
    const span = read('OrthoZoom', 1) * unit;
    if (!(span > 0)) throw new RangeError('Invalid FBX camera zoom; re-export the file, it looks damaged');
    return {
      type: 'orthographic',
      name,
      orthographic: {
        xmag: span / 2,
        ymag: span / 2 / (aspect > 0 ? aspect : 1),
        znear,
        zfar: far > znear ? far : znear * 1e6,
      },
    };
  }
  return {
    type: 'perspective',
    name,
    perspective: {
      yfov: perspective(read, aspect),
      znear,
      ...(far > znear ? { zfar: far } : {}),
      ...(aspect > 0 ? { aspectRatio: aspect } : {}),
    },
  };
}

function light(ctx: SceneContext, source: FBXNode, name: string): LightData {
  const read = reader(source),
    kind = read('LightType', 0),
    outer = Math.min(180, Math.max(0, read('OuterAngle', 45))),
    inner = Math.min(outer, Math.max(0, read('InnerAngle', 0))),
    end = read('EnableFarAttenuation', 0) ? read('FarAttenuationEnd', 0) * metres(ctx) : 0,
    out: LightData = {
      type: kind === 1 ? 'directional' : kind === 2 ? 'spot' : 'point',
      name,
      color: colorOf(source),
      intensity: Math.max(0, read('Intensity', 100)) / 100,
      extras: { fbxLightType: kind, fbxDecayType: read('DecayType', 0) },
    };
  if (end > 0 && kind !== 1) out.range = end;
  if (kind === 2) {
    // FBX angles span the whole cone, glTF's run from its axis, and glTF wants the inner one strictly smaller.
    out.outerConeAngle = Math.max((outer * RADIANS) / 2, 1e-4);
    out.innerConeAngle = Math.min((inner * RADIANS) / 2, out.outerConeAngle * 0.999);
  }
  return out;
}

/**
 * Turns FBX cameras and lights into glTF cameras and punctual lights, which load as `model.cameras` and `model.lights`.
 * Pass it in `extensions`: `loadFBX(engine, url, {extensions: [sceneExtras]})`.
 */
export const sceneExtras: FBXExtension = {
  name: 'scene-extras',
  scene(ctx: SceneContext): boolean {
    const settings = ctx.document.roots.find((n) => n.name === 'GlobalSettings'),
      active = settings && property(settings, 'DefaultCamera', undefined);
    let kept = false;
    for (const [key, node] of ctx.nodes) {
      for (const source of children(ctx, key)) {
        if (source.name !== 'NodeAttribute') continue;
        const kind = source.properties[2];
        if (kind !== 'Camera' && kind !== 'Light') continue;
        ctx.signal?.throwIfAborted();
        const helper: ExportNode = { name: `${node.name ?? kind} ${kind.toLowerCase()}`, children: [] };
        if (kind === 'Camera') {
          // An FBX camera looks down its +X with +Y up; a glTF camera down -Z.
          helper.rotation = aim(ctx, [1, 0, 0], [0, 1, 0]);
          helper.camera = camera(ctx, source, node.name ?? 'Camera');
          if (active === node.name) helper.camera.extras = { defaultCamera: true };
        } else {
          // An FBX light shines down its -Y; a glTF light down -Z.
          helper.rotation = aim(ctx, [0, -1, 0], [0, 0, 1]);
          helper.light = light(ctx, source, node.name ?? 'Light');
        }
        (node.children as ExportNode[]).push(helper);
        kept = true;
      }
    }
    return kept;
  },
} as ExtensionHooks;
