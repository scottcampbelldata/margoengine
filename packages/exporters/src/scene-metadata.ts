// Camera and punctual-light attachments from the loaded model's live public records. Keep runtime node handles out
// of JSON, and snapshot nested values before the model writer awaits texture encoding.
import type { GLTFCamera, GLTFLight, PBRModel } from '@margoengine/gltf-pro';
import type { GLTFCameraDefinition, GLTFLightDefinition } from '../../shared/gltf.js';
import type { Bin } from './container.js';

function numeric(value: number, subject: string, valid: (value: number) => boolean): number {
  if (typeof value !== 'number') throw new TypeError(`${subject} must be a number; update the live camera or light`);
  if (!Number.isFinite(value) || !valid(value))
    throw new RangeError(`${subject} is outside its glTF range; update the live camera or light`);
  return value;
}

function named<T extends { name?: string }>(out: T, name?: string): T {
  if (name !== undefined) {
    if (typeof name !== 'string') throw new TypeError('Camera or light name must be a string; update its name');
    out.name = name;
  }
  return out;
}

function cameraDefinition(camera: GLTFCamera): GLTFCameraDefinition {
  const out = named<GLTFCameraDefinition>({ type: camera.type }, camera.name);
  if (camera.type !== 'perspective' && camera.type !== 'orthographic')
    throw new TypeError('Camera type is unsupported; use perspective or orthographic');
  const p = camera[camera.type];
  if (!p || typeof p !== 'object' || Array.isArray(p))
    throw new TypeError(`Camera ${camera.type} projection is missing; supply its projection values`);
  if (camera.type === 'perspective') {
    const p = camera.perspective!,
      projection = {
        yfov: numeric(p.yfov, 'Camera yfov', (v) => v > 0),
        znear: numeric(p.znear, 'Camera znear', (v) => v > 0),
      } as NonNullable<GLTFCameraDefinition['perspective']>;
    if (p.zfar !== undefined) projection.zfar = numeric(p.zfar, 'Camera zfar', (v) => v > p.znear);
    if (p.aspectRatio !== undefined)
      projection.aspectRatio = numeric(p.aspectRatio, 'Camera aspectRatio', (v) => v > 0);
    out.perspective = projection;
  } else {
    const p = camera.orthographic!;
    out.orthographic = {
      xmag: numeric(p.xmag, 'Camera xmag', (v) => v !== 0),
      ymag: numeric(p.ymag, 'Camera ymag', (v) => v !== 0),
      znear: numeric(p.znear, 'Camera znear', (v) => v >= 0),
      zfar: numeric(p.zfar, 'Camera zfar', (v) => v > p.znear),
    };
  }
  return out;
}

function lightDefinition(light: GLTFLight): GLTFLightDefinition {
  if (light.type !== 'directional' && light.type !== 'point' && light.type !== 'spot')
    throw new TypeError('Light type is unsupported; use directional, point or spot');
  if (!Array.isArray(light.color) || light.color.length !== 3)
    throw new TypeError('Light color must contain three numbers; supply linear RGB values');
  const out = named<GLTFLightDefinition>(
    {
      type: light.type,
      color: Array.from(light.color, (v) => numeric(v, 'Light color', (v) => v >= 0 && v <= 1)),
      intensity: numeric(light.intensity, 'Light intensity', (v) => v >= 0),
    },
    light.name,
  );
  if (light.type !== 'directional' && light.range !== undefined)
    out.range = numeric(light.range, 'Light range', (v) => v > 0);
  if (light.type === 'spot') {
    const inner = numeric(light.innerConeAngle ?? 0, 'Spot innerConeAngle', (v) => v >= 0 && v < Math.PI / 2),
      outer = numeric(light.outerConeAngle ?? Math.PI / 4, 'Spot outerConeAngle', (v) => v > inner && v <= Math.PI / 2);
    out.spot = { innerConeAngle: inner, outerConeAngle: outer };
  }
  return out;
}

function nodeIndex(model: PBRModel, map: Int32Array, record: GLTFCamera | GLTFLight): number {
  const i = record.nodeIndex;
  if (!Number.isSafeInteger(i) || i < 0 || i >= map.length || model.nodes[i] !== record.node)
    throw new TypeError('Camera or light node does not belong to its model; use a matching node and nodeIndex');
  return map[i];
}

/** @internal Writes kept camera/light attachments; returns whether this model emitted a punctual light. */
export function writeSceneMetadata(w: Bin, model: PBRModel, map: Int32Array): boolean {
  for (const camera of model.cameras ?? []) {
    const i = nodeIndex(model, map, camera);
    if (i >= 0) w.json.nodes[i].camera = w.list('cameras', cameraDefinition(camera));
  }
  let emittedLight = false;
  for (const light of model.lights ?? []) {
    const i = nodeIndex(model, map, light);
    if (i < 0) continue;
    const definition = lightDefinition(light),
      extensions = (w.json.extensions ??= {}),
      lights = ((extensions.KHR_lights_punctual ??= {}).lights ??= []),
      node = w.json.nodes[i];
    (node.extensions ??= {}).KHR_lights_punctual = { light: lights.length };
    lights.push(definition);
    emittedLight = true;
  }
  return emittedLight;
}
