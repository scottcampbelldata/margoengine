// What a step tells the world outside: pairs that began or stopped touching. And what decides whether a pair may touch at
// all: sensors, groups, the filter, dominance, and colliders and bodies that are switched off.
//
// A pair remembers in PAIR_TOUCHING whether it touched at the end of the last step it was looked at. A step's last act is to
// compare that with what it found, so a pair of sleepers, which no step looks at, keeps what it had and says nothing.
use crate::layout::*;
use crate::world::{NONE, World};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn contact_filter(a: u32, b: u32) -> u32;
}

/// True when two packed groups meet: each one's memberships, the high 16 bits, are in the other's filter, the low 16.
#[inline(always)]
pub fn groups_meet(a: u32, b: u32) -> bool {
    (a >> 16) & b != 0 && (b >> 16) & a != 0
}

impl World {
    /// True when a pair may touch: neither side is off, the groups meet, no joint keeps them apart, and the filter agrees.
    /// The filter comes last, as it leaves Wasm.
    #[inline]
    pub fn may_touch(&self, a: usize, b: usize, body_a: usize, body_b: usize) -> bool {
        (self.uu(COLLIDER_FLAGS, a) | self.uu(COLLIDER_FLAGS, b)) & COLLIDER_OFF == 0
            && (self.flags(body_a) | self.flags(body_b)) & DISABLED == 0
            && groups_meet(self.uu(COLLIDER_GROUPS, a), self.uu(COLLIDER_GROUPS, b))
            && !self.joined(body_a, body_b)
            && (self.header().filtering == 0 || self.filter_says(a as u32, b as u32))
    }

    #[cfg(target_arch = "wasm32")]
    #[inline(always)]
    fn filter_says(&self, a: u32, b: u32) -> bool {
        unsafe { contact_filter(a, b) != 0 }
    }
    #[cfg(not(target_arch = "wasm32"))]
    fn filter_says(&self, a: u32, b: u32) -> bool {
        self.filter.is_none_or(|filter| filter(a, b))
    }

    /// Lists an event: two words, the first collider with what happened in its top bits, then the second. The list holds two
    /// events a pair row, which is all a step can make while whoever reads it clears it after each step: one end for a row
    /// that leaves and one event for the pair that takes its place.
    fn push_event(&mut self, row: usize, started: bool) {
        let at = 2 * self.header().events as usize;
        if at + 2 > 4 * self.header().capacity[3] as usize {
            return;
        }
        let (a, b) = (self.uu(PAIR_A, row), self.uu(PAIR_B, row));
        let sensor = (self.uu(COLLIDER_FLAGS, a as usize) | self.uu(COLLIDER_FLAGS, b as usize)) & COLLIDER_SENSOR != 0;
        self.set_u(EVENTS, at, a | if started { EVENT_STARTED } else { 0 } | if sensor { EVENT_SENSOR } else { 0 });
        self.set_u(EVENTS, at + 1, b);
        self.header_mut().events += 1;
    }

    /// A step's last act: every pair it looked at says whether it began or stopped touching.
    pub fn gather_events(&mut self) {
        for i in 0..self.header().active_pairs as usize {
            let row = self.uu(ACTIVE_PAIRS, i) as usize;
            let flags = self.uu(PAIR_FLAGS, row);
            if flags & PAIR_IS_PART != 0 {
                continue;
            }
            let mut now = flags & PAIR_OVERLAP != 0;
            // A mesh pair speaks for its parts.
            let mut part = row as u32;
            while part != NONE {
                let p = part as usize;
                for k in 0..self.uu(PAIR_CONTACTS, p) as usize {
                    let at = p * MANIFOLD + k;
                    now = now || self.s(CONTACT_SEPARATION, at) <= 0.0 || self.s(CONTACT_NORMAL_IMPULSE, at) > 0.0;
                }
                part = self.uu(PAIR_CHILD, p);
            }
            if now != (flags & PAIR_TOUCHING != 0) {
                self.set_u(PAIR_FLAGS, row, flags ^ PAIR_TOUCHING);
                self.push_event(row, now);
            }
        }
    }

