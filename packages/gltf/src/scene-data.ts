// glTF cameras and KHR_lights_punctual as plain data. Margo has no scene camera or light object to fill, so the loader
// hands them back and the app decides what to do with them.
import { composeMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { GLTFCameraDefinition, GLTFDocument, GLTFLightDefinition, GLTFNode } from '../../shared/gltf.js';
import { entry, integer } from './accessor.js';
import type { GLTFExtension, Model } from './index.js';

const LIGHTS = 'KHR_lights_punctual',
  invalid = (what: string) =>
    new TypeError(`Invalid glTF ${what}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`);

/** Where a camera or light sits: world space at load, with the model at its origin. */
export interface ScenePlacement {
  /** The node's name, '' when it has none. */
  name: string;
  /** The node it hangs on; follows the model if it moves. */
  node: MeshHandle;
  /** World position. */
  position: [number, number, number];
  /** Unit vector the camera looks along, or the light shines along (the node's -Z). */
  direction: [number, number, number];
  /** Column-major world matrix. */
  matrix: Float64Array;
}
/** A glTF camera. Distances are in metres, angles in radians. */
export type SceneCamera = ScenePlacement &
  (
    | {
        type: 'perspective';
        /** Vertical field of view. */
        yfov: number;
        znear: number;
        /** Absent for an infinite projection. */
        zfar?: number;
        /** Absent when the file leaves it to the canvas. */
        aspectRatio?: number;
      }
    | { type: 'orthographic'; xmag: number; ymag: number; znear: number; zfar: number }
  );
/** A KHR_lights_punctual light with the extension's defaults filled in. */
export interface SceneLight extends ScenePlacement {
  type: 'directional' | 'point' | 'spot';
  /** Linear RGB. Default [1, 1, 1]. */
  color: [number, number, number];
  /** Lux for directional, candela for point and spot. Default 1. */
  intensity: number;
  /** Metres; absent means no limit. Absent on directional lights. */
  range?: number;
  /** Spot only. Default 0. */
  innerConeAngle?: number;
  /** Spot only. Default pi / 4. */
  outerConeAngle?: number;
}
/** What {@link sceneData} returns: every camera and light on a node of the loaded scene. */
export interface SceneData {
  cameras: SceneCamera[];
  lights: SceneLight[];
}
const number = (value: unknown, what: string, min = -Infinity): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw invalid(what);
  return value;
};
const above = (value: unknown, what: string, floor: number): number => {
  if (number(value, what) <= floor) throw invalid(what);
  return value as number;
};
const nonzero = (value: unknown, what: string): number => {
  if (number(value, what) === 0) throw invalid(what);
  return value as number;
};
function cameraValues(camera: GLTFCameraDefinition) {
  if (camera.type === 'perspective' && camera.perspective) {
    const p = camera.perspective;
    return {
      type: 'perspective' as const,
      yfov: above(p.yfov, 'camera yfov', 0),
      znear: above(p.znear, 'camera znear', 0),
      ...(p.zfar === undefined ? {} : { zfar: above(p.zfar, 'camera zfar', p.znear) }),
      ...(p.aspectRatio === undefined ? {} : { aspectRatio: above(p.aspectRatio, 'camera aspect', 0) }),
    };
  }
  if (camera.type === 'orthographic' && camera.orthographic) {
    const o = camera.orthographic;
    return {
      type: 'orthographic' as const,
      xmag: nonzero(o.xmag, 'camera xmag'),
      ymag: nonzero(o.ymag, 'camera ymag'),
      znear: number(o.znear, 'camera znear', 0),
      zfar: above(o.zfar, 'camera zfar', o.znear),
    };
  }
  throw invalid('camera');
}
function lightValues(light: GLTFLightDefinition) {
  if (light.type !== 'directional' && light.type !== 'point' && light.type !== 'spot') throw invalid('light type');
  const color = light.color ?? [1, 1, 1];
  if (!Array.isArray(color) || color.length !== 3) throw invalid('light color');
  const values = {
    type: light.type,
    color: color.map((v) => number(v, 'light color', 0)) as [number, number, number],
    intensity: number(light.intensity ?? 1, 'light intensity', 0),
    ...(light.range === undefined || light.type === 'directional'
      ? {}
      : { range: above(light.range, 'light range', 0) }),
  };
  if (light.type !== 'spot') return values;
  const inner = number(light.spot?.innerConeAngle ?? 0, 'spot angle', 0),
    outer = above(light.spot?.outerConeAngle ?? Math.PI / 4, 'spot angle', inner);
  if (outer > Math.PI / 2) throw invalid('spot angle');
  return { ...values, innerConeAngle: inner, outerConeAngle: outer };
}
/** World matrices of the document's nodes, with parents before children. */
function worldMatrix(doc: GLTFDocument, id: number, parents: Int32Array, cache: Map<number, Float64Array>): Float64Array {
  const known = cache.get(id);
  if (known) return known;
  const node = doc.nodes![id],
    local = node.matrix
      ? Float64Array.from(node.matrix)
      : composeMatrix(
          node.translation ?? [0, 0, 0],
          node.rotation ?? [0, 0, 0, 1],
          node.scale ?? [1, 1, 1],
          new Float64Array(16),
        ),
    world = parents[id] < 0 ? local : multiplyMatrices(worldMatrix(doc, parents[id], parents, cache), local);
  cache.set(id, world);
  return world;
}
function placement(node: GLTFNode, handle: MeshHandle, matrix: Float64Array): ScenePlacement {
  const length = Math.hypot(matrix[8], matrix[9], matrix[10]) || 1;
  return {
    name: typeof node.name === 'string' ? node.name : '',
    node: handle,
    position: [matrix[12], matrix[13], matrix[14]],
    direction: [-matrix[8] / length, -matrix[9] / length, -matrix[10] / length],
    matrix,
  };
}
const results = /* @__PURE__ */ new WeakMap<Model, SceneData>();
const originals = /* @__PURE__ */ new WeakMap<object, GLTFNode[]>();

