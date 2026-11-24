// The exact solve of a tree of joints. Joints whose bodies form an acyclic graph with a branch (a dynamic body with three
// or more locked joints) are solved whole in one sweep, as a path is, by sparse block factorization of K = J M^-1 J^T over the
// tree (Baraff, "Linear-Time Dynamics using Lagrange Multipliers", SIGGRAPH 1996; the elimination order and the cost
// follow his argument, the blocks here are this kernel's own).
//
// Two joints couple only through a dynamic body they share. Root each tree at a body and call a joint's child body the one
// farther from the root (none for a joint to a static or kinematic body). Eliminating the joints of the deepest bodies
// first, the joints at a body v (its parent joint j and its child joints C) already form a dense group, so eliminating C
// adds no new coupling: it only changes the block of j, D_j = K_jj - K_jC S_v^-1 K_Cj, where S_v is K over C with each
// diagonal block replaced by the child's own reduced block D_c. The load the children carry reaches j through y_j = r_j -
// K_jC S_v^-1 y_C. Back substitution then runs from the root down: x_C = S_v^-1 (y_C - K_Cj x_j). A body with m child
// joints costs a dense solve of at most 3m rows, so the sweep is linear in the number of joints for bounded degree.
use alloc::vec::Vec;

use super::{JointDef, M3, Paths, Pair, Pass, apply_locks, coupling, lock_delta, lock_rhs, locks, own};
use crate::world::World;

/// A symmetric `n` by `n` matrix (row major in `k`) inverted by Cholesky into `out`; a pivot under an f32 epsilon of its
/// diagonal marks a row that depends on the others, and that row is dropped (its part of the inverse is zero).
fn invert_dense(k: &[f64], n: usize, out: &mut [f64], l: &mut Vec<f64>) {
    l.clear();
    l.resize(n * n, 0.0);
    let mut dropped = alloc::vec![false; n];
    for c in 0..n {
        let mut d = k[c * n + c];
        for p in 0..c {
            d -= l[c * n + p] * l[c * n + p];
        }
        if !(d > f32::EPSILON as f64 * k[c * n + c]) {
            dropped[c] = true;
            continue;
        }
        let root = crate::math::sqrt64(d);
        l[c * n + c] = root;
        for r in c + 1..n {
            let mut s = k[r * n + c];
            for p in 0..c {
                s -= l[r * n + p] * l[c * n + p];
            }
            l[r * n + c] = s / root;
        }
    }
    out[..n * n].fill(0.0);
    let mut y = alloc::vec![0.0f64; n];
    for col in 0..n {
        for r in 0..n {
            if dropped[r] {
                y[r] = 0.0;
                continue;
            }
            let mut s = if r == col { 1.0 } else { 0.0 };
            for p in 0..r {
                s -= l[r * n + p] * y[p];
            }
            y[r] = s / l[r * n + r];
        }
        for r in (0..n).rev() {
            if dropped[r] {
                continue;
            }
            let mut s = y[r];
            for p in r + 1..n {
                s -= l[p * n + r] * out[p * n + col];
            }
            out[r * n + col] = s / l[r * n + r];
        }
    }
}

/// Which joints are solved as trees, and the rooted structure of each tree; rebuilt with the paths.
#[derive(Default)]
pub(crate) struct Trees {
    /// Per joint: in a tree.
    pub(super) member: Vec<bool>,
    /// Per tree joint: its parent body and its child body (`u32::MAX` for none).
    up: Vec<u32>,
    down: Vec<u32>,
    /// The bodies of all trees in breadth first order, parents before children, and each tree's first body.
    bodies: Vec<u32>,
    roots: Vec<usize>,
    /// Per body: the joint above it (`u32::MAX` for a root), and its child joints as a range of `kids`.
    above: Vec<u32>,
    kid_start: Vec<u32>,
    kids: Vec<u32>,
    /// Scratch per joint.
    rows: Vec<Option<super::Locks>>,
    d: Vec<M3>,
    y: Vec<[f64; 3]>,
    x: Vec<[f64; 3]>,
    /// Scratch per body: where its S^-1 starts in `sinv`, and the dense blocks.
    sinv_at: Vec<usize>,
    sinv: Vec<f64>,
    work: Vec<f64>,
    chol: Vec<f64>,
    /// Trees and the joints in them, for the tests.
    pub count: u32,
    pub joints: u32,
}

