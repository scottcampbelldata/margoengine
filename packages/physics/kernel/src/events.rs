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
    fn contact_modify(row: u32);
}

/// What a pair's filter may answer: leave it out, solve it, or find its contacts and fire its events without forces.
pub const PAIR_SKIP: u32 = 0;
pub const PAIR_SOLVE: u32 = 1;
pub const PAIR_EVENTS_ONLY: u32 = 2;

/// True when two packed groups meet: each one's memberships, the high 16 bits, are in the other's filter, the low 16.
#[inline(always)]
pub fn groups_meet(a: u32, b: u32) -> bool {
    (a >> 16) & b != 0 && (b >> 16) & a != 0
}

/// The 32-bit memberships and filter of a packed word, and its upper halves when `wide` (see COLLIDER_GROUPS_HI). A packed
/// word that is not wide holds Rapier's JavaScript 16 + 16 bits, and all ones in it means every one of the 32 groups.
#[inline(always)]
pub fn wide_groups(packed: u32, hi: u32, wide: bool) -> (u32, u32) {
    if wide {
        ((packed >> 16) | (hi & 0xffff_0000), (packed & 0xffff) | ((hi & 0xffff) << 16))
    } else if packed == u32::MAX {
        (u32::MAX, u32::MAX)
    } else {
        (packed >> 16, packed & 0xffff)
    }
}

/// Rapier's `InteractionGroups::test`: `Or` only when both sides ask for it, in place of `And`.
#[inline(always)]
pub fn wide_meet(a: (u32, u32), b: (u32, u32), both_or: bool) -> bool {
    let (one, other) = (a.0 & b.1 != 0, b.0 & a.1 != 0);
    if both_or { one || other } else { one && other }
}

impl World {
    /// Whether two colliders' collision groups (`solver` false) or solver groups meet, with 32-bit groups and Rapier's test mode.
    #[inline]
    pub fn colliders_meet(&self, a: usize, b: usize, solver: bool) -> bool {
        let (packed, hi, or, wide) = if solver {
            (COLLIDER_SOLVER_GROUPS, COLLIDER_SOLVER_GROUPS_HI, COLLIDER_SOLVER_OR, COLLIDER_SOLVER_WIDE)
        } else {
            (COLLIDER_GROUPS, COLLIDER_GROUPS_HI, COLLIDER_GROUPS_OR, COLLIDER_GROUPS_WIDE)
        };
        let (flags_a, flags_b) = (self.uu(COLLIDER_FLAGS, a), self.uu(COLLIDER_FLAGS, b));
        wide_meet(
            wide_groups(self.uu(packed, a), self.uu(hi, a), flags_a & wide != 0),
            wide_groups(self.uu(packed, b), self.uu(hi, b), flags_b & wide != 0),
            flags_a & flags_b & or != 0,
        )
    }

    /// The kind of body pair, as the bit `COLLIDER_TYPES` names it.
    #[inline]
    fn pair_type(&self, body_a: usize, body_b: usize) -> u32 {
        let rank = |body: usize| match self.flags(body) & KIND {
            DYNAMIC => 0,
            FIXED => 2,
            _ => 1,
        };
        let (a, b) = (rank(body_a), rank(body_b));
        1 << (match (if a < b { a } else { b }, if a < b { b } else { a }) {
            (0, 0) => 0,
            (0, 1) => 1,
            (0, 2) => 2,
            (1, 1) => 3,
            (1, 2) => 4,
            _ => 5,
        })
    }

    /// Whether both colliders take part in the kind of body pair they make (see `COLLIDER_TYPES`).
    #[inline]
    pub fn types_allow(&self, a: usize, b: usize, body_a: usize, body_b: usize) -> bool {
        let kind = self.pair_type(body_a, body_b);
        let wants = |c: usize| ((self.uu(COLLIDER_FLAGS, c) & COLLIDER_TYPES) >> COLLIDER_TYPES_SHIFT ^ TYPES_DEFAULT) & kind != 0;
        wants(a) && wants(b)
    }

    /// True when a pair may touch: neither side is off, the groups meet, no joint keeps them apart, and the filter agrees.
    /// Whether the world's pair filter is asked about a pair: one of its two colliders has not turned the question off.
    #[inline]
    fn asks_filter(&self, a: usize, b: usize) -> bool {
        let (fa, fb) = (self.uu(COLLIDER_FLAGS, a), self.uu(COLLIDER_FLAGS, b));
        let off = if (fa | fb) & COLLIDER_SENSOR != 0 { COLLIDER_NO_INTERSECTION_FILTER } else { COLLIDER_NO_CONTACT_FILTER };
        fa & off == 0 || fb & off == 0
    }

