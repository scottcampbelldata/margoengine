//! Coupled equilibrium stabilization on a certified supported normal-contact path.
//! General graphs use the capped NCP. This correction makes no performance claim.
use super::{Bounce, Constraint, Kind, Rot, Soft, SolverBody, V2, World, gap, inverse};
use alloc::vec::Vec;

#[derive(Clone)]
struct Row {
    a: usize,
    b: usize,
    ja: [f64; 3],
    jb: [f64; 3],
    contact: usize,
    point: usize,
    gap: f64,
    target: f64,
}

fn parallel_positions(
    rows: &[Row],
    rhs: &[f64],
    path: &[(usize, usize, usize)],
    direction: [f64; 2],
    displacement: &mut [[f64; 3]],
) -> bool {
    let norm = direction[0] * direction[0] + direction[1] * direction[1];
    for (i, &(_, body, parent)) in path.iter().enumerate() {
        let r = [&rows[2 * i], &rows[2 * i + 1]];
        let child = |row: &Row| if row.a == body { row.ja } else { row.jb };
        let parent_j = |row: &Row| if row.a == parent { row.ja } else { row.jb };
        let desired = [
            rhs[2 * i] - dot(parent_j(r[0]), displacement[parent]),
            rhs[2 * i + 1] - dot(parent_j(r[1]), displacement[parent]),
        ];
        let arms = [child(r[0])[2], child(r[1])[2]];
        let det = arms[0] - arms[1];
        if det == 0.0 || !det.is_finite() {
            return false;
        }
        let angle = (desired[0] - desired[1]) / det;
        let normal = desired[0] - arms[0] * angle;
        let proposed = [
            direction[0] * normal / norm,
            direction[1] * normal / norm,
            angle,
        ];
        if !finite(proposed) {
            return false;
        }
        for p in 0..2 {
            let value = dot(child(r[p]), proposed) + dot(parent_j(r[p]), displacement[parent]);
            let magnitude = dot(child(r[p]).map(f64::abs), proposed.map(f64::abs))
                + dot(
                    parent_j(r[p]).map(f64::abs),
                    displacement[parent].map(f64::abs),
                )
                + rhs[2 * i + p].abs();
            if !rounded_zero(value - rhs[2 * i + p], magnitude, 64 * (i + 1)) {
                return false;
            }
        }
        displacement[body] = proposed;
    }
    true
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn add(a: &mut [f64; 3], b: [f64; 3]) {
    for k in 0..3 {
        a[k] += b[k];
    }
}
fn scaled(a: [f64; 3], s: f64) -> [f64; 3] {
    a.map(|x| x * s)
}
fn finite(a: [f64; 3]) -> bool {
    a.into_iter().all(f64::is_finite)
}

/// Equality certificate using a deliberately conservative forward-error bound, with no world-unit tolerance.
fn rounded_zero(residual: f64, sum_abs: f64, operations: usize) -> bool {
    residual.is_finite()
        && sum_abs.is_finite()
        && sum_abs >= 0.0
        && residual.abs() <= (operations as f64 + 1.0) * f64::EPSILON * sum_abs
}

/// Normal-force/torque feasibility, independent of impact and cached impulses.
fn normal_wrench(
    force: [f64; 3],
    d: [f64; 2],
    arms: [f64; 2],
    count: usize,
    h: f64,
) -> Option<[f64; 2]> {
    if !finite(force) || !d.into_iter().all(f64::is_finite) {
        return None;
    }
    let norm = d[0] * d[0] + d[1] * d[1];
    if !(norm > 0.0) {
        return None;
    }
    let total = -h * (force[0] * d[0] + force[1] * d[1]) / norm;
    if !total.is_finite() || total < 0.0 {
        return None;
    }
    for k in 0..2 {
        let support = d[k] * total / h;
        if !rounded_zero(force[k] + support, force[k].abs() + support.abs(), 64) {
            return None;
        }
    }
    let torque = -h * force[2];
    let l = if count == 1 {
        if !rounded_zero(
            arms[0] * total - torque,
            (arms[0] * total).abs() + torque.abs(),
            64,
        ) {
            return None;
        }
        [total, 0.0]
    } else {
        let det = arms[0] - arms[1];
        if det == 0.0 || !det.is_finite() {
            return None;
        }
        let a = (torque - arms[1] * total) / det;
        [a, total - a]
    };
    if !l.into_iter().all(|v| v >= 0.0 && v.is_finite()) {
        return None;
    }
    let actual = arms[0] * l[0] + arms[1] * l[1];
    if !rounded_zero(
        actual - torque,
        (arms[0] * l[0]).abs() + (arms[1] * l[1]).abs() + torque.abs(),
        96,
    ) {
        return None;
    }
    Some(l)
}

/// Lower half of a symmetric matrix of bandwidth three (adjacent blocks hold at most two rows).
struct Banded {
    a: Vec<[f64; 4]>,
    ld: Vec<[f64; 4]>,
}
impl Banded {
    fn get(a: &[[f64; 4]], i: usize, j: usize) -> f64 {
        if i < j {
            return Self::get(a, j, i);
        }
        if i - j > 3 { 0.0 } else { a[i][i - j] }
    }
    fn new(rows: &[Row], weights: &[[f64; 3]]) -> Option<Self> {
        let mut a = alloc::vec![[0.0;4];rows.len()];
        for (i, row) in rows.iter().enumerate() {
            for j in i.saturating_sub(3)..=i {
                let other = &rows[j];
                let mut value = 0.0;
                for (body, jac) in [(row.a, row.ja), (row.b, row.jb)] {
                    for (ob, oj) in [(other.a, other.ja), (other.b, other.jb)] {
                        if body == ob {
                            value += dot(
                                jac,
                                [
                                    oj[0] * weights[body][0],
                                    oj[1] * weights[body][1],
                                    oj[2] * weights[body][2],
                                ],
                            );
                        }
                    }
                }
                a[i][i - j] = value;
            }
        }
        let mut ld = alloc::vec![[0.0;4];rows.len()];
        for i in 0..rows.len() {
            for j in i.saturating_sub(3)..=i {
                let mut value = Self::get(&a, i, j);
                for k in i.saturating_sub(3).max(j.saturating_sub(3))..j {
                    value -= Self::get(&ld, i, k) * ld[k][0] * Self::get(&ld, j, k);
                }
                if i == j {
                    if !(value > 0.0) || !value.is_finite() {
                        return None;
                    }
                    ld[i][0] = value;
                } else {
                    ld[i][i - j] = value / ld[j][0];
                }
            }
        }
        Some(Self { a, ld })
    }
    fn solve(&self, rhs: &[f64]) -> Option<Vec<f64>> {
        let n = rhs.len();
        let mut x = rhs.to_vec();
        for i in 0..n {
            for j in i.saturating_sub(3)..i {
                x[i] -= self.ld[i][i - j] * x[j];
            }
        }
        for i in 0..n {
            x[i] /= self.ld[i][0];
        }
        for i in (0..n).rev() {
            for j in i + 1..(i + 4).min(n) {
                x[i] -= self.ld[j][j - i] * x[j];
            }
        }
        if !x.iter().all(|v| v.is_finite()) {
            return None;
        }
        for i in 0..n {
            let mut residual = -rhs[i];
            let mut magnitude = rhs[i].abs();
            for (j, &value) in x
                .iter()
                .enumerate()
                .take((i + 4).min(n))
                .skip(i.saturating_sub(3))
            {
                let product = Self::get(&self.a, i, j) * value;
                residual += product;
                magnitude += product.abs();
            }
            if !rounded_zero(residual, magnitude, 32 * n + 64) {
                return None;
            }
        }
        Some(x)
    }
}

fn row_at(c: &Constraint, p: usize, bodies: &[SolverBody], contact: usize) -> Row {
    let point = &c.points[p];
    let ra = bodies[c.a as usize].turn.apply(point.anchor_a);
    let rb = bodies[c.b as usize].turn.apply(point.anchor_b);
    Row {
        a: c.a as usize,
        b: c.b as usize,
        ja: [
            -c.normal.x as f64,
            -c.normal.y as f64,
            -ra.cross(c.normal) as f64,
        ],
        jb: [
            c.normal.x as f64,
            c.normal.y as f64,
            rb.cross(c.normal) as f64,
        ],
        contact,
        point: p,
        gap: gap(bodies, c, point) as f64,
        target: 0.0,
    }
}

/// Proposes and verifies the whole component before writing any position, velocity or impulse.
fn component_local(
    world: &mut World,
    bounces: &[Bounce],
    bodies: &mut [SolverBody],
    ids: &[u32],
    start: &[Rot],
    constraints: &mut [Constraint],
    initial_gaps: &[[f32; 2]],
    path: &[(usize, usize, usize)],
    dt: f32,
    h: f32,
    springs: &[Soft; 2],
    pose_distance: &mut [f32],
    weights: &[[f64; 3]],
) -> bool {
    if !(world.settings.contact_max_push > 0.0 && world.settings.contact_max_push.is_finite()) {
        return false;
    }
    let first = &constraints[path[0].0];
    let sign = if first.a as usize == path[0].1 {
        -1.0
    } else {
        1.0
    };
    let direction = [sign * first.normal.x as f64, sign * first.normal.y as f64];
    let norm = direction[0] * direction[0] + direction[1] * direction[1];
    let mut parallel = true;
    for &(ci, body, _) in path {
        let c = &constraints[ci];
        let sign = if c.a as usize == body { -1.0 } else { 1.0 };
        parallel &= c.count == 2
            && weights[body][0] > 0.0
            && weights[body][2] > 0.0
            && [sign * c.normal.x as f64, sign * c.normal.y as f64] == direction;
        if !fixed_domain(world, c, &bounces[ci]) {
            return false;
        }
    }
    let mut forces = alloc::vec![[0.0;3];bodies.len()];
    for &(_, body, _) in path {
        let source = &world.bodies[ids[body] as usize];
        // The same real-mass metric as K, not an independently rounded cached mass.
        let mass = 1.0 / (source.inv_mass as f64);
        forces[body] = [
            mass * world.settings.gravity.x as f64 * source.gravity_scale as f64,
            mass * world.settings.gravity.y as f64 * source.gravity_scale as f64,
            0.0,
        ];
    }
    let mut supports = alloc::vec![[0.0;2];path.len()];
    for (at, &(ci, body, parent)) in path.iter().enumerate().rev() {
        let c = &constraints[ci];
        let rows = [row_at(c, 0, bodies, ci), row_at(c, 1, bodies, ci)];
        let jac = |row: &Row| if row.a == body { row.ja } else { row.jb };
        let arm = [jac(&rows[0])[2], jac(&rows[1])[2]];
        let direction = [jac(&rows[0])[0], jac(&rows[0])[1]];
        let Some(support) = normal_wrench(forces[body], direction, arm, c.count as usize, h as f64)
        else {
            return false;
        };
        supports[at] = support;
        for p in 0..c.count as usize {
            let parent_j = if rows[p].a == parent {
                rows[p].ja
            } else {
                rows[p].jb
            };
            add(&mut forces[parent], scaled(parent_j, support[p] / h as f64));
        }
    }
    let mut rows = Vec::new();
    for (at, &(ci, _, _)) in path.iter().enumerate() {
        let c = &constraints[ci];
        let spring = &springs[c.eighth as usize];
        if ![spring.bias_rate, spring.mass_scale, spring.impulse_scale]
            .into_iter()
            .all(|x| x > 0.0 && x.is_finite())
        {
            return false;
        }
        for p in 0..c.count as usize {
            let mut row = row_at(c, p, bodies, ci);
            // A speculative or separating row does not establish a supported elastic active set.
            if row.gap > 0.0 {
                return false;
            }
            let kii = if c.count == 2 {
                c.k[if p == 0 { 0 } else { 2 }]
            } else {
                1.0 / c.points[p].normal_mass
            };
            let compliance = kii * (spring.impulse_scale / spring.mass_scale);
            if !(kii > 0.0 && kii.is_finite() && compliance > 0.0 && compliance.is_finite()) {
                return false;
            }
            row.target = -(compliance as f64) * supports[at][p] / spring.bias_rate as f64;
            if !row.target.is_finite() {
                return false;
            }
            rows.push(row);
        }
    }
    let Some(matrix) = Banded::new(&rows, weights) else {
        return false;
    };
    let rhs: Vec<_> = rows.iter().map(|r| r.target - r.gap).collect();
    let Some(mu) = matrix.solve(&rhs) else {
        return false;
    };
    // The velocity solver/cache uses the step-start lever arms; position Newton uses the current rotated arms.
    // Keep those two Jacobians distinct rather than interpreting an old warm impulse through a new lever arm.
    let mut physical_rows = rows.clone();
    for row in &mut physical_rows {
        let c = &constraints[row.contact];
        let p = &c.points[row.point];
        row.ja[2] = -(p.anchor_a.cross(c.normal) as f64);
        row.jb[2] = p.anchor_b.cross(c.normal) as f64;
    }
    let Some(physical_matrix) = Banded::new(&physical_rows, weights) else {
        return false;
    };
    let speed_rhs: Vec<_> = physical_rows
        .iter()
        .map(|r| {
            let a = &bodies[r.a];
            let b = &bodies[r.b];
            -dot(r.ja, [a.v.x as f64, a.v.y as f64, a.w as f64])
                - dot(r.jb, [b.v.x as f64, b.v.y as f64, b.w as f64])
        })
        .collect();
    let Some(nu) = physical_matrix.solve(&speed_rhs) else {
        return false;
    };
    for (r, &n) in rows.iter().zip(&nu) {
        let total = constraints[r.contact].points[r.point].normal_impulse as f64 + n;
        if !(total >= 0.0) || !(total as f32).is_finite() {
            return false;
        }
    }
    let mut displacement = alloc::vec![[0.0;3];bodies.len()];
    let mut velocity = alloc::vec![[0.0;3];bodies.len()];
    for (i, row) in rows.iter().enumerate() {
        for (body, j) in [(row.a, row.ja), (row.b, row.jb)] {
            for k in 0..3 {
                displacement[body][k] += weights[body][k] * j[k] * mu[i];
            }
        }
        let physical = &physical_rows[i];
        for (body, j) in [(physical.a, physical.ja), (physical.b, physical.jb)] {
            for k in 0..3 {
                velocity[body][k] += weights[body][k] * j[k] * nu[i];
            }
        }
    }
    // Kinematic factorization of the same mass-metric projection on this certified domain.
    // It preserves exact row symmetry (and therefore exact zero rotation), which a generic LDLT roundoff need not.
    if parallel {
        if !parallel_positions(&rows, &rhs, path, direction, &mut displacement) {
            return false;
        }
        for &(_, body, _) in path {
            let b = &bodies[body];
            let vn = (direction[0] * b.v.x as f64 + direction[1] * b.v.y as f64) / norm;
            velocity[body] = [-direction[0] * vn, -direction[1] * vn, -(b.w as f64)];
        }
    }
    let mut largest = 0.0f64;
    for &(_, body, _) in path {
        let d = displacement[body];
        let extent = world.bodies[ids[body] as usize].extent as f64;
        let bound = d[0].abs() + d[1].abs() + extent * d[2].abs();
        if !bound.is_finite() || !finite(velocity[body]) {
            return false;
        }
        largest = largest.max(bound);
    }
    let cap = world.settings.contact_max_push as f64 * dt as f64;
    if !(cap >= 0.0) {
        return false;
    }
    let mut alpha = if largest > cap { cap / largest } else { 1.0 };
    // Keep the combined positive geometric recovery inside the same per-contact frame budget.
    for (i, row) in rows.iter().enumerate() {
        if rhs[i] > 0.0 {
            let initial = initial_gaps[row.contact][row.point] as f64;
            let used = (row.gap - initial).max(0.0);
            alpha = alpha.min(((cap - used).max(0.0) / rhs[i]).min(1.0));
        }
    }
    // Check f32 representability for the complete proposal before writing any component state.
    for &(_, body, _) in path {
        let d = scaled(displacement[body], alpha);
        let v = velocity[body];
        let b = &bodies[body];
        if ![
            d[0] as f32,
            d[1] as f32,
            d[2] as f32,
            (b.v.x as f64 + v[0]) as f32,
            (b.v.y as f64 + v[1]) as f32,
            (b.w as f64 + v[2]) as f32,
        ]
        .into_iter()
        .all(f32::is_finite)
        {
            return false;
        }
    }
    for row in &rows {
        let c = &constraints[row.contact];
        let p = &c.points[row.point];
        let predicted = |body: usize, anchor: V2| {
            let d = scaled(displacement[body], alpha);
            let delta = V2 {
                x: d[0] as f32,
                y: d[1] as f32,
            };
            let turn = if dynamic_body(world, ids, body) {
                world.bodies[ids[body] as usize]
                    .xf
                    .q
                    .integrate(d[2] as f32)
                    .mul(inverse(start[body]))
            } else {
                bodies[body].turn
            };
            bodies[body].moved.add(delta).add(turn.apply(anchor))
        };
        let new_gap = (c
            .normal
            .dot(predicted(row.b, p.anchor_b).sub(predicted(row.a, p.anchor_a)))
            + p.base) as f64;
        let initial = initial_gaps[row.contact][row.point] as f64;
        let previous = (row.gap - initial).max(0.0);
        let growth = (new_gap - initial).max(0.0);
        // Existing dynamics may already have spent the budget. The correction must add none then.
        if growth > cap.max(previous)
            && !rounded_zero(
                growth - cap.max(previous),
                new_gap.abs() + initial.abs() + cap,
                64,
            )
        {
            return false;
        }
    }
    let mut staged_bodies = bodies.to_vec();
    let mut staged_constraints = constraints.to_vec();
    let mut centers = Vec::with_capacity(path.len());
    let mut rotations = Vec::with_capacity(path.len());
    let mut corrections = Vec::with_capacity(path.len());
    for &(_, body, _) in path {
        let d = scaled(displacement[body], alpha);
        let v = velocity[body];
        let delta = V2 {
            x: d[0] as f32,
            y: d[1] as f32,
        };
        let angle = d[2] as f32;
        let target = &world.bodies[ids[body] as usize];
        let center = [
            target.exact_center[0] + delta.x as f64,
            target.exact_center[1] + delta.y as f64,
        ];
        let rotation = target.xf.q.integrate(angle);
        if !center.into_iter().all(f64::is_finite)
            || ![rotation.c, rotation.s].into_iter().all(f32::is_finite)
        {
            return false;
        }
        centers.push(center);
        rotations.push(rotation);
        corrections.push((delta.length() + target.extent * angle.abs()) / dt);
        let b = &mut staged_bodies[body];
        b.moved = b.moved.add(delta);
        b.turn = rotation.mul(inverse(start[body]));
        b.v = V2 {
            x: (b.v.x as f64 + v[0]) as f32,
            y: (b.v.y as f64 + v[1]) as f32,
        };
        b.w = (b.w as f64 + v[2]) as f32;
    }
    for (r, &n) in rows.iter().zip(&nu) {
        let c = &mut staged_constraints[r.contact];
        let p = &mut c.points[r.point];
        p.normal_impulse = (p.normal_impulse as f64 + n) as f32;
        c.pushed |= ((p.normal_impulse > 0.0) as u8) << r.point;
    }
    // As in the ordinary relaxing pass, the updated normal cone bounds friction last.
    for &(ci, _, _) in path {
        let c = &mut staged_constraints[ci];
        let (mut a, mut b) = super::motions(&staged_bodies, c);
        super::friction(c, &mut a, &mut b);
        super::store(&mut staged_bodies, c, a, b);
    }
    for r in &rows {
        let c = &staged_constraints[r.contact];
        let p = &c.points[r.point];
        if !(p.normal_impulse >= 0.0
            && p.normal_impulse.is_finite()
            && p.tangent_impulse.is_finite()
            && c.friction.is_finite()
            && p.tangent_impulse.abs() <= c.friction * p.normal_impulse)
        {
            return false;
        }
        let (a, b) = super::motions(&staged_bodies, c);
        if ![a.v.x, a.v.y, a.w, b.v.x, b.v.y, b.w]
            .into_iter()
            .all(f32::is_finite)
        {
            return false;
        }
        let vn = c
            .normal
            .dot(super::speed_at(b, p.anchor_b).sub(super::speed_at(a, p.anchor_a)))
            as f64;
        let magnitude = a.v.x.abs() as f64
            + a.v.y.abs() as f64
            + b.v.x.abs() as f64
            + b.v.y.abs() as f64
            + (a.w.abs() * p.anchor_a.length() + b.w.abs() * p.anchor_b.length()) as f64;
        if !vn.is_finite() || vn.abs() > 64.0 * f32::EPSILON as f64 * magnitude {
            return false;
        }
    }
    for (i, &(_, body, _)) in path.iter().enumerate() {
        let target = &mut world.bodies[ids[body] as usize];
        target.exact_center = centers[i];
        target.xf.q = rotations[i];
        pose_distance[ids[body] as usize] += corrections[i];
    }
    bodies.copy_from_slice(&staged_bodies);
    constraints.copy_from_slice(&staged_constraints);
    true
}

/// Component-local arrays keep disjoint paths linear in their total bodies/rows.
fn component(
    world: &mut World,
    bounces: &[Bounce],
    bodies: &mut [SolverBody],
    ids: &[u32],
    start: &[Rot],
    constraints: &mut [Constraint],
    initial_gaps: &[[f32; 2]],
    path: &[(usize, usize, usize)],
    dt: f32,
    h: f32,
    springs: &[Soft; 2],
    pose_distance: &mut [f32],
    weights: &[[f64; 3]],
) -> bool {
    let root = path[0].2;
    let mut local_bodies = Vec::with_capacity(path.len() + 1);
    local_bodies.push(bodies[root]);
    let mut local_ids = Vec::with_capacity(path.len() + 1);
    local_ids.push(ids[root]);
    let mut local_start = Vec::with_capacity(path.len() + 1);
    local_start.push(Rot::IDENTITY);
    let mut local_weights = Vec::with_capacity(path.len() + 1);
    local_weights.push(weights[root]);
    let mut local_constraints = Vec::with_capacity(path.len());
    let mut local_bounces = Vec::with_capacity(path.len());
    let mut local_gaps = Vec::with_capacity(path.len());
    let mut local_path = Vec::with_capacity(path.len());
    for (i, &(ci, body, _)) in path.iter().enumerate() {
        local_bodies.push(bodies[body]);
        local_ids.push(ids[body]);
        local_start.push(start[body]);
        local_weights.push(weights[body]);
        let mut c = constraints[ci];
        (c.a, c.b) = if c.a as usize == body {
            ((i + 1) as u32, i as u32)
        } else {
            (i as u32, (i + 1) as u32)
        };
        local_constraints.push(c);
        local_bounces.push(bounces[ci]);
        local_gaps.push(initial_gaps[i]);
        local_path.push((i, i + 1, i));
    }
    if !component_local(
        world,
        &local_bounces,
        &mut local_bodies,
        &local_ids,
        &local_start,
        &mut local_constraints,
        &local_gaps,
        &local_path,
        dt,
        h,
        springs,
        pose_distance,
        &local_weights,
    ) {
        return false;
    }
    for (i, &(ci, body, _)) in path.iter().enumerate() {
        bodies[body] = local_bodies[i + 1];
        constraints[ci].points = local_constraints[i].points;
        constraints[ci].pushed = local_constraints[i].pushed;
    }
    true
}

fn dynamic_body(world: &World, ids: &[u32], body: usize) -> bool {
    let b = &world.bodies[ids[body] as usize];
    b.kind == Kind::Dynamic && b.awake
}

/// Frame-fixed eligibility. In particular, never read mutable World velocities after joint passes.
fn fixed_domain(world: &World, c: &Constraint, bounce: &Bounce) -> bool {
    let contact = &world.contacts[c.contact as usize];
    world.shapes[contact.a as usize].restitution == 0.0
        && world.shapes[contact.b as usize].restitution == 0.0
        && bounce.approach[..c.count as usize]
            .iter()
            .all(|v| v.is_finite() && *v <= 0.0)
}

pub(super) struct Plan {
    paths: Vec<Vec<(usize, usize, usize)>>,
    weights: Vec<[f64; 3]>,
    gaps: Vec<Vec<[f32; 2]>>,
}
impl Plan {
    /// Only candidate path rows need a pre-substep recovery budget snapshot.
    pub(super) fn snapshot(&mut self, bodies: &[SolverBody], constraints: &[Constraint]) {
        for (path, gaps) in self.paths.iter().zip(&mut self.gaps) {
            for (&(ci, _, _), value) in path.iter().zip(gaps) {
                let c = &constraints[ci];
                *value = [gap(bodies, c, &c.points[0]), gap(bodies, c, &c.points[1])];
            }
        }
    }
}

/// Graph ownership, restitution, joint topology and original approach are fixed for this whole frame.
pub(super) fn plan(
    world: &World,
    ids: &[u32],
    constraints: &[Constraint],
    bounces: &[Bounce],
) -> Option<Plan> {
    if !(world.settings.contact_max_push > 0.0 && world.settings.contact_max_push.is_finite()) {
        return None;
    }
    let mut paths = Vec::new();
    let mut edges = alloc::vec![Vec::new();ids.len()];
    let dynamic: Vec<_> = ids
        .iter()
        .map(|&id| {
            world.bodies[id as usize].kind == Kind::Dynamic && world.bodies[id as usize].awake
        })
        .collect();
    for (ci, c) in constraints.iter().enumerate() {
        if dynamic[c.a as usize] {
            edges[c.a as usize].push(ci);
        }
        if dynamic[c.b as usize] {
            edges[c.b as usize].push(ci);
        }
    }
    let mut visited = alloc::vec![false;ids.len()];
    let mut jointed = alloc::vec![false;world.bodies.len()];
    for j in &world.joints {
        jointed[j.def.a as usize] = true;
        jointed[j.def.b as usize] = true;
    }
    for seed in 0..ids.len() {
        if visited[seed] || !dynamic[seed] || edges[seed].is_empty() {
            continue;
        }
        let mut todo = alloc::vec![seed];
        let mut members = Vec::new();
        let mut terminals = Vec::new();
        let mut valid = true;
        visited[seed] = true;
        while let Some(body) = todo.pop() {
            members.push(body);
            valid &= edges[body].len() <= 2;
            let id = ids[body];
            valid &= !jointed[id as usize];
            valid &= edges[body]
                .iter()
                .all(|&ci| fixed_domain(world, &constraints[ci], &bounces[ci]));
            for &ci in &edges[body] {
                let c = &constraints[ci];
                let other = if c.a as usize == body {
                    c.b as usize
                } else {
                    c.a as usize
                };
                if !dynamic[other] {
                    valid &= world.bodies[ids[other] as usize].kind == Kind::Static;
                    terminals.push((ci, body, other));
                } else if !visited[other] {
                    visited[other] = true;
                    todo.push(other);
                }
            }
        }
        if !valid || terminals.len() != 1 {
            continue;
        }
        let (mut ci, mut body, mut parent) = terminals[0];
        let mut path = Vec::new();
        loop {
            path.push((ci, body, parent));
            let next = edges[body].iter().copied().find(|&edge| edge != ci);
            let Some(next) = next else {
                break;
            };
            let c = &constraints[next];
            let other = if c.a as usize == body {
                c.b as usize
            } else {
                c.a as usize
            };
            parent = body;
            body = other;
            ci = next;
            if path.len() > members.len() {
                valid = false;
                break;
            }
        }
        if valid && path.len() == members.len() {
            paths.push(path);
        }
    }
    if paths.is_empty() {
        return None;
    }
    let weights: Vec<_> = ids
        .iter()
        .map(|&id| {
            let b = &world.bodies[id as usize];
            if b.kind == Kind::Dynamic && b.awake {
                [b.inv_mass as f64, b.inv_mass as f64, b.inv_inertia as f64]
            } else {
                [0.0; 3]
            }
        })
        .collect();

    let gaps = paths
        .iter()
        .map(|path| alloc::vec![[0.0;2];path.len()])
        .collect();
    Some(Plan {
        paths,
        weights,
        gaps,
    })
}

pub(super) fn stabilize(
    plan: &Plan,
    world: &mut World,
    bodies: &mut [SolverBody],
    ids: &[u32],
    start: &[Rot],
    constraints: &mut [Constraint],
    bounces: &[Bounce],
    dt: f32,
    h: f32,
    springs: &[Soft; 2],
    pose_distance: &mut [f32],
) {
    for (path, gaps) in plan.paths.iter().zip(&plan.gaps) {
        component(
            world,
            bounces,
            bodies,
            ids,
            start,
            constraints,
            gaps,
            path,
            dt,
            h,
            springs,
            pose_distance,
            &plan.weights,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_bounces(w: &World, s: &super::super::Scratch) -> Vec<Bounce> {
        s.constraints
            .iter()
            .map(|c| {
                let a = &w.bodies[s.ids[c.a as usize] as usize];
                let b = &w.bodies[s.ids[c.b as usize] as usize];
                let ma = super::super::Motion {
                    v: a.linear_velocity,
                    w: a.angular_velocity,
                };
                let mb = super::super::Motion {
                    v: b.linear_velocity,
                    w: b.angular_velocity,
                };
                let mut approach = [0.0; 2];
                for (k, p) in c.points[..c.count as usize].iter().enumerate() {
                    approach[k] = c.normal.dot(
                        super::super::speed_at(mb, p.anchor_b)
                            .sub(super::super::speed_at(ma, p.anchor_a)),
                    );
                }
                Bounce {
                    restitution: 0.0,
                    approach,
                }
            })
            .collect()
    }
    #[test]
    fn external_support_feasibility_rejects_slope_torque_and_tension() {
        assert!(
            normal_wrench([0.0, -9.81, 0.0], [0.0, 1.0], [-0.5, 0.5], 2, 1.0 / 240.0).is_some()
        );
        assert!(
            normal_wrench(
                [0.0, -9.81, 0.0],
                [0.5, 0.8660254],
                [-0.5, 0.5],
                2,
                1.0 / 240.0
            )
            .is_none()
        );
        assert!(normal_wrench([0.0, -9.81, 1.0], [0.0, 1.0], [0.0, 0.0], 1, 1.0 / 240.0).is_none());
        assert!(normal_wrench([0.0, 9.81, 0.0], [0.0, 1.0], [-0.5, 0.5], 2, 1.0 / 240.0).is_none());
        assert!(
            normal_wrench([0.0, -9.81, 100.0], [0.0, 1.0], [-0.5, 0.5], 2, 1.0 / 240.0).is_none()
        );
    }
    #[test]
    fn external_support_has_no_mass_cutoff() {
        for e in -60..=60 {
            let f = 2.0f64.powi(e);
            let l = normal_wrench([0.0, -f, 0.0], [0.0, 1.0], [-0.5, 0.5], 2, 0.25).unwrap();
            assert_eq!(l, [0.125 * f, 0.125 * f]);
        }
    }
    #[test]
    fn the_coupled_path_reaches_the_original_thousand_load_root_and_exposes_motion_to_sleep() {
        use crate::math::v2;
        use crate::shape::Core;
        use crate::world::{BodyDef, ShapeDef};
        let mut w = World::default();
        let g = w
            .create_body(&BodyDef {
                kind: Kind::Static,
                ..Default::default()
            })
            .unwrap();
        w.create_shape(
            g,
            Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(),
            &ShapeDef::default(),
        )
        .unwrap();
        let mut ids = Vec::new();
        for i in 0..4 {
            let b = w
                .create_body(&BodyDef {
                    position: v2(0.0, 0.5 + i as f32),
                    ..Default::default()
                })
                .unwrap();
            w.create_shape(
                b,
                Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(),
                &ShapeDef {
                    density: if i == 3 { 1000.0 } else { 1.0 },
                    friction: 0.6,
                    restitution: 0.0,
                },
            )
            .unwrap();
            ids.push(b);
        }
        for i in 0..120 {
            w.step(1.0 / 60.0).unwrap();
            if i == 0 {
                assert!(w.scratch.pose_speed[ids[3] as usize] > w.settings.sleep_threshold);
                assert!(w.bodies[ids[3] as usize].awake);
            }
        }
        let drop = 3.5 - w.bodies[ids[3] as usize].exact_center[1];
        assert!((drop - 0.518550735877024).abs() < 0.03 * 0.518550735877024);
        assert!(!w.bodies[ids[3] as usize].awake);
    }
    fn column(load: f32, offsets: [f32; 4], reverse: bool) -> (World, Vec<u32>) {
        use crate::math::v2;
        use crate::shape::Core;
        use crate::world::{BodyDef, Settings, ShapeDef};
        let mut w = World::new(Settings {
            sleep: false,
            ..Default::default()
        });
        let g = w
            .create_body(&BodyDef {
                kind: Kind::Static,
                ..Default::default()
            })
            .unwrap();
        w.create_shape(
            g,
            Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(),
            &ShapeDef::default(),
        )
        .unwrap();
        let mut ids = alloc::vec![0;4];
        for order in 0..4 {
            let i = if reverse { 3 - order } else { order };
            let b = w
                .create_body(&BodyDef {
                    position: v2(offsets[i], 0.5 + i as f32),
                    ..Default::default()
                })
                .unwrap();
            w.create_shape(
                b,
                Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(),
                &ShapeDef {
                    density: if i == 3 { load } else { 1.0 },
                    friction: 0.6,
                    restitution: 0.0,
                },
            )
            .unwrap();
            ids[i] = b;
        }
        (w, ids)
    }
    fn bits(w: &World, s: &super::super::Scratch) -> Vec<u64> {
        let mut result = Vec::new();
        for b in &w.bodies {
            result.extend(b.exact_center.map(f64::to_bits));
            result.extend(
                [
                    b.xf.q.c,
                    b.xf.q.s,
                    b.linear_velocity.x,
                    b.linear_velocity.y,
                    b.angular_velocity,
                ]
                .map(|v| v.to_bits() as u64),
            );
        }
        for b in &s.bodies {
            result.extend(
                [b.v.x, b.v.y, b.w, b.moved.x, b.moved.y, b.turn.c, b.turn.s]
                    .map(|v| v.to_bits() as u64),
            );
        }
        for c in &s.constraints {
            for p in &c.points {
                result.extend(
                    [p.normal_impulse, p.tangent_impulse, p.base].map(|v| v.to_bits() as u64),
                );
            }
            result.push(c.pushed as u64);
        }
        result
    }
    fn declined_unchanged(
        mut w: World,
        ids: &[u32],
        mutate: impl FnOnce(&mut World, &mut super::super::Scratch),
    ) {
        for _ in 0..90 {
            w.step(1.0 / 60.0).unwrap();
        }
        let mut scratch = core::mem::take(&mut w.scratch);
        mutate(&mut w, &mut scratch);
        let mut path = Vec::new();
        for (i, &id) in ids.iter().enumerate() {
            let parent_id = if i == 0 { 0 } else { ids[i - 1] };
            let body = scratch.ids.iter().position(|&v| v == id).unwrap();
            let parent = scratch.ids.iter().position(|&v| v == parent_id).unwrap();
            let ci = scratch
                .constraints
                .iter()
                .position(|c| {
                    (c.a as usize == body && c.b as usize == parent)
                        || (c.b as usize == body && c.a as usize == parent)
                })
                .unwrap();
            path.push((ci, body, parent));
        }
        let initial: Vec<_> = path
            .iter()
            .map(|&(ci, _, _)| {
                let c = &scratch.constraints[ci];
                [
                    gap(&scratch.bodies, c, &c.points[0]),
                    gap(&scratch.bodies, c, &c.points[1]),
                ]
            })
            .collect();
        let weights: Vec<_> = scratch
            .ids
            .iter()
            .map(|&id| {
                let b = &w.bodies[id as usize];
                if b.kind == Kind::Dynamic {
                    [b.inv_mass as f64, b.inv_mass as f64, b.inv_inertia as f64]
                } else {
                    [0.0; 3]
                }
            })
            .collect();
        let mut observed = alloc::vec![0.0;w.bodies.len()];
        let before = bits(&w, &scratch);
        let springs = [
            super::super::soft(60.0, 10.0, 1.0 / 240.0),
            super::super::soft(30.0, 10.0, 1.0 / 240.0),
        ];
        let bounces = test_bounces(&w, &scratch);
        assert!(!component(
            &mut w,
            &bounces,
            &mut scratch.bodies,
            &scratch.ids,
            &scratch.start,
            &mut scratch.constraints,
            &initial,
            &path,
            1.0 / 240.0,
            1.0 / 240.0,
            &springs,
            &mut observed,
            &weights
        ));
        assert_eq!(
            bits(&w, &scratch),
            before,
            "a declined proposal changed state"
        );
        assert!(observed.into_iter().all(|v| v == 0.0));
    }
    #[test]
    fn separating_kicks_open_rows_bounce_and_unsupported_wrenches_decline_atomically() {
        for kick in [0.001, 0.1, 5.0] {
            let (w, ids) = column(1000.0, [0.0; 4], false);
            declined_unchanged(w, &ids, |w, s| {
                for b in &mut w.bodies {
                    if b.kind == Kind::Dynamic {
                        b.linear_velocity.y = kick;
                    }
                }
                for (i, b) in s.bodies.iter_mut().enumerate() {
                    if w.bodies[s.ids[i] as usize].kind == Kind::Dynamic {
                        b.v.y = kick;
                    }
                }
            });
        }
        let (w, ids) = column(1000.0, [0.0; 4], false);
        declined_unchanged(w, &ids, |_, s| s.constraints[0].points[0].base += 10.0);
        let (w, ids) = column(1000.0, [0.0; 4], false);
        declined_unchanged(w, &ids, |w, _| {
            w.shapes.last_mut().unwrap().restitution = 0.8
        });
        let (w, ids) = column(1000.0, [0.0; 4], false);
        declined_unchanged(w, &ids, |w, _| w.settings.gravity.x = 0.5);
        let (w, ids) = column(1000.0, [0.0; 4], false);
        declined_unchanged(w, &ids, |w, _| w.settings.contact_max_push = 0.0);
        let (w, ids) = column(1000.0, [0.0; 4], false);
        declined_unchanged(w, &ids, |w, s| {
            let ci = s
                .constraints
                .iter()
                .position(|c| {
                    w.bodies[s.ids[c.a as usize] as usize].kind == Kind::Static
                        || w.bodies[s.ids[c.b as usize] as usize].kind == Kind::Static
                })
                .unwrap();
            let c = &mut s.constraints[ci];
            for p in 0..2 {
                if w.bodies[s.ids[c.a as usize] as usize].kind == Kind::Dynamic {
                    c.points[p].anchor_a.x = 2.0 + p as f32;
                } else {
                    c.points[p].anchor_b.x = 2.0 + p as f32;
                }
            }
        });
    }
    #[test]
    fn loads_crossing_spring_policy_boundary_and_creation_order_remain_finite() {
        for load in [0.01, 0.1, 1.0, 10.0, 49.0, 50.0, 51.0, 100.0, 1000.0] {
            for reverse in [false, true] {
                let (mut w, ids) = column(load, [0.0; 4], reverse);
                for _ in 0..180 {
                    w.step(1.0 / 60.0).unwrap();
                }
                let b = &w.bodies[ids[3] as usize];
                assert!(b.exact_center.into_iter().all(f64::is_finite));
                assert!(b.exact_center[0].abs() < 1e-4);
                assert!(b.linear_velocity.y.abs() < 0.05);
            }
        }
    }

    #[test]
    fn recurrence_matches_generic_physical_mass_solve_and_preserves_nullspace() {
        for d in [[0.0, 1.0], [1.0, 0.0], [0.6, 0.8], [-0.8, 0.6]] {
            for masses in [[1.0, 1.0, 1.0], [1.0, 1.0, 1000.0], [0.1, 3.0, 10.0]] {
                let mut rows = Vec::new();
                let mut path = Vec::new();
                let mut rhs = Vec::new();
                let mut weights = alloc::vec![[0.0; 3]];
                for i in 0..3 {
                    weights.push([1.0 / masses[i], 1.0 / masses[i], 6.0 / masses[i]]);
                    path.push((i, i + 1, i));
                    for p in 0..2 {
                        let arm = if p == 0 { -0.5 } else { 0.5 };
                        rows.push(Row {
                            a: i,
                            b: i + 1,
                            ja: [-d[0], -d[1], -arm + 0.01 * i as f64],
                            jb: [d[0], d[1], arm + 0.02 * i as f64],
                            contact: i,
                            point: p,
                            gap: 0.0,
                            target: 0.0,
                        });
                        rhs.push(-0.01 * (1 + i + p) as f64);
                    }
                }
                let matrix = Banded::new(&rows, &weights).unwrap();
                let mu = matrix.solve(&rhs).unwrap();
                let mut generic = alloc::vec![[0.0;3];4];
                for (r, &u) in rows.iter().zip(&mu) {
                    for (body, j) in [(r.a, r.ja), (r.b, r.jb)] {
                        for k in 0..3 {
                            generic[body][k] += weights[body][k] * j[k] * u;
                        }
                    }
                }
                let mut exact = alloc::vec![[0.0;3];4];
                assert!(parallel_positions(&rows, &rhs, &path, d, &mut exact));
                for i in 1..4 {
                    for k in 0..3 {
                        assert!(
                            (exact[i][k] - generic[i][k]).abs() < 1e-10 * (1.0 + exact[i][k].abs())
                        );
                    }
                    assert!(rounded_zero(
                        d[1] * exact[i][0] - d[0] * exact[i][1],
                        (d[1] * exact[i][0]).abs() + (d[0] * exact[i][1]).abs(),
                        8
                    ));
                }
            }
        }
    }
    #[test]
    fn branch_cycle_and_point_count_changes_leave_no_stale_path_state() {
        let (mut w, ids) = column(1000.0, [0.0; 4], false);
        for _ in 0..90 {
            w.step(1.0 / 60.0).unwrap();
        }
        let mut s = core::mem::take(&mut w.scratch);
        let original = s.constraints.clone();
        let duplicate = s.constraints[1];
        s.constraints.push(duplicate);
        let before = bits(&w, &s);
        let bounces = test_bounces(&w, &s);
        assert!(
            plan(&w, &s.ids, &s.constraints, &bounces).is_none(),
            "a branched component must not enter the substep path stage"
        );
        assert_eq!(bits(&w, &s), before);
        s.constraints = original;
        w.scratch = s;
        w.step(1.0 / 60.0).unwrap();
        assert!(
            w.bodies[ids[3] as usize]
                .exact_center
                .into_iter()
                .all(f64::is_finite)
        );
        let (w, ids) = column(1000.0, [0.0; 4], false);
        declined_unchanged(w, &ids, |_, s| {
            s.constraints[0].count = 1;
        });
    }
    #[test]
    fn changing_gravity_rebuilds_the_support_target_and_respects_sleep_observer() {
        let (mut w, ids) = column(1000.0, [0.0; 4], false);
        for _ in 0..90 {
            w.step(1.0 / 60.0).unwrap();
        }
        let initial = 3.5 - w.bodies[ids[3] as usize].exact_center[1];
        w.settings.gravity.y *= 0.5;
        let before = w.bodies[ids[3] as usize].exact_center[1];
        w.step(1.0 / 60.0).unwrap();
        let moved = w.bodies[ids[3] as usize].exact_center[1] - before;
        assert!(moved <= w.settings.contact_max_push as f64 / 60.0 + 1e-6);
        assert!(w.scratch.pose_speed[ids[3] as usize] > w.settings.sleep_threshold);
        for _ in 0..120 {
            w.step(1.0 / 60.0).unwrap();
        }
        let final_drop = 3.5 - w.bodies[ids[3] as usize].exact_center[1];
        assert!((final_drop - initial * 0.5).abs() < initial * 0.03);
    }
}
