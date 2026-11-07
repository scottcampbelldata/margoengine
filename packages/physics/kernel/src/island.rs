// Islands and sleeping. An island is a contact group (Erleben 2005, chapter 5): the connected bodies of the contact graph,
// found once a step by union-find. Fixed bodies, and kinematic ones as scripted bodies, are insulators: they join no
// island, so two piles on one floor stay apart. The forest links by size and halves paths (Tarjan 1975, as stated by
// Jayanti and Tarjan 2020).
//
// A body is ready to sleep (Erleben 2005, section 6.5) when its kinetic energy per unit of mass stays under a threshold
// for a window of time, and has not risen across that window, so a body that gathers speed slowly stays awake. An island
// sleeps when all its bodies are ready. A sleeping island is a ring of bodies: waking any one wakes the ring in time
// proportional to its size, and until then it is on no list a step walks, so sleepers cost nothing.
//
// Two bodies touch when their pair holds contact points. Those reach a little past the surfaces, as far as a step can go.
use crate::layout::*;
use crate::math::*;
use crate::world::{NONE, World};

/// Energy this small a part of the threshold is a solver's rounding, not a body gathering speed: a body that touches others
/// always has some, and must still be able to sleep.
const NOISE: f32 = 1e-6;

impl World {
    /// A pair's contacts go: each body counts its stillness again. A body that cannot sleep keeps its island awake, so what rests
    /// on it can be long past its time to sleep, and with its support gone it would sleep in mid air at the next look.
    pub fn drop_contacts(&mut self, row: usize, a: usize, b: usize) {
        if self.uu(PAIR_CONTACTS, row) != 0 {
            self.set_u(PAIR_CONTACTS, row, 0);
            self.set_s(SLEEP_TIME, a, 0.0);
            self.set_s(SLEEP_TIME, b, 0.0);
        }
    }

    /// A pair leaves the broad phase, with a body that may already be gone.
    pub fn pair_leaves(&mut self, row: usize) {
        if self.uu(PAIR_CONTACTS, row) != 0 {
            for collider in [self.uu(PAIR_A, row), self.uu(PAIR_B, row)] {
                let body = self.uu(COLLIDER_BODY, collider as usize);
                if body != NONE {
                    self.set_s(SLEEP_TIME, body as usize, 0.0);
                }
            }
        }
    }

    /// True when `body` is on the awake list.
    #[inline(always)]
    pub fn is_awake(&self, body: usize) -> bool {
        self.uu(AWAKE_SLOT, body) != NONE
    }

    /// Puts a body on the awake list.
    pub fn list_awake(&mut self, body: u32) {
        let slot = self.header().awake;
        self.set_u(AWAKE, slot as usize, body);
        self.set_u(AWAKE_SLOT, body as usize, slot);
        self.header_mut().awake = slot + 1;
    }

    /// Takes a body off the awake list; the last one takes its slot.
    pub fn unlist_awake(&mut self, body: u32) {
        let slot = self.uu(AWAKE_SLOT, body as usize);
        let last = self.header().awake - 1;
        let moved = self.uu(AWAKE, last as usize);
        self.set_u(AWAKE, slot as usize, moved);
        self.set_u(AWAKE_SLOT, moved as usize, slot);
        self.set_u(AWAKE_SLOT, body as usize, NONE);
        self.header_mut().awake = last;
    }

    /// Puts a pair on the list of pairs a step looks at.
    pub fn activate_pair(&mut self, row: u32) {
        if self.uu(PAIR_SLOT, row as usize) == NONE {
            let slot = self.header().active_pairs;
            self.set_u(ACTIVE_PAIRS, slot as usize, row);
            self.set_u(PAIR_SLOT, row as usize, slot);
            self.header_mut().active_pairs = slot + 1;
        }
    }

    /// Takes a pair off that list; the last one takes its slot.
    pub fn deactivate_pair(&mut self, row: u32) {
        let slot = self.uu(PAIR_SLOT, row as usize);
        if slot != NONE {
            let last = self.header().active_pairs - 1;
            let moved = self.uu(ACTIVE_PAIRS, last as usize);
            self.set_u(ACTIVE_PAIRS, slot as usize, moved);
            self.set_u(PAIR_SLOT, moved as usize, slot);
            self.set_u(PAIR_SLOT, row as usize, NONE);
            self.header_mut().active_pairs = last;
        }
    }

