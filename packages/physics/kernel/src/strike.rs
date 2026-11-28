// Strike pieces (KB-PHYS-CCDKNOCK1): an island in which a body with continuous collision closes on, or turns into, another
// body faster than its points can follow cuts its substeps at the times of impact and finds its points again at each cut.
//
// Contacts are found once a step and every substep reuses those points (Macklin et al., "Small Steps in Physics Simulation",
// SCA 2019; Mueller et al., "Detailed Rigid Body Simulation with Extended Position Based Dynamics", SCA 2020). A spinning bar
// striking a plate turns more than a radian a substep, so the corners that meet the plate later in the step are in no manifold
// the step began with, and more substeps cannot find them: its sideways knock ran 45, 25, 11 and 18 m/s at 8 to 64 substeps
// where a step fine enough to find points again settles at 64 m/s. The strike is a train of impacts (five within 3 ms), and
// they must be met in time order (Mirtich, "Impulse-based Dynamic Simulation of Rigid Body Systems", PhD thesis, UC Berkeley,
// 1996; Smith, Kaufman, Vouga, Tamstorf and Grinspun, "Reflections on Simultaneous Impact", SIGGRAPH 2012).
//
// A body strikes when it has continuous collision on and could move further than its thinnest piece is thick in the step, the
// CCD pass's own test of a fast body; a slower one moves exactly as it would without continuous collision. So an island with a
// body that strikes advances conservatively (Mirtich 1996; Catto, "Continuous Collision", GDC 2013): before each piece it takes the
// least gap of its CCD pairs' points, at least `STRIKE_ARC` of the thinnest CCD piece, over the fastest any of them closes (the
// normal speed plus each body's spin across the normal times its reach; a ball's spin about its centre and a revolved shape's
// spin about its axis change no feature and do not count), and steps that long, the whole substep when that is longer. From the
// first cut to the step's end every piece starts by finding the island's pairs again (`refresh_pair`), with each new point
// carrying what the point it continues held, scaled down to a shorter piece and kept whole going longer. An island that never
// cuts runs its substeps exactly as before.
//
// Only islands whose every pair a thread could find (no mesh, compound, filtered or modified pair), whose bodies are dynamic or
// fixed, and that hold no joint, coupling or multibody take pieces; any other island runs its substeps whole, as before.
use crate::layout::*;
use crate::math::*;
use crate::solver::soft;
use crate::world::World;

/// The least part of its thinnest piece a striking CCD body may close or turn into contact over one piece: 2 percent. At
/// 0.4 mm on a bar 4 cm thick the strike's knock is within 5 percent of a fine step's; at 1 mm it is 12 percent under.
pub const STRIKE_ARC: f32 = 0.02;

/// The most pieces an island cuts its substeps into in one step. Past them its substeps run whole, still finding its points
/// again at each start. A 300 m/s bar striking a plate took 360.
pub const STRIKE_PIECES: u32 = 512;

impl World {
    /// The least room a strike piece allows in the island of `self.window` over a step of `dt` (`STRIKE_ARC` of its thinnest
    /// striking piece), or None when the island takes no pieces: adaptive substeps or continuous collision off, a joint, coupling
    /// or multibody in it, a pair it could not find again on its own, a body neither dynamic nor fixed, or no pair with a body
    /// that strikes (`strikes`).
    pub(crate) fn strike_bound(&self, dt: f32) -> Option<f32> {
        let header = self.header();
        if header.adaptive_substeps == 0 || header.ccd_substeps == 0 {
            return None;
        }
        let window = self.window;
        if window.pairs.0 == window.pairs.1 || window.joints.0 != window.joints.1 || window.couplings.0 != window.couplings.1 {
            return None;
        }
        let mut thin = f32::INFINITY;
        for i in window.pairs.0..window.pairs.1 {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            if !self.threadable(row) {
                return None;
            }
            let (first, second) = (self.uu(PAIR_A, row) as usize, self.uu(PAIR_B, row) as usize);
            if (self.uu(COLLIDER_FLAGS, first) | self.uu(COLLIDER_FLAGS, second)) & COLLIDER_MODIFY != 0 {
                return None;
            }
            let (a, b) = self.pair_bodies(row as u32);
            for body in [a, b] {
                let flags = self.flags(body);
                let kind = flags & KIND;
                if (kind != DYNAMIC && kind != FIXED) || self.uu(MB_ROLE, body) != 0 {
                    return None;
                }
                if self.strikes(body, dt) {
                    thin = thin.min(self.thin_and_reach(body).0);
                }
            }
        }
        if thin.is_finite() && thin > 0.0 { Some(STRIKE_ARC * thin) } else { None }
    }

    /// Whether body `at` strikes over a step of `dt`: dynamic, with continuous collision on, and fast enough to move further
    /// than its thinnest piece is thick in the step (its speed plus its spin times its reach), as the CCD pass asks of a body
    /// it sweeps. A slower body moves exactly as it would without continuous collision.
    fn strikes(&self, at: usize, dt: f32) -> bool {
        let flags = self.flags(at);
        if flags & KIND != DYNAMIC || flags & CCD == 0 {
            return false;
        }
        let (thin, reach) = self.thin_and_reach(at);
        let (linear, angular) = (self.v(LINEAR_X, at), self.v(ANGULAR_X, at));
        thin.is_finite() && (sqrt(linear.dot(linear)) + sqrt(angular.dot(angular)) * reach) * dt > thin
    }

