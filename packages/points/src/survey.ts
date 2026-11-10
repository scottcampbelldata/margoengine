import { PointCloud } from './cloud.js';

/** Positions in local space and an optional column-major local-to-world transform. */
export interface SurveyPoints {
  positions: ArrayLike<number>;
  matrix?: ArrayLike<number>;
}

export function checkPoints(data: SurveyPoints): void {
  if (!data?.positions || data.positions.length % 3)
    throw new TypeError('Pass xyz positions with a length divisible by three');
  if (data instanceof PointCloud && data.attachedMesh)
    throw new TypeError('For an attached cloud, pass {positions, matrix: worldMatrix} explicitly');
  if (data.matrix && (data.matrix.length !== 16 || !Array.from(data.matrix).every(Number.isFinite)))
    throw new TypeError('Pass a finite column-major matrix of 16 numbers');
}

export function transformPoint(p: ArrayLike<number>, i: number, m?: ArrayLike<number>): [number, number, number] {
  const x = p[i * 3],
    y = p[i * 3 + 1],
    z = p[i * 3 + 2];
  if (!m) return [x, y, z];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/** Copy selected local point records, preserving material, HDR colours, normals and source transform. */
export function subsetCloud(source: PointCloud, indices: ArrayLike<number>): PointCloud {
  const copy = (a: ArrayLike<number>, stride: number) => {
    const out = new Float32Array(indices.length * stride);
    for (let i = 0; i < indices.length; i++)
      for (let c = 0; c < stride; c++) out[i * stride + c] = a[indices[i] * stride + c];
    return out;
  };
  const cloud = new PointCloud({
    positions: copy(source.positions, 3),
    normals: source.normals ? copy(source.normals, 3) : null,
    sizes: source.sizes ? copy(source.sizes, 1) : null,
    colors: source.floatColors
      ? copy(source.floatColors, 4)
      : source.colors
        ? new Uint8Array(indices.length * 4)
        : null,
    colorComponents: 4,
    colorFormat: source.colorFormat,
    colorSpace: source.colorSpace,
    matrix: source.matrix,
    material: source.material,
    blockSize: source.blockSize,
    seed: source.seed,
    cullMargin: source.cullMargin,
    name: source.name,
  });
  if (source.colors && !source.floatColors)
    for (let i = 0; i < indices.length; i++) cloud.colors![i] = source.colors[indices[i]];
  cloud.attach(source.attachedMesh);
  return cloud;
}