    /// The two bodies of a pair.
    #[inline(always)]
    pub fn pair_bodies(&self, row: u32) -> (usize, usize) {
        let at = row as usize;
        (self.uu(COLLIDER_BODY, self.uu(PAIR_A, at) as usize) as usize, self.uu(COLLIDER_BODY, self.uu(PAIR_B, at) as usize) as usize)
    }

    /// True when a pair's bodies touch.
    #[inline(always)]
    fn touching(&self, row: u32) -> bool {
        self.uu(PAIR_CONTACTS, row as usize) != 0
    }

    /// Wakes a sleeping body and the whole ring it sleeps in; does nothing to one that is awake.
    pub fn wake(&mut self, body: u32) {
        if self.flags(body as usize) & SLEEPING == 0 {
            return;
        }
        let first = self.header().awake;
        let mut at = body;
        loop {
            let row = at as usize;
            let next = self.uu(ISLAND_NEXT, row);
            self.set_u(ISLAND_NEXT, row, NONE);
            self.set_u(FLAGS, row, self.flags(row) & !SLEEPING);
            self.set_s(SLEEP_TIME, row, 0.0);
            self.set_s(SLEEP_ENERGY, row, 0.0);
            self.list_awake(at);
            at = next;
            if at == body {
                break;
            }
        }
        for slot in first..self.header().awake {
            let mut collider = self.uu(FIRST_COLLIDER, self.uu(AWAKE, slot as usize) as usize);
            while collider != NONE {
                let mut pair = self.uu(COLLIDER_PAIRS, collider as usize);
                while pair != NONE {
                    self.activate_pair(pair);
                    pair = self.next_pair(pair, collider);
                }
                collider = self.uu(COLLIDER_NEXT, collider as usize);
            }
        }
    }

    /// Asks a body to sleep: it counts as ready at once, so it sleeps with its island at the next step where all are ready.
    pub fn request_sleep(&mut self, body: u32) {
        let at = body as usize;
        let flags = self.flags(at);
        if flags & SLEEPING == 0 && flags & KIND == DYNAMIC {
            self.set_v(LINEAR_X, at, v3(0.0, 0.0, 0.0));
            self.set_v(ANGULAR_X, at, v3(0.0, 0.0, 0.0));
            self.set_s(SLEEP_TIME, at, self.header().sleep_time);
            self.set_s(SLEEP_ENERGY, at, 0.0);
        }
    }

    /// Kinetic energy per unit of mass, which weighs linear and turning motion in one number (Erleben 2005, 6.5).
    fn energy(&self, at: usize) -> f32 {
        let linear = self.v(LINEAR_X, at);
        let angular = self.v(ANGULAR_X, at);
        let inverse_mass = self.s(INVERSE_MASS, at);
        if inverse_mass == 0.0 {
            return 0.5 * (linear.dot(linear) + angular.dot(angular));
        }
        let local = self.q(ROTATION_X, at).mul(self.q(INERTIA_FRAME_X, at)).unrotate(angular);
        0.5 * (linear.dot(linear) + local.dot(self.v(INERTIA_X, at).mul(local)) * inverse_mass)
    }

    /// Runs a body's sleep timer over `dt`, and says whether the body is ready.
    fn tick(&mut self, at: usize, dt: f32) -> bool {
        let energy = self.energy(at);
        let (threshold, window) = (self.header().sleep_energy, self.header().sleep_time);
        let pushed = {
            let (force, torque) = (self.v(FORCE_X, at), self.v(TORQUE_X, at));
            force.dot(force) + torque.dot(torque) > 0.0
        };
        if self.flags(at) & CAN_SLEEP == 0 || energy > threshold || pushed {
            self.set_s(SLEEP_TIME, at, 0.0);
            self.set_s(SLEEP_ENERGY, at, energy);
            return false;
        }
        let time = self.s(SLEEP_TIME, at) + dt;
        if time < window {
            self.set_s(SLEEP_TIME, at, time);
            return false;
        }
        if energy > self.s(SLEEP_ENERGY, at) && energy > threshold * NOISE {
            // It gained energy across the window, however slowly: a new window starts from here.
            self.set_s(SLEEP_TIME, at, 0.0);
            self.set_s(SLEEP_ENERGY, at, energy);
            return false;
        }
        self.set_s(SLEEP_TIME, at, time);
        true
    }

