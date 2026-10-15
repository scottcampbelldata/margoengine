// Orthographic terms of a WebGPU (reversed-Z) clip matrix, or null when it is perspective (clip w depends on position).
// Works with any projection that writes camera.matrix (core or @margoengine/cameras). Lengths are per world unit;
// near/far are view distances from `eye` (the view origin, camera.position) and may be negative; ox/oy are the NDC
// position of the eye, i.e. the frustum's off-centre offset.
export function orthographic(m, eye) {
  if (!m || m[3] || m[7] || m[11]) return null;
  const at = (row) => m[row] * eye[0] + m[4 + row] * eye[1] + m[8 + row] * eye[2] + m[12 + row],
    sz = Math.hypot(m[2], m[6], m[10]),
    z = at(2);
  return {
    sx: Math.hypot(m[0], m[4], m[8]),
    sy: Math.hypot(m[1], m[5], m[9]),
    sz,
    ox: at(0),
    oy: at(1),
    near: (z - 1) / sz,
    far: z / sz,
  };
}
