//! The CPU route of `@margoengine/physics/gpu-cloth` (docs/clean-room.md, "GPU cloth"): the passes the GPU runs
//! (gpu-cloth-shaders.ts), in the same order, on the WebGL2 compatibility layer and in Node. Position-based dynamics
//! (Mueller et al. 2007) with the velocity as state, compliant XPBD distance constraints (Macklin, Mueller and Chentanez
//! 2016) solved once a substep (Macklin et al. 2019) one edge colour at a time, long range attachments (Kim, Chentanez
//! and Mueller 2012), position-based Coulomb friction (Macklin et al. 2014) and a flat plate's drag (Hoerner 1965).
//!
//! Stateless: every array lives in the memory the host made for one cloth, named by a header of u32 words (`H_*`).
//! Arithmetic is f64 on values read from f32 and stored back as f32, as the GPU stores them. No statics: the module has
//! no data section.
#![no_std]
#![cfg(target_arch = "wasm32")]

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

// Header words (u32): sizes, then byte offsets of the arrays.
const H_COUNT: usize = 0; // particles N
const H_STATE: usize = 1; // f32 [12 N]: particles (xyz, inverse mass), velocities, predictions
const H_NORMALS: usize = 2; // f32 [4 N]: unit normal xyz, w the particle's rest area share
const H_VERTICES: usize = 3; // f32 [20 N]: the draw vertices
const H_EDGES: usize = 4; // u32 [4 per edge]: i, j, rest length bits, kind; i = NO_EDGE pads
const H_COLORS: usize = 5; // u32 [2 per colour]: first edge, edges
const H_COLOR_COUNT: usize = 6;
const H_ADJACENCY: usize = 7; // u32 [N + 1 offsets, then triangle indices]
const H_TRIANGLES: usize = 8; // u32 [3 per triangle]
const H_UVS: usize = 9; // f32 [2 N]
const H_SLOTS: usize = 10; // f32 [64 per substep]: the substep records (packClothFrame)
const H_SLOT_COUNT: usize = 11;
const H_SUBSTEPS: usize = 12; // substeps a step: the surface pass ends each step
const H_PINS: usize = 13; // f32 [8 per pin]: from xyz, particle index bits, to xyz, 0
const H_PIN_COUNT: usize = 14;
const H_COLLIDERS: usize = 15; // f32 [32 per collider]
const H_COLLIDER_COUNT: usize = 16;
const H_SDF: usize = 17; // f32 samples of every sdf collider
const H_TETHERS: usize = 18; // u32 [2 per particle]: anchor, rest distance bits; 0 when the pass does not run
const H_WORK: usize = 19; // u32 [4]: work counts of the call (substeps, particle updates, edge solves, collider tests)
const H_TRIANGLE_COUNT: usize = 20;
const H_BARRIER: usize = 21; // u32 [2]: the threads' barrier (arrived, generation); unused by one thread

const NO_EDGE: u32 = 0xffff_ffff;
const SLOT: usize = 64;
const COLLIDER: usize = 32;
const VERTEX: usize = 20;
const SPHERE: u32 = 0;
const CAPSULE: u32 = 1;
const BOX: u32 = 2;
const PLANE: u32 = 3;

/// An array in the cloth's memory, indexed without a bounds check: the host sizes every array from the header it
/// writes (gpu-cloth.ts), and a checked index would put a panic location (a data section) into a stateless module.
#[derive(Clone, Copy)]
struct Buf<T>(*mut T);
impl<T> core::ops::Index<usize> for Buf<T> {
    type Output = T;
    fn index(&self, i: usize) -> &T {
        unsafe { &*self.0.add(i) }
    }
}
impl<T> core::ops::IndexMut<usize> for Buf<T> {
    fn index_mut(&mut self, i: usize) -> &mut T {
        unsafe { &mut *self.0.add(i) }
    }
}
type F = Buf<f32>;
type U = Buf<u32>;

struct Header(*const u32);
impl Header {
    fn word(&self, k: usize) -> usize {
        unsafe { *self.0.add(k) as usize }
    }
    fn f32s(&self, k: usize, _len: usize) -> F {
        Buf(self.word(k) as *mut f32)
    }
    fn u32s(&self, k: usize, _len: usize) -> U {
        Buf(self.word(k) as *mut u32)
    }
}

use core::arch::wasm32::{f64x2_extract_lane, f64x2_floor, f64x2_splat, f64x2_sqrt};