/**
 * Lets the light loader accept nodes with a camera or a `KHR_lights_punctual` light, instead of refusing them. Read
 * them back with {@link sceneData}. Nothing is created in the engine: the app decides what to do with them.
 * @example
 * const model = await loadGLTF(engine, '/shot.glb', { extensions: [sceneExtras] });
 * const { cameras, lights } = sceneData(model);
 */
export const sceneExtras: GLTFExtension = {
  handles: [LIGHTS],
  read(file) {
    const nodes = file.doc.nodes ?? [];
    originals.set(file, nodes);
    file.doc = {
      ...file.doc,
      nodes: nodes.map((node) => {
        if (node?.camera === undefined && !node?.extensions?.[LIGHTS]) return node;
        const { camera: _camera, extensions, ...rest } = node,
          { [LIGHTS]: _light, ...others } = extensions ?? {};
        return Object.keys(others).length ? { ...rest, extensions: others } : rest;
      }),
    };
  },
  finish(model, file, built) {
    const data: SceneData = { cameras: [], lights: [] },
      nodes = originals.get(file)!,
      doc = file.doc,
      lights = (doc.extensions?.[LIGHTS] as { lights?: GLTFLightDefinition[] } | undefined)?.lights,
      parents = new Int32Array(doc.nodes?.length ?? 0).fill(-1),
      cache = new Map<number, Float64Array>();
    doc.nodes?.forEach((node, id) => node.children?.forEach((child) => (parents[child] = id)));
    nodes.forEach((node, id) => {
      const handle = built.nodes[id],
        light = node?.extensions?.[LIGHTS];
      if (!handle || (node.camera === undefined && !light)) return;
      const where = placement(node, handle, worldMatrix(doc, id, parents, cache));
      if (node.camera !== undefined)
        data.cameras.push({ ...where, ...cameraValues(entry(doc.cameras, node.camera, 'camera')) });
      if (light) data.lights.push({ ...where, ...lightValues(entry(lights, integer(light.light, 'light'), 'light')) });
    });
    results.set(model, data);
  },
};
/** The cameras and lights of a model loaded with {@link sceneExtras}; both empty for any other model. */
export function sceneData(model: Model): SceneData {
  return results.get(model) ?? { cameras: [], lights: [] };
}
