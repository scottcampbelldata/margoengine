// Long range attachments (Kim, Chentanez and Mueller, "Long Range Attachments - A Method to Simulate Inextensible Clothing in
// Computer Games", SCA 2012): each free particle of a cloth hung from pinned particles is tied to one of them by a one-sided
// constraint, no farther from it than its rest distance through the cloth (the geodesic over the edges, worked out when the
// body is made). An edge solve passes a stretch down a hanging sheet one edge a pass, so a long sheet sags under its own
// weight until the passes catch up; the tether reaches the end at once. It moves only the free particle: the pinned one does
// not move, and a particle already inside its distance is left alone, so folds and slack stay free. A tear changes the paths
// through the cloth, so the tethers are worked out again when a body tears (soft.ts).
use crate::math::sqrt;
use crate::world::World;

impl World {
    /// One pass over the tethers: a particle farther from its pin than its length is put back on that sphere.
    pub fn solve_tethers(&mut self) {
        for t in 0..self.tethers {
            let (p, a) = (self.tt_p[t] as usize, self.tt_a[t] as usize);
            if !(self.w[p] > 0.0) || self.w[a] > 0.0 {
                continue;
            }
            let (dx, dy, dz) = (self.x[p] - self.x[a], self.y[p] - self.y[a], self.z[p] - self.z[a]);
            let squared = dx * dx + dy * dy + dz * dz;
            let length = self.tt_len[t];
            if !(squared > length * length) {
                continue;
            }
            let share = length / sqrt(squared);
            self.x[p] = self.x[a] + dx * share;
            self.y[p] = self.y[a] + dy * share;
            self.z[p] = self.z[a] + dz * share;
        }
    }
}