fn sqrt(x: f64) -> f64 {
    // f64x2.sqrt, correctly rounded as JavaScript's Math.sqrt and WGSL's sqrt.
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}
fn len3(x: f64, y: f64, z: f64) -> f64 {
    sqrt(x * x + y * y + z * z)
}
fn floor(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(x)))
}

/// sin and cos of `x`: Cody and Waite's reduction by pi / 2 in two parts, then the Taylor series on [-pi/4, pi/4] (error
/// under 1e-14 there, the terms through x^13 and x^14).
fn sin_cos(x: f64) -> (f64, f64) {
    const TWO_OVER_PI: f64 = 0.636_619_772_367_581_4;
    const PIO2_HI: f64 = 1.570_796_326_734_125_6; // pi / 2 to 33 bits
    const PIO2_LO: f64 = 6.077_100_506_506_192e-11; // the rest
    let k = floor(x * TWO_OVER_PI + 0.5);
    let r = (x - k * PIO2_HI) - k * PIO2_LO;
    let r2 = r * r;
    let s = r
        * (1.0
            + r2 * (-1.0 / 6.0
                + r2 * (1.0 / 120.0
                    + r2 * (-1.0 / 5040.0 + r2 * (1.0 / 362_880.0 + r2 * (-1.0 / 39_916_800.0 + r2 / 6_227_020_800.0))))));
    let c = 1.0
        + r2 * (-0.5
            + r2 * (1.0 / 24.0
                + r2 * (-1.0 / 720.0
                    + r2 * (1.0 / 40_320.0 + r2 * (-1.0 / 3_628_800.0 + r2 * (1.0 / 479_001_600.0 - r2 / 87_178_291_200.0))))));
    // k mod 4 picks the quadrant.
    match (k - 4.0 * floor(k / 4.0)) as u32 {
        0 => (s, c),
        1 => (c, -s),
        2 => (-s, -c),
        _ => (-c, s),
    }
}
fn sin(x: f64) -> f64 {
    sin_cos(x).0
}
fn cos(x: f64) -> f64 {
    sin_cos(x).1
}

/// The wind at a point and time: the base wind varied by `turbulence` in smooth gusts along and across it.
fn wind_at(w: [f64; 3], turbulence: f64, x: f64, y: f64, z: f64, t: f64) -> [f64; 3] {
    let gust = sin(0.9 * x + 1.7 * t) * cos(1.1 * z + 1.3 * t) + 0.5 * sin(2.3 * y - 2.9 * t + 1.1 * x);
    let speed = len3(w[0], w[1], w[2]);
    let side = turbulence * speed * 0.5 * sin(1.3 * x + 0.7 * z + 2.3 * t);
    let up = turbulence * speed * 0.3 * sin(0.8 * y + 1.9 * z - 1.7 * t);
    let k = 1.0 + turbulence * gust;
    let s = if speed == 0.0 { 1.0 } else { speed };
    [w[0] * k + side * -w[2] / s, w[1] * k + up, w[2] * k + side * w[0] / s]
}

/// Rotates `v` by the unit quaternion `q` (x, y, z, w).
fn rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [x, y, z, w] = q;
    let tx = 2.0 * (y * v[2] - z * v[1]);
    let ty = 2.0 * (z * v[0] - x * v[2]);
    let tz = 2.0 * (x * v[1] - y * v[0]);
    [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
    ]
}

