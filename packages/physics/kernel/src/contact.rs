// What a contact point keeps from one step to the next. A solver that starts each step at zero spends its iterations
// rebuilding the forces of a stack; started from last step's impulses it needs few (Catto 2005, warm starting). So a new
// manifold's points look for the points they continue: by id first, the features that made them, and then the nearest old
// point on body A, since a clipped point's id can change while the point barely moves.
//
// An impulse carries as a world vector and is split along the new normal, so a turning normal hands normal impulse to the
// tangent and back, and the sum stays what the bodies last felt. An impulse is a force times a substep, so when the
// substep changes length it scales with it.
use crate::integrate::{apply_inverse_inertia, lock};
use crate::layout::*;
use crate::math::*;
use crate::narrow::{Manifold, Point};
use crate::world::World;

/// An old point this far from a new one on body A is a different point.
const SAME_PLACE: f32 = 0.02;

/// What a point keeps.
#[derive(Clone, Copy)]
pub struct Kept {
    pub id: u32,
    pub anchor_a: V3,
    pub normal_impulse: f32,
    pub tangent_impulse: V3,
    pub drift: V3,
}

/// Which old point each new one continues, `MANIFOLD` when none. An old point goes to one new point at most.
pub fn match_points(old: &[Kept], new: &[(u32, V3)]) -> [usize; MANIFOLD] {
    let mut matched = [MANIFOLD; MANIFOLD];
    let mut taken = [false; MANIFOLD];
    for (k, point) in new.iter().enumerate() {
        for (j, kept) in old.iter().enumerate() {
            if !taken[j] && kept.id == point.0 {
                matched[k] = j;
                taken[j] = true;
                break;
            }
        }
    }
    for (k, point) in new.iter().enumerate() {
        if matched[k] != MANIFOLD {
            continue;
        }
        let mut nearest = SAME_PLACE * SAME_PLACE;
        for (j, kept) in old.iter().enumerate() {
            let between = kept.anchor_a.sub(point.1);
            let squared = between.dot(between);
            if !taken[j] && squared < nearest {
                nearest = squared;
                matched[k] = j;
            }
        }
        if matched[k] != MANIFOLD {
            taken[matched[k]] = true;
        }
    }
    matched
}

/// What a kept point becomes under a new normal: normal impulse, tangent impulse and drift, the impulse split along that
/// normal and scaled by `ratio`, the new substep over the old. Shapes that now push the other way carry nothing.
pub fn reproject(kept: &Kept, old_normal: V3, normal: V3, ratio: f32) -> (f32, V3, V3) {
    let impulse = old_normal.scale(kept.normal_impulse).add(kept.tangent_impulse);
    let along = impulse.dot(normal);
    if along <= 0.0 {
        return (0.0, v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0));
    }
    let tangent = impulse.sub(normal.scale(along));
    let drift = kept.drift.sub(normal.scale(kept.drift.dot(normal)));
    (along * ratio, tangent.scale(ratio), drift)
}

/// A deterministic unit vector square to the unit vector `n`, with no trigonometry: the tangent plane's first axis, the
/// second being `n` cross this. It leaves out the smallest component of `n`, so it never divides by a small number.
#[inline(always)]
pub fn tangent_of(n: V3) -> V3 {
    let a = n.abs();
    let t = if a.x <= a.y && a.x <= a.z {
        v3(0.0, n.z, -n.y)
    } else if a.y <= a.z {
        v3(-n.z, 0.0, n.x)
    } else {
        v3(n.y, -n.x, 0.0)
    };
    t.scale(1.0 / sqrt(t.dot(t)))
}

impl World {
    /// The points a pair holds now, as they will be kept.
    fn kept(&self, row: usize, out: &mut [Kept; MANIFOLD]) -> usize {
        let count = self.uu(PAIR_CONTACTS, row) as usize;
        for (k, kept) in out.iter_mut().enumerate().take(count) {
            let at = row * MANIFOLD + k;
            *kept = Kept {
                id: self.uu(CONTACT_ID, at),
                anchor_a: self.v(CONTACT_ANCHOR_A_X, at),
                normal_impulse: self.s(CONTACT_NORMAL_IMPULSE, at),
                tangent_impulse: self.v(CONTACT_TANGENT_X, at),
                drift: self.v(CONTACT_DRIFT_X, at),
            };
        }
        count
    }