    /// The root of a body's tree, halving the path on the way.
    #[inline(always)]
    fn find(&mut self, body: u32) -> u32 {
        let mut x = body;
        loop {
            let parent = self.uu(ISLAND_PARENT, x as usize);
            if parent == x {
                return x;
            }
            let grandparent = self.uu(ISLAND_PARENT, parent as usize);
            self.set_u(ISLAND_PARENT, x as usize, grandparent);
            x = grandparent;
        }
    }

    /// Joins two trees, the smaller under the larger; at equal sizes the first root stays.
    #[inline(always)]
    pub fn unite(&mut self, a: u32, b: u32) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            let (size_a, size_b) = (self.uu(ISLAND_SIZE, a as usize), self.uu(ISLAND_SIZE, b as usize));
            let (root, child) = if size_b > size_a { (b, a) } else { (a, b) };
            self.set_u(ISLAND_PARENT, child as usize, root);
            self.set_u(ISLAND_SIZE, root as usize, size_a + size_b);
        }
    }

    /// Wakes what a moving body touches, finds the islands, and puts to sleep those that are ready. Islands come out in the
    /// order of their first body on the awake list, a pure function of the calls made. Island k holds the ISLAND_COUNT[k]
    /// bodies from ISLAND_START[k] in ISLAND_BODIES, and ISLAND_ID gives each awake dynamic body its island.
    pub fn update_islands(&mut self, dt: f32) {
        // A body that moves wakes what it touches. Waking adds pairs at the end, so the walk reaches those too.
        let mut i = 0;
        while i < self.header().active_pairs as usize {
            let row = self.uu(ACTIVE_PAIRS, i);
            i += 1;
            if self.touching(row) {
                let (a, b) = self.pair_bodies(row);
                let (sleeping_a, sleeping_b) = (self.flags(a) & SLEEPING != 0, self.flags(b) & SLEEPING != 0);
                if sleeping_a && !sleeping_b && self.disturbs(b) {
                    self.wake(a as u32);
                } else if sleeping_b && !sleeping_a && self.disturbs(a) {
                    self.wake(b as u32);
                }
            }
        }
        self.wake_across_joints();
        let awake = self.header().awake as usize;
        for i in 0..awake {
            let body = self.uu(AWAKE, i);
            self.set_u(ISLAND_PARENT, body as usize, body);
            self.set_u(ISLAND_SIZE, body as usize, 1);
            self.set_u(ISLAND_ID, body as usize, NONE);
        }
        for i in 0..self.header().active_pairs as usize {
            let row = self.uu(ACTIVE_PAIRS, i);
            if self.touching(row) {
                let (a, b) = self.pair_bodies(row);
                let (kind_a, kind_b) = (self.flags(a) & KIND, self.flags(b) & KIND);
                if kind_a == DYNAMIC && kind_b == DYNAMIC {
                    self.unite(a as u32, b as u32);
                } else if kind_b == DYNAMIC && self.moving_kinematic(a) {
                    self.set_s(SLEEP_TIME, b, 0.0);
                } else if kind_a == DYNAMIC && self.moving_kinematic(b) {
                    self.set_s(SLEEP_TIME, a, 0.0);
                }
            }
        }
        self.unite_joints();
        // Number the islands, count their bodies, and see whether all of each are ready. A root holds its island's number.
        let mut islands = 0usize;
        for i in 0..awake {
            let body = self.uu(AWAKE, i);
            if self.flags(body as usize) & KIND != DYNAMIC {
                continue;
            }
            let root = self.find(body) as usize;
            let mut id = self.uu(ISLAND_ID, root);
            if id == NONE {
                id = islands as u32;
                islands += 1;
                self.set_u(ISLAND_ID, root, id);
                self.set_u(ISLAND_COUNT, id as usize, 0);
                self.set_u(ISLAND_READY, id as usize, 1);
            }
            self.set_u(ISLAND_ID, body as usize, id);
            self.set_u(ISLAND_COUNT, id as usize, self.uu(ISLAND_COUNT, id as usize) + 1);
            if !self.tick(body as usize, dt) {
                self.set_u(ISLAND_READY, id as usize, 0);
            }
        }
        // One run of ISLAND_BODIES each, in awake-list order. Filling leaves each start at its run's end.
        let mut start = 0;
        for id in 0..islands {
            self.set_u(ISLAND_START, id, start);
            start += self.uu(ISLAND_COUNT, id);
        }
        for i in 0..awake {
            let body = self.uu(AWAKE, i);
            if self.flags(body as usize) & KIND == DYNAMIC {
                let id = self.uu(ISLAND_ID, body as usize) as usize;
                let at = self.uu(ISLAND_START, id);
                self.set_u(ISLAND_BODIES, at as usize, body);
                self.set_u(ISLAND_START, id, at + 1);
            }
        }
        // Islands that are ready leave; the others move down and tell their bodies their new number.
        let mut kept = 0;
        for id in 0..islands {
            let count = self.uu(ISLAND_COUNT, id);
            let first = self.uu(ISLAND_START, id) - count;
            if self.uu(ISLAND_READY, id) != 0 {
                self.put_to_sleep(first as usize, count as usize);
            } else {
                self.set_u(ISLAND_START, kept, first);
                self.set_u(ISLAND_COUNT, kept, count);
                for at in first..first + count {
                    self.set_u(ISLAND_ID, self.uu(ISLAND_BODIES, at as usize) as usize, kept as u32);
                }
                kept += 1;
            }
        }
        self.header_mut().islands = kept as u32;
    }

    /// True when an awake body should wake a sleeper it touches: every dynamic one, and a kinematic one that moves.
    #[inline(always)]
    pub fn disturbs(&self, body: usize) -> bool {
        self.is_awake(body) && (self.flags(body) & KIND == DYNAMIC || self.moving_kinematic(body))
    }

    #[inline(always)]
    pub fn moving_kinematic(&self, body: usize) -> bool {
        let kind = self.flags(body) & KIND;
        if kind == FIXED || kind == DYNAMIC {
            return false;
        }
        let (linear, angular) = (self.v(LINEAR_X, body), self.v(ANGULAR_X, body));
        linear.dot(linear) + angular.dot(angular) > 0.0
    }

    /// Closes a run of ISLAND_BODIES into a ring and stops each body where it is. A sleeper's previous pose is its pose, so
    /// interpolation holds it still. Pairs that are left with no awake body go off the active list.
    fn put_to_sleep(&mut self, first: usize, count: usize) {
        for i in 0..count {
            let body = self.uu(ISLAND_BODIES, first + i);
            let row = body as usize;
            self.unlist_awake(body);
            self.set_u(ISLAND_NEXT, row, self.uu(ISLAND_BODIES, first + (i + 1) % count));
            self.set_u(FLAGS, row, self.flags(row) | SLEEPING);
            self.set_v(LINEAR_X, row, v3(0.0, 0.0, 0.0));
            self.set_v(ANGULAR_X, row, v3(0.0, 0.0, 0.0));
            self.set_v(PREVIOUS_X, row, self.v(POSITION_X, row));
            self.set_q(PREVIOUS_ROTATION_X, row, self.q(ROTATION_X, row));
        }
        for i in 0..count {
            let mut collider = self.uu(FIRST_COLLIDER, self.uu(ISLAND_BODIES, first + i) as usize);
            while collider != NONE {
                let mut pair = self.uu(COLLIDER_PAIRS, collider as usize);
                while pair != NONE {
                    let (a, b) = self.pair_bodies(pair);
                    if !self.is_awake(a) && !self.is_awake(b) {
                        self.deactivate_pair(pair);
                    }
                    pair = self.next_pair(pair, collider);
                }
                collider = self.uu(COLLIDER_NEXT, collider as usize);
            }
        }
    }
}