/// The normalised blend of two quaternions by `t`, along the shorter way.
fn nlerp(c: F, at: usize, to: usize, t: f64) -> [f64; 4] {
    let mut sign = 0.0;
    for k in 0..4 {
        sign += c[at + k] as f64 * c[to + k] as f64;
    }
    let s = if sign < 0.0 { -1.0 } else { 1.0 };
    let mut q = [0.0; 4];
    for k in 0..4 {
        q[k] = c[at + k] as f64 + (s * c[to + k] as f64 - c[at + k] as f64) * t;
    }
    let l = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

/// A collider's pose at the substep's end and start.
#[derive(Clone, Copy)]
struct Pose {
    x0: [f64; 3],
    x1: [f64; 3],
    q0: [f64; 4],
    q1: [f64; 4],
    back: [f64; 4],
}
fn collider_pose(d: F, c: usize, a0: f64, a1: f64) -> Pose {
    let o = c * COLLIDER;
    let mut x0 = [0.0; 3];
    let mut x1 = [0.0; 3];
    for k in 0..3 {
        let from = d[o + 4 + k] as f64;
        let to = d[o + 12 + k] as f64;
        x1[k] = from + (to - from) * a1;
        x0[k] = from + (to - from) * a0;
    }
    let q1 = nlerp(d, o + 8, o + 16, a1);
    Pose { x0, x1, q0: nlerp(d, o + 8, o + 16, a0), q1, back: [-q1[0], -q1[1], -q1[2], q1[3]] }
}

/// A signed distance field's value and gradient (in the collider's space), or None outside its grid.
fn sample_sdf(d: F, du: U, o: usize, sdf: F, local: [f64; 3]) -> Option<[f64; 4]> {
    let size = [du[o + 28] as usize, du[o + 29] as usize, du[o + 30] as usize];
    let off = du[o + 1] as usize;
    let mut g = [0.0; 3];
    for k in 0..3 {
        g[k] = (local[k] - d[o + 20 + k] as f64) / d[o + 24 + k] as f64;
        if !(g[k] >= 0.0 && g[k] <= (size[k] - 1) as f64) {
            return None;
        }
    }
    let mut c = [0usize; 3];
    let mut f = [0.0; 3];
    for k in 0..3 {
        let cell = floor(g[k]);
        let most = (size[k] - 2) as f64;
        let cell = if cell < most { cell } else { most };
        c[k] = cell as usize;
        f[k] = g[k] - cell;
    }
    let sx = size[0];
    let sxy = sx * size[1];
    let b = off + c[0] + c[1] * sx + c[2] * sxy;
    let v = |i: usize, j: usize, k: usize| sdf[b + i + j * sx + k * sxy] as f64;
    let [fx, fy, fz] = f;
    let c00 = v(0, 0, 0) + (v(1, 0, 0) - v(0, 0, 0)) * fx;
    let c10 = v(0, 1, 0) + (v(1, 1, 0) - v(0, 1, 0)) * fx;
    let c01 = v(0, 0, 1) + (v(1, 0, 1) - v(0, 0, 1)) * fx;
    let c11 = v(0, 1, 1) + (v(1, 1, 1) - v(0, 1, 1)) * fx;
    let c0 = c00 + (c10 - c00) * fy;
    let c1 = c01 + (c11 - c01) * fy;
    let value = c0 + (c1 - c0) * fz;
    let dx0 = (v(1, 0, 0) - v(0, 0, 0)) * (1.0 - fy) + (v(1, 1, 0) - v(0, 1, 0)) * fy;
    let dx1 = (v(1, 0, 1) - v(0, 0, 1)) * (1.0 - fy) + (v(1, 1, 1) - v(0, 1, 1)) * fy;
    let gx = (dx0 * (1.0 - fz) + dx1 * fz) / d[o + 24] as f64;
    let gy = ((c10 - c00) * (1.0 - fz) + (c11 - c01) * fz) / d[o + 25] as f64;
    let gz = (c1 - c0) / d[o + 26] as f64;
    Some([value, gx, gy, gz])
}

/// One particle against one collider at `pose`: its new position, or None when it is clear of it.
#[allow(clippy::too_many_arguments)]
fn collide(
    state: F,
    p: usize,
    n_count: usize,
    i: usize,
    dt: f64,
    d: F,
    du: U,
    sdf: F,
    c: usize,
    pose: &Pose,
    thickness: f64,
) -> Option<[f64; 3]> {
    let o = c * COLLIDER;
    let kind = du[o];
    let x1 = pose.x1;
    let local = rotate(
        pose.back,
        [state[p] as f64 - x1[0], state[p + 1] as f64 - x1[1], state[p + 2] as f64 - x1[2]],
    );
    let mut n = [0.0, 1.0, 0.0];
    let dist;
    if kind == SPHERE || kind == CAPSULE {
        let h = if kind == CAPSULE { d[o + 3] as f64 } else { 0.0 };
        let cy = if local[1] < -h { -h } else if local[1] > h { h } else { local[1] };
        let v = [local[0], local[1] - cy, local[2]];
        let l = len3(v[0], v[1], v[2]);
        if l > 1e-9 {
            n = [v[0] / l, v[1] / l, v[2] / l];
        }
        dist = l - d[o + 2] as f64 - thickness;
    } else if kind == BOX {
        let e = [d[o + 20] as f64, d[o + 21] as f64, d[o + 22] as f64];
        let g = [local[0].abs() - e[0], local[1].abs() - e[1], local[2].abs() - e[2]];
        let m = [g[0].max(0.0), g[1].max(0.0), g[2].max(0.0)];
        let out = len3(m[0], m[1], m[2]);
        if out > 0.0 {
            let sign = |x: f64| if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { x };
            n = [sign(local[0]) * m[0] / out, sign(local[1]) * m[1] / out, sign(local[2]) * m[2] / out];
            dist = out - thickness;
        } else {
            let a = if g[0] >= g[1] && g[0] >= g[2] { 0 } else if g[1] >= g[2] { 1 } else { 2 };
            n = [0.0, 0.0, 0.0];
            n[a] = if local[a] < 0.0 { -1.0 } else { 1.0 };
            dist = g[a] - thickness;
        }
    } else if kind == PLANE {
        dist = local[1] - thickness;
    } else {
        let r = sample_sdf(d, du, o, sdf, local)?;
        let l = len3(r[1], r[2], r[3]);
        if !(l > 1e-12) {
            return None;
        }
        n = [r[1] / l, r[2] / l, r[3] / l];
        dist = r[0] - thickness;
    }
    if !(dist < 0.0) {
        return None;
    }
    // The point pushed out to the surface, in the collider's space, then in the world now and a substep ago.
    let lc = [local[0] - n[0] * dist, local[1] - n[1] * dist, local[2] - n[2] * dist];
    let w1 = rotate(pose.q1, lc);
    let w0 = rotate(pose.q0, lc);
    let nw = rotate(pose.q1, n);
    let px = x1[0] + w1[0];
    let py = x1[1] + w1[1];
    let pz = x1[2] + w1[2];
    // The slide over the substep relative to the surface's own motion; friction takes back up to mu times the depth of it.
    let v = (n_count + i) * 4;
    let q = (2 * n_count + i) * 4;
    let sx = state[q] as f64 - state[v] as f64 * dt;
    let sy = state[q + 1] as f64 - state[v + 1] as f64 * dt;
    let sz = state[q + 2] as f64 - state[v + 2] as f64 * dt;
    let rx = pose.x0[0] + w0[0] - sx;
    let ry = pose.x0[1] + w0[1] - sy;
    let rz = pose.x0[2] + w0[2] - sz;
    let rn = rx * nw[0] + ry * nw[1] + rz * nw[2];
    let tx = rx - nw[0] * rn;
    let ty = ry - nw[1] * rn;
    let tz = rz - nw[2] * rn;
    let lt = len3(tx, ty, tz);
    let k = if lt > 0.0 {
        let k = (d[o + 7] as f64 * -dist) / lt;
        if k < 1.0 { k } else { 1.0 }
    } else {
        0.0
    };
    Some([px - tx * k, py - ty * k, pz - tz * k])
}

/// Each particle's unit normal, the area-weighted sum of its triangles' (xyz of `normals`; w, its area, is kept).
fn write_normals(state: F, mut normals: F, adjacency: U, triangles: U, count: usize, lo: usize, hi: usize) {
    for v in lo..hi {
        let (mut nx, mut ny, mut nz) = (0.0, 0.0, 0.0);
        for k in adjacency[v] as usize..adjacency[v + 1] as usize {
            let t = adjacency[count + 1 + k] as usize * 3;
            let i0 = triangles[t] as usize * 4;
            let i1 = triangles[t + 1] as usize * 4;
            let i2 = triangles[t + 2] as usize * 4;
            let e1 = [
                state[i1] as f64 - state[i0] as f64,
                state[i1 + 1] as f64 - state[i0 + 1] as f64,
                state[i1 + 2] as f64 - state[i0 + 2] as f64,
            ];
            let e2 = [
                state[i2] as f64 - state[i0] as f64,
                state[i2 + 1] as f64 - state[i0 + 1] as f64,
                state[i2 + 2] as f64 - state[i0 + 2] as f64,
            ];
            nx += e1[1] * e2[2] - e1[2] * e2[1];
            ny += e1[2] * e2[0] - e1[0] * e2[2];
            nz += e1[0] * e2[1] - e1[1] * e2[0];
        }
        let l = len3(nx, ny, nz);
        if l > 0.0 {
            normals[v * 4] = (nx / l) as f32;
            normals[v * 4 + 1] = (ny / l) as f32;
            normals[v * 4 + 2] = (nz / l) as f32;
        }
    }
}

/// The surface pass: each particle's normal and tangent from the texture coordinates (Lengyel 2001) into `normals` and
/// the 20-float draw vertices.
fn write_surface(
    state: F,
    mut normals: F,
    mut vertices: F,
    adjacency: U,
    triangles: U,
    uvs: F,
    count: usize,
    lo: usize,
    hi: usize,
) {
    for v in lo..hi {
        let (mut nx, mut ny, mut nz) = (0.0f64, 0.0f64, 0.0f64);
        let (mut sx, mut sy, mut sz) = (0.0f64, 0.0f64, 0.0f64);
        let (mut bx, mut by, mut bz) = (0.0f64, 0.0f64, 0.0f64);
        for k in adjacency[v] as usize..adjacency[v + 1] as usize {
            let t = adjacency[count + 1 + k] as usize * 3;
            let i0 = triangles[t] as usize;
            let i1 = triangles[t + 1] as usize;
            let i2 = triangles[t + 2] as usize;
            let e1x = state[i1 * 4] as f64 - state[i0 * 4] as f64;
            let e1y = state[i1 * 4 + 1] as f64 - state[i0 * 4 + 1] as f64;
            let e1z = state[i1 * 4 + 2] as f64 - state[i0 * 4 + 2] as f64;
            let e2x = state[i2 * 4] as f64 - state[i0 * 4] as f64;
            let e2y = state[i2 * 4 + 1] as f64 - state[i0 * 4 + 1] as f64;
            let e2z = state[i2 * 4 + 2] as f64 - state[i0 * 4 + 2] as f64;
            nx += e1y * e2z - e1z * e2y;
            ny += e1z * e2x - e1x * e2z;
            nz += e1x * e2y - e1y * e2x;
            let du1 = uvs[i1 * 2] as f64 - uvs[i0 * 2] as f64;
            let dv1 = uvs[i1 * 2 + 1] as f64 - uvs[i0 * 2 + 1] as f64;
            let du2 = uvs[i2 * 2] as f64 - uvs[i0 * 2] as f64;
            let dv2 = uvs[i2 * 2 + 1] as f64 - uvs[i0 * 2 + 1] as f64;
            let det = du1 * dv2 - du2 * dv1;
            let r = if det == 0.0 { 0.0 } else { 1.0 / det };
            sx += (e1x * dv2 - e2x * dv1) * r;
            sy += (e1y * dv2 - e2y * dv1) * r;
            sz += (e1z * dv2 - e2z * dv1) * r;
            bx += (e2x * du1 - e1x * du2) * r;
            by += (e2y * du1 - e1y * du2) * r;
            bz += (e2z * du1 - e1z * du2) * r;
        }
        let o = v * 4;
        let out = v * VERTEX;
        let l = len3(nx, ny, nz);
        if l > 0.0 {
            nx /= l;
            ny /= l;
            nz /= l;
        } else {
            nx = normals[o] as f64;
            ny = normals[o + 1] as f64;
            nz = normals[o + 2] as f64;
        }
        normals[o] = nx as f32;
        normals[o + 1] = ny as f32;
        normals[o + 2] = nz as f32;
        let along = sx * nx + sy * ny + sz * nz;
        let mut tx = sx - nx * along;
        let mut ty = sy - ny * along;
        let mut tz = sz - nz * along;
        let mut tl = len3(tx, ty, tz);
        if !(tl > 1e-12) {
            if nx.abs() < 0.9 {
                (tx, ty, tz) = (0.0, -nz, ny);
            } else {
                (tx, ty, tz) = (nz, 0.0, -nx);
            }
            tl = len3(tx, ty, tz);
            if tl == 0.0 {
                tl = 1.0;
            }
        }
        vertices[out] = state[o];
        vertices[out + 1] = state[o + 1];
        vertices[out + 2] = state[o + 2];
        vertices[out + 3] = 1.0;
        vertices[out + 4] = nx as f32;
        vertices[out + 5] = ny as f32;
        vertices[out + 6] = nz as f32;
        vertices[out + 7] = 0.0;
        vertices[out + 8] = (tx / tl) as f32;
        vertices[out + 9] = (ty / tl) as f32;
        vertices[out + 10] = (tz / tl) as f32;
        let cx = ny * tz - nz * ty;
        let cy = nz * tx - nx * tz;
        let cz = nx * ty - ny * tx;
        vertices[out + 11] = if cx * bx + cy * by + cz * bz < 0.0 { -1.0 } else { 1.0 };
        vertices[out + 12] = uvs[v * 2];
        vertices[out + 14] = uvs[v * 2];
        vertices[out + 13] = uvs[v * 2 + 1];
        vertices[out + 15] = uvs[v * 2 + 1];
        for k in 16..20 {
            vertices[out + k] = 1.0;
        }
    }
}

/// The surface pass alone (the rest shape's draw vertices, and after a restore).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cloth_surface(header: *const u32) {
    let h = Header(header);
    let n = h.word(H_COUNT);
    let adj_len = h.u32s(H_ADJACENCY, n + 1)[n] as usize + n + 1;
    let triangles_len = 3 * h.word(H_TRIANGLE_COUNT);
    write_surface(
        h.f32s(H_STATE, 12 * n),
        h.f32s(H_NORMALS, 4 * n),
        h.f32s(H_VERTICES, VERTEX * n),
        h.u32s(H_ADJACENCY, adj_len),
        h.u32s(H_TRIANGLES, triangles_len),
        h.f32s(H_UVS, 2 * n),
        n,
        0,
        n,
    );
}