    /// What may become of a pair: `PAIR_SKIP` (neither side is off, the groups meet, no joint keeps them apart and the filter
    /// agrees fail one of those), `PAIR_SOLVE` (it may touch and its contacts are solved) or `PAIR_EVENTS_ONLY` (it may touch,
    /// its contacts are found and its events fire, but nothing pushes: the filter answered 2, as Rapier's hook answering
    /// with no solver flags). The filter comes last, as it leaves Wasm.
    #[inline]
    pub fn touch_verdict(&self, a: usize, b: usize, body_a: usize, body_b: usize) -> u32 {
        let base = (self.uu(COLLIDER_FLAGS, a) | self.uu(COLLIDER_FLAGS, b)) & COLLIDER_OFF == 0
            && (self.flags(body_a) | self.flags(body_b)) & DISABLED == 0
            && self.colliders_meet(a, b, false)
            && !self.joined(body_a, body_b)
            && !self.apart_in_tree(body_a, body_b);
        if !base {
            return PAIR_SKIP;
        }
        if self.header().filtering == 0 || !self.asks_filter(a, b) {
            return PAIR_SOLVE;
        }
        self.filter_says(a as u32, b as u32)
    }

    /// True when both bodies are in one multibody whose self contacts are off.
    #[inline]
    fn apart_in_tree(&self, a: usize, b: usize) -> bool {
        if self.uu(MB_ROLE, a) == 0 || self.uu(MB_ROLE, b) == 0 {
            return false;
        }
        let root = self.uu(MB_ROOT, a);
        root == self.uu(MB_ROOT, b) && self.uu(MB_NO_SELF, root as usize) != 0
    }

    /// Whether a pair may touch at all, solved or not.
    #[inline]
    pub fn may_touch(&self, a: usize, b: usize, body_a: usize, body_b: usize) -> bool {
        self.touch_verdict(a, b, body_a, body_b) != PAIR_SKIP
    }