    /// How fast collider `c` of body `at` can bring a new feature to a contact of normal `normal` by turning: its spin across
    /// the normal times its reach. A ball spinning about its centre and a capsule, cylinder or cone spinning about its own axis
    /// through the centre of mass turn no new feature to it, so that part of the spin does not count.
    fn turn_speed(&self, c: usize, at: usize, normal: V3) -> f32 {
        if self.flags(at) & KIND != DYNAMIC {
            return 0.0;
        }
        let mut spin = self.v(ANGULAR_X, at);
        let reach = self.collider_reach_of(c);
        let offset = self.v(COLLIDER_X, c).sub(self.v(LOCAL_CENTER_X, at));
        match self.uu(COLLIDER_SHAPE, c) {
            SHAPE_BALL if offset.dot(offset) <= 1e-12 * reach * reach => return 0.0,
            SHAPE_CAPSULE | SHAPE_CYLINDER | SHAPE_CONE => {
                // The axis in the body's frame; the collider turns about it only when the centre of mass lies on it.
                let axis = self.q(COLLIDER_ROTATION_X, c).rotate(v3(0.0, 1.0, 0.0));
                let across = offset.cross(axis);
                if across.dot(across) <= 1e-12 * reach * reach {
                    let world_axis = self.q(ROTATION_X, at).rotate(axis);
                    spin = spin.sub(world_axis.scale(spin.dot(world_axis)));
                }
            }
            _ => {}
        }
        let turn = spin.cross(normal);
        sqrt(turn.dot(turn)) * reach
    }

    /// The length of the next piece of a substep with `left` seconds still to go: the least room of the island's CCD pairs over
    /// the fastest they close (see the head of this file), at least `floor`, and the whole of `left` when that is longer or the
    /// rest would be shorter than `floor`.
    fn strike_piece(&self, left: f32, bound: f32, floor: f32, dt: f32) -> f32 {
        let mut ask = f32::INFINITY;
        for i in self.window.pairs.0..self.window.pairs.1 {
            let row = self.uu(SOLVE_PAIRS, i) as usize;
            let (a, b) = self.pair_bodies(row as u32);
            let count = self.uu(PAIR_CONTACTS, row) as usize;
            if count == 0 || !(self.strikes(a, dt) || self.strikes(b, dt)) {
                continue;
            }
            let gaps = self.point_gaps(row, a, b, 0.0, 0);
            let least = gaps[..count].iter().fold(f32::INFINITY, |least, &gap| least.min(gap));
            let room = least.max(bound);
            let normal = self.v(PAIR_NORMAL_X, row);
            let along = self.v(LINEAR_X, b).sub(self.v(LINEAR_X, a)).dot(normal);
            let (first, second) = (self.uu(PAIR_A, row) as usize, self.uu(PAIR_B, row) as usize);
            let closing = along.abs() + self.turn_speed(first, a, normal) + self.turn_speed(second, b, normal);
            if closing > 0.0 {
                ask = ask.min(room / closing);
            }
        }
        if ask >= left {
            return left;
        }
        let piece = ask.max(floor);
        if left - piece < floor { left } else { piece }
    }

    /// The island's substeps, `count` of `hi` seconds each in a step of `dt`, cut into strike pieces where its CCD pairs need
    /// them. A substep no pair needs cut, before the first cut, runs exactly as `run_substeps` would run it.
    pub(crate) fn run_strikes(&mut self, dt: f32, hi: f32, count: u32, bound: f32, inner: &mut f64) {
        let floor = self.header().ccd_min_dt.max(hi / 8192.0);
        let (raw, damping) = (self.header().contact_hertz, self.header().contact_damping);
        let stiff = |h: f32| soft(if raw * h > 0.25 { 0.25 / h } else { raw }, damping, h);
        let (mut pieces, mut striking, mut last) = (0u32, false, hi);
        let mut step_left = dt;
        for substep in 0..count {
            let mut left = hi;
            loop {
                let piece = if pieces >= STRIKE_PIECES { left } else { self.strike_piece(left, bound, floor, dt) };
                if piece < left && !striking {
                    striking = true;
                    // Friction patches are grouped once a step from the step's points; a piece's points stand alone.
                    for i in self.window.pairs.0..self.window.pairs.1 {
                        let row = self.uu(SOLVE_PAIRS, i);
                        self.set_u(PAIR_PATCH_NEXT, row as usize, row);
                        self.set_u(PAIR_PATCH_TAIL, row as usize, 1);
                    }
                }
                if striking {
                    // A carried impulse scales down to a shorter piece and is kept whole going longer, as between substep levels
                    // (tilt.rs, `scale_of`): the part a passing strike left does not grow with the piece.
                    let ratio = if piece < last { piece / last } else { 1.0 };
                    for i in self.window.pairs.0..self.window.pairs.1 {
                        let row = self.uu(SOLVE_PAIRS, i) as usize;
                        self.refresh_pair(row, step_left, ratio);
                        let (a, b) = self.pair_bodies(row as u32);
                        self.prepare_rows(row, a, b);
                    }
                }
                let stiffness = if piece == hi { stiff(hi) } else { stiff(piece) };
                self.run_substep(piece, substep, count, stiffness, inner, true);
                pieces += 1;
                last = piece;
                step_left -= piece;
                if piece >= left {
                    break;
                }
                left -= piece;
            }
        }
        self.window.kin = None;
        // What the island carries to the next step was made over its last piece, and is kept whole going longer, as above.
    }
}