    /// A pair leaves the broad phase: it ends if it touched. A pair of a removed collider says nothing, as JS has let go of it.
    pub fn pair_ended(&mut self, row: usize) {
        if self.uu(PAIR_FLAGS, row) & PAIR_TOUCHING != 0 {
            let (a, b) = (self.uu(PAIR_A, row) as usize, self.uu(PAIR_B, row) as usize);
            if (self.uu(COLLIDER_STATE, a) | self.uu(COLLIDER_STATE, b)) & REMOVED == 0 {
                self.push_event(row, false);
            }
        }
    }

    /// Everything a collider touches ends now, and wakes: what rested on it has to find out.
    fn end_touches(&mut self, collider: u32) {
        let mut pair = self.uu(COLLIDER_PAIRS, collider as usize);
        while pair != NONE {
            let row = pair as usize;
            let flags = self.uu(PAIR_FLAGS, row);
            if flags & PAIR_TOUCHING != 0 {
                self.push_event(row, false);
            }
            self.set_u(PAIR_FLAGS, row, flags & !(PAIR_TOUCHING | PAIR_OVERLAP));
            let (a, b) = self.pair_bodies(pair);
            self.drop_contacts(row, a, b);
            self.wake_pair(pair);
            pair = self.next_pair(pair, collider);
        }
    }

    #[inline(always)]
    fn wake_pair(&mut self, pair: u32) {
        let (a, b) = self.pair_bodies(pair);
        self.wake(a as u32);
        self.wake(b as u32);
    }

    /// Wakes what a collider's box reaches, after its groups changed: the next step sees them with the new groups.
    pub fn touch_collider(&mut self, collider: u32) {
        let mut pair = self.uu(COLLIDER_PAIRS, collider as usize);
        while pair != NONE {
            self.wake_pair(pair);
            pair = self.next_pair(pair, collider);
        }
    }

    /// Makes a collider a sensor, or switches it off, or back: what it touched ends as what it was.
    pub fn set_collider_state(&mut self, collider: u32, state: u32) {
        let at = collider as usize;
        if self.uu(COLLIDER_FLAGS, at) != state {
            self.end_touches(collider);
            self.set_u(COLLIDER_FLAGS, at, state);
            self.touch_collider(collider);
            self.wake(self.uu(COLLIDER_BODY, at));
        }
    }

    /// Takes a body out of the world or puts it back. Out, it keeps its pose and speed, moves no one, feels nothing, and its
    /// joints rest; it touches nothing and what touched it ends. Back, it starts awake.
    pub fn set_body_enabled(&mut self, body: u32, enabled: bool) {
        let at = body as usize;
        if !self.body_alive(body) || (self.flags(at) & DISABLED == 0) == enabled {
            return;
        }
        if !enabled {
            self.wake(body);
        }
        let mut collider = self.uu(FIRST_COLLIDER, at);
        while collider != NONE {
            if enabled {
                self.touch_collider(collider);
            } else {
                self.end_touches(collider);
            }
            collider = self.uu(COLLIDER_NEXT, collider as usize);
        }
        self.set_u(FLAGS, at, self.flags(at) ^ DISABLED);
        let mut joint = self.uu(FIRST_JOINT, at);
        while joint != NONE {
            let row = joint as usize;
            let on_a = self.uu(JOINT_A, row) as usize == at;
            let other = self.uu(if on_a { JOINT_B } else { JOINT_A }, row);
            let off = !enabled || self.flags(other as usize) & DISABLED != 0;
            let flags = self.uu(JOINT_FLAGS, row);
            self.set_u(JOINT_FLAGS, row, if off { flags | JOINT_OFF } else { flags & !JOINT_OFF });
            self.wake(other);
            joint = self.uu(if on_a { JOINT_NEXT_A } else { JOINT_NEXT_B }, row);
        }
        if self.flags(at) & KIND == FIXED {
            return;
        }
        if enabled {
            self.set_s(SLEEP_TIME, at, 0.0);
            self.list_awake(body);
        } else {
            self.unlist_awake(body);
        }
        let mut collider = self.uu(FIRST_COLLIDER, at);
        while collider != NONE {
            let mut pair = self.uu(COLLIDER_PAIRS, collider as usize);
            while pair != NONE {
                let (a, b) = self.pair_bodies(pair);
                if self.is_awake(a) || self.is_awake(b) {
                    self.activate_pair(pair);
                } else {
                    self.deactivate_pair(pair);
                }
                pair = self.next_pair(pair, collider);
            }
            collider = self.uu(COLLIDER_NEXT, collider as usize);
        }
    }
}