/// The first and one past the last of `count` items that thread `thread` of `threads` takes: a static schedule, the same
/// share every pass, so a pass's work by thread is fixed by the counts alone.
fn share(count: usize, thread: usize, threads: usize) -> (usize, usize) {
    (count * thread / threads, count * (thread + 1) / threads)
}

/// The threads' meeting point between passes (a counting barrier on two shared words: the threads arrived and the
/// generation). The last to arrive clears the count and raises the generation; the others spin on it. Passes are short and
/// evenly shared, so a wait is short; between frames the threads wait in their host (thread.ts) on the frame's go word.
/// One thread never waits. In the shared build the atomics are the memory's own (atomic loads and adds of the threads
/// proposal); the single-threaded build never reaches them.
struct Barrier {
    words: *mut u32,
    threads: u32,
}

impl Barrier {
    fn meet(&self) {
        if self.threads <= 1 {
            return;
        }
        use core::sync::atomic::{AtomicU32, Ordering};
        let arrived = unsafe { &*(self.words as *const AtomicU32) };
        let generation = unsafe { &*(self.words.add(1) as *const AtomicU32) };
        let seen = generation.load(Ordering::Acquire);
        if arrived.fetch_add(1, Ordering::AcqRel) + 1 == self.threads {
            arrived.store(0, Ordering::Release);
            generation.fetch_add(1, Ordering::AcqRel);
            return;
        }
        while generation.load(Ordering::Acquire) == seen {
            core::hint::spin_loop();
        }
    }
}