/// Builds the trees from the joints marked in `member` (acyclic, with a branch) and roots each at its first body.
pub(super) fn build(world: &World, member: &[bool], t: &mut Trees) {
    let (nb, nj) = (world.bodies.len(), world.joints.len());
    t.member.clear();
    t.member.extend_from_slice(member);
    t.up.clear();
    t.up.resize(nj, u32::MAX);
    t.down.clear();
    t.down.resize(nj, u32::MAX);
    t.bodies.clear();
    t.roots.clear();
    t.above.clear();
    t.above.resize(nb, u32::MAX);
    // Joints at each body, as a compressed list.
    let mut count = alloc::vec![0u32; nb + 1];
    let dynamic = |b: u32| world.bodies[b as usize].is_dynamic();
    for (j, joint) in world.joints.iter().enumerate() {
        if member[j] {
            for b in [joint.def.a, joint.def.b] {
                if dynamic(b) {
                    count[b as usize + 1] += 1;
                }
            }
        }
    }
    for i in 0..nb {
        count[i + 1] += count[i];
    }
    let mut fill = count.clone();
    let mut at = alloc::vec![0u32; count[nb] as usize];
    for (j, joint) in world.joints.iter().enumerate() {
        if member[j] {
            for b in [joint.def.a, joint.def.b] {
                if dynamic(b) {
                    at[fill[b as usize] as usize] = j as u32;
                    fill[b as usize] += 1;
                }
            }
        }
    }
    let mut seen = alloc::vec![false; nb];
    let mut taken = alloc::vec![false; nj];
    t.count = 0;
    t.joints = 0;
    for j in 0..nj {
        if !member[j] || taken[j] {
            continue;
        }
        let def = &world.joints[j].def;
        let root = if dynamic(def.a) { def.a } else { def.b };
        if seen[root as usize] {
            continue;
        }
        t.roots.push(t.bodies.len());
        t.count += 1;
        seen[root as usize] = true;
        t.bodies.push(root);
        let mut head = *t.roots.last().unwrap();
        while head < t.bodies.len() {
            let u = t.bodies[head];
            head += 1;
            for &jj in &at[count[u as usize] as usize..count[u as usize + 1] as usize] {
                if taken[jj as usize] {
                    continue;
                }
                taken[jj as usize] = true;
                t.joints += 1;
                let d = &world.joints[jj as usize].def;
                let far = if d.a == u { d.b } else { d.a };
                t.up[jj as usize] = u;
                if dynamic(far) {
                    t.down[jj as usize] = far;
                    t.above[far as usize] = jj;
                    seen[far as usize] = true;
                    t.bodies.push(far);
                }
            }
        }
    }
    // Child joints of each body.
    t.kid_start.clear();
    t.kid_start.resize(nb + 1, 0);
    for j in 0..nj {
        if member[j] && t.up[j] != u32::MAX {
            t.kid_start[t.up[j] as usize + 1] += 1;
        }
    }
    for i in 0..nb {
        t.kid_start[i + 1] += t.kid_start[i];
    }
    let mut fill = t.kid_start.clone();
    t.kids.clear();
    t.kids.resize(t.kid_start[nb] as usize, 0);
    for j in 0..nj {
        if member[j] && t.up[j] != u32::MAX {
            let slot = &mut fill[t.up[j] as usize];
            t.kids[*slot as usize] = j as u32;
            *slot += 1;
        }
    }
}

