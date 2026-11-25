// What a contact point keeps from one step to the next. A solver that starts each step at zero spends its iterations
// rebuilding the forces of a stack; started from last step's impulses it needs few (Catto 2005, warm starting). So a new
// manifold's points look for the points they continue: by id first, the features that made them, and then the nearest old
// point on body A, since a clipped point's id can change while the point barely moves.
//
// An impulse carries as a world vector and is split along the new normal, so a turning normal hands normal impulse to the
// tangent and back, and the sum stays what the bodies last felt. An impulse is a force times a substep, so when the
// substep changes length it scales with it.
use crate::layout::*;
use crate::math::*;
use crate::narrow::{Manifold, Point};
use crate::world::{NONE, World};

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
        // A skin makes each shape thicker by it, along the contact normal: the points move out and the separation shrinks.
        let (skin_a, skin_b) = (self.s(COLLIDER_SKIN, self.uu(PAIR_A, row) as usize), self.s(COLLIDER_SKIN, self.uu(PAIR_B, row) as usize));
        let skinned;
        let manifold = if skin_a + skin_b > 0.0 {
            let mut thick = *manifold;
            for point in thick.points.iter_mut().take(thick.count) {
                point.on_a = point.on_a.add(thick.normal.scale(skin_a));
                point.on_b = point.on_b.sub(thick.normal.scale(skin_b));
                point.separation -= skin_a + skin_b;
            }
            skinned = thick;
            &skinned
        } else {
            manifold
        };
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

    /// Contact clustering (Rapier's `contact_clustering`): the parts of a pair (a mesh's triangles, a compound's children) whose contact
    /// normals are within the angle of one another are one plane, and the plane keeps four points of all those its parts found: the
    /// deepest, the farthest from it, the one that makes the largest triangle with those two and the one farthest from the middle of
    /// the three. The others leave their parts, so a box on a floor of many triangles is solved on four points, not on the dozen they
    /// give, and a point that is kept carries its impulses with it. The deepest point always stays, so what touches still touches.
    pub fn cluster_parts(&mut self, row: usize) {
        const MOST: usize = 512;
        let mut part_of = [0u32; MOST];
        let mut index_of = [0u8; MOST];
        let mut at = [v3(0.0, 0.0, 0.0); MOST];
        let mut depth = [0.0f32; MOST];
        let mut plane = [u8::MAX; MOST];
        let mut count = 0;
        let mut part = self.uu(PAIR_CHILD, row);
        while part != NONE {
            let p = part as usize;
            for k in 0..self.uu(PAIR_CONTACTS, p) as usize {
                // More points than the table holds: leave the pair as it is.
                if count == MOST {
                    return;
                }
                part_of[count] = part;
                index_of[count] = k as u8;
                at[count] = self.v(CONTACT_X, p * MANIFOLD + k);
                depth[count] = self.s(CONTACT_SEPARATION, p * MANIFOLD + k);
                count += 1;
            }
            part = self.uu(PAIR_CHILD, p);
        }
        if count <= MANIFOLD {
            return;
        }
        // Planes: a point joins the first plane whose seed's part has a normal within the angle of its own part's.
        let cosine = self.header().cluster;
        let mut seeds = [0usize; MOST];
        let mut planes = 0;
        for i in 0..count {
            let normal = self.v(PAIR_NORMAL_X, part_of[i] as usize);
            let mut found = u8::MAX;
            for (s, &seed) in seeds.iter().enumerate().take(planes) {
                if normal.dot(self.v(PAIR_NORMAL_X, part_of[seed] as usize)) >= cosine {
                    found = s as u8;
                    break;
                }
            }
            if found == u8::MAX {
                // More planes than a byte names: leave the pair as it is.
                if planes == 254 {
                    return;
                }
                seeds[planes] = i;
                found = planes as u8;
                planes += 1;
            }
            plane[i] = found;
        }
        let mut keep = [true; MOST];
        for p in 0..planes as u8 {
            let members = (0..count).filter(|&i| plane[i] == p).count();
            if members <= MANIFOLD {
                continue;
            }
            let mut chosen = [usize::MAX; MANIFOLD];
            let mut taken = [false; MOST];
            let pick = |taken: &[bool; MOST], score: &dyn Fn(usize) -> f32| {
                let mut best = usize::MAX;
                let mut most = -1.0f32;
                for i in 0..count {
                    if plane[i] == p && !taken[i] {
                        let s = score(i);
                        if s > most {
                            most = s;
                            best = i;
                        }
                    }
                }
                best
            };
            chosen[0] = pick(&taken, &|i| -depth[i] + 1e6);
            taken[chosen[0]] = true;
            let first = at[chosen[0]];
            chosen[1] = pick(&taken, &|i| {
                let d = at[i].sub(first);
                d.dot(d)
            });
            taken[chosen[1]] = true;
            let edge = at[chosen[1]].sub(first);
            chosen[2] = pick(&taken, &|i| {
                let c = at[i].sub(first).cross(edge);
                c.dot(c)
            });
            taken[chosen[2]] = true;
            let middle = first.add(at[chosen[1]]).add(at[chosen[2]]).scale(1.0 / 3.0);
            chosen[3] = pick(&taken, &|i| {
                let d = at[i].sub(middle);
                d.dot(d)
            });
            for i in 0..count {
                if plane[i] == p {
                    keep[i] = chosen.contains(&i);
                }
            }
        }
        // Each part keeps its chosen points, packed from the front with all they carry.
        let mut part = self.uu(PAIR_CHILD, row);
        while part != NONE {
            let p = part as usize;
            let before = self.uu(PAIR_CONTACTS, p) as usize;
            let mut kept = 0;
            for k in 0..before {
                let wanted = (0..count).any(|i| part_of[i] == part && index_of[i] as usize == k && keep[i]);
                if wanted {
                    if kept != k {
                        self.copy_point(p * MANIFOLD + k, p * MANIFOLD + kept);
                    }
                    kept += 1;
                }
            }
            if kept != before {
                self.set_u(PAIR_CONTACTS, p, kept as u32);
            }
            part = self.uu(PAIR_CHILD, p);
        }
    }

    /// Copies what a manifold point carries between the carried columns: where it is, its separation and id, and the impulses it holds.
    fn copy_point(&mut self, from: usize, to: usize) {
        for column in [
            CONTACT_ANCHOR_A_X, CONTACT_ANCHOR_A_Y, CONTACT_ANCHOR_A_Z, CONTACT_ANCHOR_B_X, CONTACT_ANCHOR_B_Y, CONTACT_ANCHOR_B_Z,
            CONTACT_SEPARATION, CONTACT_X, CONTACT_Y, CONTACT_Z, CONTACT_NORMAL_IMPULSE, CONTACT_TANGENT_X, CONTACT_TANGENT_Y,
            CONTACT_TANGENT_Z, CONTACT_DRIFT_X, CONTACT_DRIFT_Y, CONTACT_DRIFT_Z,
        ] {
            self.set_s(column, to, self.s(column, from));
        }
        self.set_u(CONTACT_ID, to, self.uu(CONTACT_ID, from));
    }
}
