// Shared scene for the batch 168 tiles measurement.
// An explicit REPLACE quadtree in metres, y-up, no geodetic transform, so both sides
// see the same boxes in float32. Every tile has a content URI. One GLB is served for
// all of them: selection uses the JSON bounding volume and geometricError.
// Screen-space error is geometricError * screenHeight / (2 * distance * tan(fov / 2)),
// the same formula as Tileset.screenSpaceError. The rival's errorTarget is set to the
// same pixel budget (its README default is 6).

import { boxGLB } from '../packages/tiles/tests/generator.js';

export const TILES_SCENE = {
  levels: 7,
  size: 256,
  errorFactor: 0.5,
  maximumScreenSpaceError: 16,
  camera: {
    position: [0, 80, 400],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov: 50,
    width: 1080,
    height: 1080,
    near: 0.1,
    far: 2000,
  },
};

const encoder = new TextEncoder();

function childTile(level, x, y) {
  const { levels, size, errorFactor } = TILES_SCENE;
  const n = 2 ** level;
  const cell = size / n;
  const cx = -size / 2 + cell * (x + 0.5);
  const cz = -size / 2 + cell * (y + 0.5);
  const height = 20;
  const leaf = level === levels - 1;
  const tile = {
    boundingVolume: {
      box: [cx, height / 2, cz, cell / 2, 0, 0, 0, height / 2 + 1, 0, 0, 0, cell / 2],
    },
    geometricError: leaf ? 0 : cell * errorFactor,
    refine: 'REPLACE',
    content: { uri: `tiles/${level}/${x}/${y}.glb` },
  };
  if (!leaf) {
    tile.children = [0, 1, 2, 3].map((i) => childTile(level + 1, 2 * x + (i & 1), 2 * y + (i >> 1)));
  }
  return tile;
}

/** Tileset JSON plus the one GLB every content URI serves. */
export function buildTilesScene() {
  const { size } = TILES_SCENE;
  const root = childTile(0, 0, 0);
  const tileset = {
    asset: { version: '1.1' },
    geometricError: size,
    root,
  };
  return {
    json: tileset,
    jsonBytes: encoder.encode(JSON.stringify(tileset)),
    glb: boxGLB(),
  };
}

export function tilePath(id) {
  const match = String(id).match(/tiles\/\d+\/\d+\/\d+\.glb$/);
  if (!match) throw new Error(`no tile path in ${id}`);
  return match[0];
}

/** FNV-1a of the sorted paths, so a test can lock the selected set. */
export function selectionChecksum(paths) {
  const text = [...paths].sort().join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a) {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** Column-major view matrix, OpenGL look-at (camera looks down -Z). */
export function lookAt(eye, target, up) {
  const forward = norm(sub(target, eye));
  const side = norm(cross(forward, up));
  const cameraUp = cross(side, forward);
  const m = new Float64Array(16);
  m[0] = side[0];
  m[1] = cameraUp[0];
  m[2] = -forward[0];
  m[4] = side[1];
  m[5] = cameraUp[1];
  m[6] = -forward[1];
  m[8] = side[2];
  m[9] = cameraUp[2];
  m[10] = -forward[2];
  m[12] = -dot(side, eye);
  m[13] = -dot(cameraUp, eye);
  m[14] = dot(forward, eye);
  m[15] = 1;
  return m;
}

/** Column-major perspective, vertical fov in degrees, WebGL clip z in -1..1. */
export function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function row(m, r) {
  return [m[r], m[4 + r], m[8 + r], m[12 + r]];
}

function add4(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}

function sub4(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
}

/**
 * Six inward frustum planes, 24 numbers [a, b, c, d] with ax + by + cz + d >= 0 inside.
 * `inside` is a point that must land inside; a plane that fails that is flipped.
 */
export function frustumPlanes(camera, inside) {
  const { position, target, up, fov, width, height, near, far } = camera;
  const view = lookAt(position, target, up);
  const clip = multiply(perspective(fov, width / height, near, far), view);
  const r0 = row(clip, 0);
  const r1 = row(clip, 1);
  const r2 = row(clip, 2);
  const r3 = row(clip, 3);
  const raw = [add4(r3, r0), sub4(r3, r0), add4(r3, r1), sub4(r3, r1), add4(r3, r2), sub4(r3, r2)];
  const planes = [];
  for (const plane of raw) {
    const length = Math.hypot(plane[0], plane[1], plane[2]);
    let a = plane[0] / length;
    let b = plane[1] / length;
    let c = plane[2] / length;
    let d = plane[3] / length;
    if (a * inside[0] + b * inside[1] + c * inside[2] + d < 0) {
      a = -a;
      b = -b;
      c = -c;
      d = -d;
    }
    planes.push(a, b, c, d);
  }
  return planes;
}

/** The camera and planes the measurement uses. `inside` is the tileset origin, in front of the camera. */
export function sceneView() {
  const camera = TILES_SCENE.camera;
  return {
    position: camera.position,
    planes: frustumPlanes(camera, camera.target),
    screenHeight: camera.height,
    fov: camera.fov,
  };
}