/// One exact solve of every tree's locks, applied to the bodies.
pub(super) fn solve(world: &mut World, paths: &mut Paths, pass: &Pass) {
    let nj = world.joints.len();
    let mut t = core::mem::take(&mut paths.trees);
    t.rows.clear();
    t.rows.resize_with(nj, || None);
    t.d.clear();
    t.d.resize(nj, [[0.0; 3]; 3]);
    t.y.clear();
    t.y.resize(nj, [0.0; 3]);
    t.x.clear();
    t.x.resize(nj, [0.0; 3]);
    for j in 0..nj {
        if !t.member[j] {
            continue;
        }
        let def: JointDef = world.joints[j].def;
        let pair = Pair::of(world, &paths.inv_i, &def);
        let l = locks(&def, &pair);
        t.d[j] = own(world, &paths.inv_i, &def, &l);
        t.y[j] = lock_rhs(&pair, &l, pass);
        t.rows[j] = Some(l);
    }
    let nb = world.bodies.len();
    t.sinv_at.clear();
    t.sinv_at.resize(nb, usize::MAX);
    t.sinv.clear();
    let n_of = |t: &Trees, j: u32| t.rows[j as usize].as_ref().map_or(0, |l| l.n);
    // Deepest bodies first: assemble each body's S, invert it and reduce the joint above.
    for bi in (0..t.bodies.len()).rev() {
        let v = t.bodies[bi];
        let kids: Vec<u32> = t.kids[t.kid_start[v as usize] as usize..t.kid_start[v as usize + 1] as usize].to_vec();
        let sizes: Vec<usize> = kids.iter().map(|&c| n_of(&t, c)).collect();
        let total: usize = sizes.iter().sum();
        if total > 0 {
            t.work.clear();
            t.work.resize(total * total, 0.0);
            let mut offsets = Vec::with_capacity(kids.len());
            let mut o = 0;
            for &s in &sizes {
                offsets.push(o);
                o += s;
            }
            for (a, &ca) in kids.iter().enumerate() {
                let da = world.joints[ca as usize].def;
                for r in 0..sizes[a] {
                    for c in 0..sizes[a] {
                        t.work[(offsets[a] + r) * total + offsets[a] + c] = t.d[ca as usize][r][c];
                    }
                }
                for (b, &cb) in kids.iter().enumerate().skip(a + 1) {
                    let db = world.joints[cb as usize].def;
                    let k = coupling(world, &paths.inv_i, &da, t.rows[ca as usize].as_ref().unwrap(), &db, t.rows[cb as usize].as_ref().unwrap(), v);
                    for r in 0..sizes[a] {
                        for c in 0..sizes[b] {
                            t.work[(offsets[a] + r) * total + offsets[b] + c] = k[r][c];
                            t.work[(offsets[b] + c) * total + offsets[a] + r] = k[r][c];
                        }
                    }
                }
            }
            let start = t.sinv.len();
            t.sinv_at[v as usize] = start;
            t.sinv.resize(start + total * total, 0.0);
            let (work, mut chol) = (core::mem::take(&mut t.work), core::mem::take(&mut t.chol));
            invert_dense(&work, total, &mut t.sinv[start..], &mut chol);
            t.work = work;
            t.chol = chol;
            // Reduce the joint above: D_j -= K_jC S^-1 K_Cj, y_j -= K_jC S^-1 y_C.
            let j = t.above[v as usize];
            if j != u32::MAX {
                let dj = world.joints[j as usize].def;
                let nj_rows = n_of(&t, j);
                let mut kjc = alloc::vec![0.0f64; nj_rows * total];
                for (b, &cb) in kids.iter().enumerate() {
                    let db = world.joints[cb as usize].def;
                    let k = coupling(world, &paths.inv_i, &dj, t.rows[j as usize].as_ref().unwrap(), &db, t.rows[cb as usize].as_ref().unwrap(), v);
                    for r in 0..nj_rows {
                        for c in 0..sizes[b] {
                            kjc[r * total + offsets[b] + c] = k[r][c];
                        }
                    }
                }
                let inv = &t.sinv[start..start + total * total];
                // W = S^-1 K_Cj (total by nj_rows) and z = S^-1 y_C.
                let mut yc = alloc::vec![0.0f64; total];
                for (b, &cb) in kids.iter().enumerate() {
                    for c in 0..sizes[b] {
                        yc[offsets[b] + c] = t.y[cb as usize][c];
                    }
                }
                let mut z = alloc::vec![0.0f64; total];
                for r in 0..total {
                    for c in 0..total {
                        z[r] += inv[r * total + c] * yc[c];
                    }
                }
                for r in 0..nj_rows {
                    for c in 0..nj_rows {
                        let mut sum = 0.0;
                        for p in 0..total {
                            let mut w = 0.0;
                            for q in 0..total {
                                w += inv[p * total + q] * kjc[c * total + q];
                            }
                            sum += kjc[r * total + p] * w;
                        }
                        t.d[j as usize][r][c] -= sum;
                    }
                    let mut s = 0.0;
                    for p in 0..total {
                        s += kjc[r * total + p] * z[p];
                    }
                    t.y[j as usize][r] -= s;
                }
            }
        }
    }
    // Root down: x_C = S^-1 (y_C - K_Cj x_j) at every body, parents before children.
    for bi in 0..t.bodies.len() {
        let v = t.bodies[bi];
        let start = t.sinv_at[v as usize];
        if start == usize::MAX {
            continue;
        }
        let kids: Vec<u32> = t.kids[t.kid_start[v as usize] as usize..t.kid_start[v as usize + 1] as usize].to_vec();
        let sizes: Vec<usize> = kids.iter().map(|&c| n_of(&t, c)).collect();
        let total: usize = sizes.iter().sum();
        let mut offsets = Vec::with_capacity(kids.len());
        let mut o = 0;
        for &s in &sizes {
            offsets.push(o);
            o += s;
        }
        let mut rhs = alloc::vec![0.0f64; total];
        for (b, &cb) in kids.iter().enumerate() {
            for c in 0..sizes[b] {
                rhs[offsets[b] + c] = t.y[cb as usize][c];
            }
        }
        let j = t.above[v as usize];
        if j != u32::MAX {
            let dj = world.joints[j as usize].def;
            let xj = t.x[j as usize];
            for (b, &cb) in kids.iter().enumerate() {
                let db = world.joints[cb as usize].def;
                let k = coupling(world, &paths.inv_i, &db, t.rows[cb as usize].as_ref().unwrap(), &dj, t.rows[j as usize].as_ref().unwrap(), v);
                for r in 0..sizes[b] {
                    for c in 0..n_of(&t, j) {
                        rhs[offsets[b] + r] -= k[r][c] * xj[c];
                    }
                }
            }
        }
        let inv = &t.sinv[start..start + total * total];
        for (b, &cb) in kids.iter().enumerate() {
            for r in 0..sizes[b] {
                let mut s = 0.0;
                for c in 0..total {
                    s += inv[(offsets[b] + r) * total + c] * rhs[c];
                }
                t.x[cb as usize][r] = s;
            }
        }
    }
    for j in 0..nj {
        if !t.member[j] {
            continue;
        }
        let def = world.joints[j].def;
        let l = t.rows[j].take().unwrap();
        let d = lock_delta(&t.x[j], &world.joints[j].lock, l.n, pass);
        apply_locks(world, &paths.inv_i, &def, &l, &d);
        for k in 0..l.n {
            world.joints[j].lock[k] += d[k];
        }
    }
    paths.trees = t;
}
