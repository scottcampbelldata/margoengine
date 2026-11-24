// A particle pinned to a rigid body: the particle is held to a point fixed in the body, and the body takes the reaction at
// that point (a point-to-point link, as a rigid-body joint of zero length). The link is one of the constraints of the exact
// solve in src/rigid.rs, where the body is a heavy particle at the end of whatever the particle hangs from.
use crate::world::World;

impl World {
    /// Makes room for this many attachments.
    pub fn reserve_attachments(&mut self, n: usize) {
        self.at_p.resize(n);
        self.at_row.resize(n);
        self.at_rx.resize(n);
        self.at_ry.resize(n);
        self.at_rz.resize(n);
    }
}
