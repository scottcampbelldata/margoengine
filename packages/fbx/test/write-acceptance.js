// Writes the files for the manual FBX import check: node packages/fbx/test/write-acceptance.js <folder>. No check runs it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { exportFBX } from '../dist/export.js';

const folder = process.argv[2];
if (!folder) throw new TypeError('Name the folder to write into: node packages/fbx/test/write-acceptance.js <folder>');
mkdirSync(folder, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]),
    out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
};
/** A 2x2 checker PNG: red, white, white, blue. */
function checker() {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(2, 0);
  head.writeUInt32BE(2, 4);
  head[8] = 8;
  head[9] = 2;
  const rows = Buffer.from([0, 255, 0, 0, 255, 255, 255, 0, 255, 255, 255, 0, 0, 255]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', head),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** A square column 1 m wide and 2 m tall on the origin: four sides of two quads, weighted from the foot to the top. */
function column() {
  const positions = [],
    normals = [],
    uvs = [],
    indices = [],
    faceSizes = [],
    joints = [],
    weights = [],
    corners = [
      [-0.5, 0.5],
      [0.5, 0.5],
      [0.5, -0.5],
      [-0.5, -0.5],
    ],
    outward = [
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, -1],
      [-1, 0, 0],
    ];
  for (let side = 0; side < 4; side++) {
    const [ax, az] = corners[side],
      [bx, bz] = corners[(side + 1) % 4];
    for (let level = 0; level < 2; level++) {
      const start = positions.length / 3;
      for (const [x, z, y, u] of [
        [ax, az, level, 0],
        [bx, bz, level, 1],
        [bx, bz, level + 1, 1],
        [ax, az, level + 1, 0],
      ]) {
        positions.push(x, y, z);
        normals.push(...outward[side]);
        uvs.push(u, 1 - y / 2);
        joints.push(0, 1, 0, 0);
        weights.push(1 - y / 2, y / 2, 0, 0);
      }
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      faceSizes.push(4);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    faceSizes: new Uint8Array(faceSizes),
    joints: new Uint16Array(joints),
    weights: new Float32Array(weights),
  };
}

const material = {
    name: 'Checker',
    color: [1, 1, 1, 1],
    roughness: 0.5,
    baseColorTexture: { image: checker(), mimeType: 'image/png', name: 'checker' },
  },
  { joints: _joints, weights: _weights, ...plain } = column(),
  hip = { name: 'Hip' },
  knee = { name: 'Knee', translation: [0, 1, 0] },
  s = Math.SQRT1_2;
hip.children = [knee];
const leg = {
    name: 'Leg',
    geometry: column(),
    material,
    skin: {
      name: 'Rig',
      joints: [hip, knee],
      // prettier-ignore
      inverseBindMatrices: new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
      ]),
    },
  },
  grower = {
    name: 'Grower',
    material,
    morphWeights: [0],
    geometry: {
      ...plain,
      morphs: [
        {
          name: 'Grow',
          // The top ring rises 1 m at weight 1.
          positions: Float32Array.from({ length: plain.positions.length }, (_, i) =>
            i % 3 === 1 && plain.positions[i] === 2 ? 1 : 0,
          ),
        },
      ],
    },
  };
const scenes = {
  // A textured column, 2 m tall, standing on the origin.
  'mesh-textured': { nodes: [{ name: 'Column', geometry: plain, material }] },
  // The column bends 90 degrees at the knee over one second, and back.
  'skin-clip': {
    nodes: [hip, leg],
    animations: [
      {
        name: 'Bend',
        channels: [
          {
            node: knee,
            path: 'rotation',
            times: new Float32Array([0, 1, 2]),
            values: new Float32Array([0, 0, 0, 1, s, 0, 0, s, 0, 0, 0, 1]),
          },
        ],
      },
    ],
  },
  // The column's top rises to 3 m over one second, and back.
  'morph-clip': {
    nodes: [grower],
    animations: [
      {
        name: 'Grow',
        channels: [
          { node: grower, path: 'weights', times: new Float32Array([0, 1, 2]), values: new Float32Array([0, 1, 0]) },
        ],
      },
    ],
  },
};

for (const [name, scene] of Object.entries(scenes))
  for (const [suffix, ascii] of [
    ['', false],
    ['-ascii', true],
  ]) {
    const path = resolve(folder, `${name}${suffix}.fbx`),
      { fbx } = await exportFBX(scene, { ascii });
    writeFileSync(path, fbx);
    console.log(path, fbx.length);
  }