/// The frame's substeps: for each, the normals (for the drag), integrate, pins, the edges colour by colour, tethers and
/// colliders, in the GPU's order, and the surface pass after each step.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cloth_step(header: *const u32) {
    unsafe { cloth_step_part(header, 0, 1) };
}

/// Thread `thread` of `threads` of a frame (`cloth_step` is thread 0 of 1): every pass is split by a static schedule (each
/// thread a fixed share of the particles, of the pins and of each edge colour) and the threads meet after each. No two items
/// of a pass touch the same particle (a colour's edges share none), and an item's operations do not depend on which thread
/// runs it, so any number of threads gives the same bits. Each thread counts its own work in its four words of the work
/// array.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cloth_step_part(header: *const u32, thread: u32, threads: u32) {
    let h = Header(header);
    let (thread, threads) = (thread as usize, threads.max(1) as usize);
    let barrier = Barrier { words: h.word(H_BARRIER) as *mut u32, threads: threads as u32 };
    let n = h.word(H_COUNT);
    let adj_len = h.u32s(H_ADJACENCY, n + 1)[n] as usize + n + 1;
    let adjacency = h.u32s(H_ADJACENCY, adj_len);
    let triangles = h.u32s(H_TRIANGLES, 3 * h.word(H_TRIANGLE_COUNT));
    let mut state = h.f32s(H_STATE, 12 * n);
    let normals = h.f32s(H_NORMALS, 4 * n);
    let vertices = h.f32s(H_VERTICES, VERTEX * n);
    let uvs = h.f32s(H_UVS, 2 * n);
    let color_count = h.word(H_COLOR_COUNT);
    let colors = h.u32s(H_COLORS, 2 * color_count);
    let mut edge_words = 0;
    for c in 0..color_count {
        let end = (colors[2 * c] + colors[2 * c + 1]) as usize;
        if end > edge_words {
            edge_words = end;
        }
    }
    let edges = h.u32s(H_EDGES, 4 * edge_words);
    let slot_count = h.word(H_SLOT_COUNT);
    let substeps = h.word(H_SUBSTEPS);
    let slots = h.f32s(H_SLOTS, SLOT * slot_count);
    let pin_count = h.word(H_PIN_COUNT);
    let pins = h.f32s(H_PINS, 8 * pin_count);
    let pins_u = h.u32s(H_PINS, 8 * pin_count);
    let collider_count = h.word(H_COLLIDER_COUNT);
    let colliders = h.f32s(H_COLLIDERS, COLLIDER * collider_count);
    let colliders_u = h.u32s(H_COLLIDERS, COLLIDER * collider_count);
    let mut sdf_len = 0;
    for c in 0..collider_count {
        let o = c * COLLIDER;
        if colliders_u[o] == 4 {
            let end = colliders_u[o + 1] as usize
                + colliders_u[o + 28] as usize * colliders_u[o + 29] as usize * colliders_u[o + 30] as usize;
            if end > sdf_len {
                sdf_len = end;
            }
        }
    }
    let sdf = h.f32s(H_SDF, sdf_len);
    let tethers = if h.word(H_TETHERS) != 0 { Some(h.u32s(H_TETHERS, 2 * n)) } else { None };
    let mut work = Buf((h.word(H_WORK) as *mut u32).wrapping_add(4 * thread));
    for k in 0..4 {
        work[k] = 0;
    }
    let (lo, hi) = share(n, thread, threads);
    let (pin_lo, pin_hi) = share(pin_count, thread, threads);

    for s in 0..slot_count {
        let o = s * SLOT;
        let dt = slots[o] as f64;
        let a0 = slots[o + 1] as f64;
        let a1 = slots[o + 2] as f64;
        let time = slots[o + 3] as f64;
        let gravity = [slots[o + 4] as f64, slots[o + 5] as f64, slots[o + 6] as f64];
        let damp = slots[o + 7] as f64;
        let wind = [slots[o + 8] as f64, slots[o + 9] as f64, slots[o + 10] as f64];
        let turbulence = slots[o + 11] as f64;
        let drag_k = slots[o + 12] as f64;
        let thickness = slots[o + 13] as f64;
        if thread == 0 {
            work[0] += 1;
        }
        // Normals of the shape now, for the drag.
        if drag_k > 0.0 {
            write_normals(state, normals, adjacency, triangles, n, lo, hi);
            barrier.meet();
        }
        // Integrate: the velocity takes the last substep's corrections, damping, the wind's drag and gravity.
        for i in lo..hi {
            let p = i * 4;
            let w = state[p + 3] as f64;
            if w == 0.0 {
                continue;
            }
            work[1] += 1;
            let v = (n + i) * 4;
            let q = (2 * n + i) * 4;
            let mut vx = (state[v] as f64 + (state[p] as f64 - state[q] as f64) / dt) * damp;
            let mut vy = (state[v + 1] as f64 + (state[p + 1] as f64 - state[q + 1] as f64) / dt) * damp;
            let mut vz = (state[v + 2] as f64 + (state[p + 2] as f64 - state[q + 2] as f64) / dt) * damp;
            let area = normals[p + 3] as f64;
            if drag_k > 0.0 && area > 0.0 {
                let u = wind_at(wind, turbulence, state[p] as f64, state[p + 1] as f64, state[p + 2] as f64, time);
                let nx = normals[p] as f64;
                let ny = normals[p + 1] as f64;
                let nz = normals[p + 2] as f64;
                let un = (u[0] - vx) * nx + (u[1] - vy) * ny + (u[2] - vz) * nz;
                let k = drag_k * area * w * un.abs() * dt;
                let k = if k < 1.0 { k } else { 1.0 };
                vx += nx * un * k;
                vy += ny * un * k;
                vz += nz * un * k;
            }
            vx += gravity[0] * dt;
            vy += gravity[1] * dt;
            vz += gravity[2] * dt;
            state[v] = vx as f32;
            state[v + 1] = vy as f32;
            state[v + 2] = vz as f32;
            state[v + 3] = 0.0;
            state[p] = (state[p] as f64 + vx * dt) as f32;
            state[p + 1] = (state[p + 1] as f64 + vy * dt) as f32;
            state[p + 2] = (state[p + 2] as f64 + vz * dt) as f32;
            state[q] = state[p];
            state[q + 1] = state[p + 1];
            state[q + 2] = state[p + 2];
            state[q + 3] = 0.0;
        }
        barrier.meet();
        // Pins: held particles move from where the pin was to where it is, by the substep's share of the frame.
        for k in pin_lo..pin_hi {
            let b = k * 8;
            let i = pins_u[b + 3] as usize;
            let p = i * 4;
            let v = (n + i) * 4;
            let q = (2 * n + i) * 4;
            for a in 0..3 {
                let from = pins[b + a] as f64;
                let to = pins[b + 4 + a] as f64;
                state[p + a] = (from + (to - from) * a1) as f32;
                state[q + a] = state[p + a];
                state[v + a] = (((to - from) * (a1 - a0)) / dt) as f32;
            }
            state[p + 3] = 0.0;
            state[v + 3] = 0.0;
            state[q + 3] = 0.0;
        }
        // Edges, one colour after another: no two edges of a colour share a particle.
        let alpha = [
            slots[o + 16] as f64 / (dt * dt),
            slots[o + 17] as f64 / (dt * dt),
            slots[o + 18] as f64 / (dt * dt),
        ];
        barrier.meet();
        for c in 0..color_count {
            let start = colors[2 * c] as usize;
            let (first, last) = share(colors[2 * c + 1] as usize, thread, threads);
            for e in start + first..start + last {
                let i = edges[e * 4];
                if i == NO_EDGE {
                    continue;
                }
                let pi = i as usize * 4;
                let pj = edges[e * 4 + 1] as usize * 4;
                let wi = state[pi + 3] as f64;
                let wj = state[pj + 3] as f64;
                let ws = wi + wj;
                if ws == 0.0 {
                    continue;
                }
                work[2] += 1;
                let dx = state[pi] as f64 - state[pj] as f64;
                let dy = state[pi + 1] as f64 - state[pj + 1] as f64;
                let dz = state[pi + 2] as f64 - state[pj + 2] as f64;
                let len = len3(dx, dy, dz);
                if len < 1e-9 {
                    continue;
                }
                let c = len - f32::from_bits(edges[e * 4 + 2]) as f64;
                let dl = -c / (ws + alpha[edges[e * 4 + 3] as usize]);
                let nx = dx / len;
                let ny = dy / len;
                let nz = dz / len;
                state[pi] = (state[pi] as f64 + nx * wi * dl) as f32;
                state[pi + 1] = (state[pi + 1] as f64 + ny * wi * dl) as f32;
                state[pi + 2] = (state[pi + 2] as f64 + nz * wi * dl) as f32;
                state[pj] = (state[pj] as f64 - nx * wj * dl) as f32;
                state[pj + 1] = (state[pj + 1] as f64 - ny * wj * dl) as f32;
                state[pj + 2] = (state[pj + 2] as f64 - nz * wj * dl) as f32;
            }
            barrier.meet();
        }
        // Tethers: a free particle past its rest distance along the cloth (times 1 + slack) from its pin is pulled back.
        if let Some(t) = &tethers {
            let stretch = slots[o + 21] as f64;
            for i in lo..hi {
                let anchor = t[i * 2];
                let p = i * 4;
                if anchor == NO_EDGE || state[p + 3] == 0.0 {
                    continue;
                }
                let a = anchor as usize * 4;
                let dx = state[p] as f64 - state[a] as f64;
                let dy = state[p + 1] as f64 - state[a + 1] as f64;
                let dz = state[p + 2] as f64 - state[a + 2] as f64;
                let l = len3(dx, dy, dz);
                let most = f32::from_bits(t[i * 2 + 1]) as f64 * stretch;
                if !(l > most) {
                    continue;
                }
                let k = most / l;
                state[p] = (state[a] as f64 + dx * k) as f32;
                state[p + 1] = (state[a + 1] as f64 + dy * k) as f32;
                state[p + 2] = (state[a + 2] as f64 + dz * k) as f32;
            }
        }
        // Colliders, in order: push out to the thickness, then hold back the slide (Coulomb).
        if collider_count > 0 {
            // Each collider's pose this substep and the last is the same for every particle: worked out once (on the stack).
            let zero = Pose { x0: [0.0; 3], x1: [0.0; 3], q0: [0.0; 4], q1: [0.0; 4], back: [0.0; 4] };
            let mut poses = [zero; 32];
            let pose = Buf(poses.as_mut_ptr());
            for c in 0..collider_count {
                let mut at = pose;
                at[c] = collider_pose(colliders, c, a0, a1);
            }
            for i in lo..hi {
                let p = i * 4;
                if state[p + 3] == 0.0 {
                    continue;
                }
                for c in 0..collider_count {
                    work[3] += 1;
                    if let Some(r) = collide(state, p, n, i, dt, colliders, colliders_u, sdf, c, &pose[c], thickness) {
                        state[p] = r[0] as f32;
                        state[p + 1] = r[1] as f32;
                        state[p + 2] = r[2] as f32;
                    }
                }
            }
        }
        barrier.meet();
        if (s + 1) % substeps == 0 {
            write_surface(state, normals, vertices, adjacency, triangles, uvs, n, lo, hi);
            barrier.meet();
        }
    }
}