    /// Shows a pair to the contact modifier, which may change its friction, bounce and normal in the pair's columns, or clear
    /// its contacts.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn modify_contacts(&mut self, row: usize) {
        unsafe { contact_modify(row as u32) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn modify_contacts(&mut self, row: usize) {
        if let Some(modifier) = self.modifier {
            modifier(self, row);
        }
    }

    #[cfg(target_arch = "wasm32")]
    #[inline(always)]
    fn filter_says(&self, a: u32, b: u32) -> u32 {
        unsafe { contact_filter(a, b).min(PAIR_EVENTS_ONLY) }
    }
    #[cfg(not(target_arch = "wasm32"))]
    fn filter_says(&self, a: u32, b: u32) -> u32 {
        match self.filter {
            Some(filter) if !filter(a, b) => PAIR_SKIP,
            _ => PAIR_SOLVE,
        }
    }

    /// Tells a crossing of a sensor that began and ended inside one step, with no pair row: a start and an end.
    pub(crate) fn push_crossing(&mut self, a: usize, b: usize) {
        for started in [true, false] {
            let at = 2 * self.header().events as usize;
            if at + 2 > 4 * self.header().capacity[3] as usize {
                return;
            }
            self.set_u(EVENTS, at, a as u32 | if started { EVENT_STARTED } else { 0 } | EVENT_SENSOR);
            self.set_u(EVENTS, at + 1, b as u32);
            self.header_mut().events += 1;
        }
    }

    /// Lists an event: two words, the first collider with what happened in its top bits, then the second. The list holds two
    /// events a pair row, which is all a step can make while whoever reads it clears it after each step: one end for a row
    /// that leaves and one event for the pair that takes its place.
    fn push_event(&mut self, row: usize, started: bool, removed: bool) {
        let at = 2 * self.header().events as usize;
        if at + 2 > 4 * self.header().capacity[3] as usize {
            return;
        }
        let (a, b) = (self.uu(PAIR_A, row), self.uu(PAIR_B, row));
        let sensor = (self.uu(COLLIDER_FLAGS, a as usize) | self.uu(COLLIDER_FLAGS, b as usize)) & COLLIDER_SENSOR != 0;
        self.set_u(EVENTS, at, a | if started { EVENT_STARTED } else { 0 } | if sensor { EVENT_SENSOR } else { 0 });
        self.set_u(EVENTS, at + 1, b | if removed { EVENT_REMOVED } else { 0 });
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
                self.push_event(row, now, false);
            }
        }
    }

    /// A pair leaves the broad phase: it ends if it touched. A pair of a removed collider ended already, when it was removed.
    pub fn pair_ended(&mut self, row: usize) {
        if self.uu(PAIR_FLAGS, row) & PAIR_TOUCHING != 0 {
            let (a, b) = (self.uu(PAIR_A, row) as usize, self.uu(PAIR_B, row) as usize);
            if (self.uu(COLLIDER_STATE, a) | self.uu(COLLIDER_STATE, b)) & REMOVED == 0 {
                self.push_event(row, false, false);
            }
        }
    }

    /// Everything a collider touches ends now, and wakes: what rested on it has to find out.
    pub(crate) fn end_touches(&mut self, collider: u32) {
        self.end_touches_as(collider, false);
    }

    /// Ends what a collider touches, and says so with a stopped event: `removed` marks the stop as the collider's leaving
    /// the world, as Rapier's `CollisionEventFlags::REMOVED` does.
    pub(crate) fn end_touches_as(&mut self, collider: u32, removed: bool) {
        let mut pair = self.uu(COLLIDER_PAIRS, collider as usize);
        while pair != NONE {
            let row = pair as usize;
            let flags = self.uu(PAIR_FLAGS, row);
            if flags & PAIR_TOUCHING != 0 {
                self.push_event(row, false, removed);
            }
            self.set_u(PAIR_FLAGS, row, flags & !(PAIR_TOUCHING | PAIR_OVERLAP));
            // A pair whose other collider was retired keeps its contacts for the step that drops it, and names no body there.
            if !self.pair_retired(pair) {
                let (a, b) = self.pair_bodies(pair);
                self.drop_contacts(row, a, b);
            }
            self.wake_pair(pair);
            pair = self.next_pair(pair, collider);
        }
    }

    /// True for a pair one of whose colliders has left its body: `retire_collider` takes the body's name at once and the next
    /// step drops the pair, so until then the pair names no body on that side.
    #[inline(always)]
    fn pair_retired(&self, pair: u32) -> bool {
        let (a, b) = self.pair_bodies(pair);
        a == NONE as usize || b == NONE as usize
    }

    /// Wakes a pair's bodies. A retired collider has none: waking row NONE read and wrote past the body rows, an access
    /// violation natively and the word before the column in Wasm, where the address wraps (KB-PHYS-RETIREDPAIR1).
    #[inline(always)]
    fn wake_pair(&mut self, pair: u32) {
        let (a, b) = self.pair_bodies(pair);
        for body in [a, b] {
            if body != NONE as usize {
                self.wake(body as u32);
            }
        }
    }

    /// A collider is leaving: each pair that touched says so with a stop marked as a removal, and wakes its bodies, as
    /// Rapier wakes the bodies of a contact pair it removes. The pair's contacts stay for the step that drops it.
    pub(crate) fn remove_touches(&mut self, collider: u32) {
        let mut pair = self.uu(COLLIDER_PAIRS, collider as usize);
        while pair != NONE {
            let row = pair as usize;
            let flags = self.uu(PAIR_FLAGS, row);
            if flags & PAIR_TOUCHING != 0 {
                self.push_event(row, false, true);
                self.set_u(PAIR_FLAGS, row, flags & !PAIR_TOUCHING);
                self.wake_pair(pair);
            }
            pair = self.next_pair(pair, collider);
        }
    }

    /// Wakes the bodies of every pair a collider touches in: what rests on a collider that goes falls, as Rapier wakes
    /// the bodies of a contact pair it removes.
    pub fn wake_touching_pairs(&mut self, collider: u32) {
        let mut pair = self.uu(COLLIDER_PAIRS, collider as usize);
        while pair != NONE {
            if self.uu(PAIR_FLAGS, pair as usize) & PAIR_TOUCHING != 0 {
                self.wake_pair(pair);
            }
            pair = self.next_pair(pair, collider);
        }
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
        let before = self.uu(COLLIDER_FLAGS, at);
        if before != state {
            self.end_touches(collider);
            self.set_u(COLLIDER_FLAGS, at, state);
            // A kind of pair newly wanted may need pairs the broad phase never made (two fixed bodies'), and its boxes
            // may already overlap, which only a walk of the others finds.
            if (before ^ state) & COLLIDER_TYPES != 0 && self.uu(COLLIDER_STATE, at) & IN_BROAD != 0 {
                for other in 0..self.header().collider_rows as usize {
                    if other != at && self.uu(COLLIDER_STATE, other) & (IN_BROAD | REMOVED) == IN_BROAD && self.boxes_overlap(at, other) {
                        self.add_pair(collider, other as u32);
                    }
                }
            }
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
                // A retired collider's pair is the next step's to drop: it joins no list.
                if self.pair_retired(pair) {
                    pair = self.next_pair(pair, collider);
                    continue;
                }
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