    /// Writes a manifold into a pair's rows, with anchors from each body's centre of mass in each body's frame, and each
    /// point carrying what the point it continues had. `ratio` is the new substep over the old.
    pub fn store_manifold(&mut self, row: usize, a: usize, b: usize, manifold: &Manifold, ratio: f32) {
        let zero = v3(0.0, 0.0, 0.0);
        let mut old = [Kept { id: 0, anchor_a: zero, normal_impulse: 0.0, tangent_impulse: zero, drift: zero }; MANIFOLD];
        let old_count = self.kept(row, &mut old);
        let old_normal = self.v(PAIR_NORMAL_X, row);
        let (rotation_a, rotation_b) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
        let center_a = self.v(POSITION_X, a).add(rotation_a.rotate(self.v(LOCAL_CENTER_X, a)));
        let center_b = self.v(POSITION_X, b).add(rotation_b.rotate(self.v(LOCAL_CENTER_X, b)));
        let mut new = [(0, zero); MANIFOLD];
        for (k, point) in manifold.points.iter().enumerate().take(manifold.count) {
            new[k] = (point.id, rotation_a.unrotate(point.on_a.sub(center_a)));
        }
        let matched = match_points(&old[..old_count], &new[..manifold.count]);
        self.set_u(PAIR_CONTACTS, row, manifold.count as u32);
        self.set_v(PAIR_NORMAL_X, row, manifold.normal);
        for (k, point) in manifold.points.iter().enumerate().take(manifold.count) {
            let at = row * MANIFOLD + k;
            self.write_point(at, point, new[k].1, rotation_b.unrotate(point.on_b.sub(center_b)));
            let (normal_impulse, tangent, drift) =
                if matched[k] == MANIFOLD { (0.0, zero, zero) } else { reproject(&old[matched[k]], old_normal, manifold.normal, ratio) };
            self.set_s(CONTACT_NORMAL_IMPULSE, at, normal_impulse);
            self.set_v(CONTACT_TANGENT_X, at, tangent);
            self.set_v(CONTACT_DRIFT_X, at, drift);
        }
    }

    #[inline(always)]
    fn write_point(&mut self, at: usize, point: &Point, anchor_a: V3, anchor_b: V3) {
        self.set_v(CONTACT_ANCHOR_A_X, at, anchor_a);
        self.set_v(CONTACT_ANCHOR_B_X, at, anchor_b);
        self.set_s(CONTACT_SEPARATION, at, point.separation);
        self.set_u(CONTACT_ID, at, point.id);
        self.set_v(CONTACT_X, at, point.on_a.add(point.on_b).scale(0.5));
    }

    /// One impulse at a point `arm` from a body's centre of mass, on an awake dynamic body, through its locks.
    #[inline(always)]
    pub fn apply_impulse(&mut self, at: usize, impulse: V3, arm: V3) {
        let flags = self.flags(at);
        if flags & KIND != DYNAMIC || flags & SLEEPING != 0 {
            return;
        }
        let mut linear = impulse.scale(self.s(INVERSE_MASS, at));
        let frame = self.q(ROTATION_X, at).mul(self.q(INERTIA_FRAME_X, at));
        let mut turn = apply_inverse_inertia(self.v(INVERSE_INERTIA_X, at), frame, arm.cross(impulse));
        if flags & LOCK_LINEAR != 0 {
            linear = lock(linear, flags / LOCK_LINEAR_X);
        }
        if flags & LOCK_ANGULAR != 0 {
            turn = lock(turn, flags / LOCK_ANGULAR_X);
        }
        self.set_v(LINEAR_X, at, self.v(LINEAR_X, at).add(linear));
        self.set_v(ANGULAR_X, at, self.v(ANGULAR_X, at).add(turn));
    }

    /// Gives every touching pair of the active list the impulses its points carry, at the anchors, from A to B.
    pub fn warm_start(&mut self) {
        for i in 0..self.header().active_pairs as usize {
            let row = self.uu(ACTIVE_PAIRS, i) as usize;
            let count = self.uu(PAIR_CONTACTS, row) as usize;
            if count == 0 {
                continue;
            }
            let (a, b) = self.pair_bodies(row as u32);
            let normal = self.v(PAIR_NORMAL_X, row);
            let (rotation_a, rotation_b) = (self.q(ROTATION_X, a), self.q(ROTATION_X, b));
            for k in 0..count {
                let at = row * MANIFOLD + k;
                let impulse = normal.scale(self.s(CONTACT_NORMAL_IMPULSE, at)).add(self.v(CONTACT_TANGENT_X, at));
                let (arm_a, arm_b) = (rotation_a.rotate(self.v(CONTACT_ANCHOR_A_X, at)), rotation_b.rotate(self.v(CONTACT_ANCHOR_B_X, at)));
                self.apply_impulse(a, impulse.scale(-1.0), arm_a);
                self.apply_impulse(b, impulse, arm_b);
            }
        }
    }
}
