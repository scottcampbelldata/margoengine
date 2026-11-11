//! Attribute order from the specification's depth-first and prediction-degree traversals.
use crate::{
    Budget, Error, Result,
    edgebreaker::{Mapping, NONE, Topology, next, prev},
};

#[derive(Clone, Copy, Default)]
pub(crate) struct Group {
    pub data_id: u8,
    pub corner: bool,
    pub degree: bool,
}
pub(crate) struct Sequence {
    pub entry_corner: Vec<usize>,
    pub vertex_entry: Vec<usize>,
    pub point_entry: Vec<usize>,
}
struct Walk<'a, 'b> {
    topo: &'a Topology<'b>,
    mapping: &'a Mapping,
    group: Group,
    faces: Vec<bool>,
    vertices: Vec<bool>,
    sequence: Sequence,
}
impl Walk<'_, '_> {
    fn corners(&self) -> &[usize] {
        if self.group.corner {
            &self.mapping.attributes[self.group.data_id as usize].corners
        } else {
            &self.topo.corners
        }
    }
    fn boundary(&self, v: usize) -> bool {
        if self.group.corner {
            self.mapping.attributes[self.group.data_id as usize].boundary[v]
        } else if self.group.data_id != 255 {
            let attr = &self.mapping.attributes[self.group.data_id as usize];
            let c = self.topo.vertex_corner[v];
            self.topo.hole[v] || attr.seam[next(c)] || attr.seam[prev(c)]
        } else {
            self.topo.hole[v]
        }
    }
    fn visited(&self, c: usize) -> bool {
        c == NONE || self.faces[c / 3]
    }
    fn side(&self, c: usize, right: bool) -> usize {
        if c == NONE {
            return NONE;
        }
        let edge = if right { next(c) } else { prev(c) };
        if self.group.corner && self.mapping.attributes[self.group.data_id as usize].seam[edge] {
            NONE
        } else {
            self.topo.opp(edge)
        }
    }
    fn visit(&mut self, c: usize) -> bool {
        let v = self.corners()[c];
        if self.vertices[v] {
            return false;
        }
        self.vertices[v] = true;
        self.sequence.vertex_entry[v] = self.sequence.entry_corner.len();
        self.sequence.entry_corner.push(c);
        true
    }
    #[inline(never)]
    fn depth_first(&mut self, budget: &mut Budget) -> Result<()> {
        let mut stack = budget.vector(self.faces.len(), 0_usize)?;
        stack.clear();
        for seed in (0..self.topo.corners.len()).step_by(3) {
            if self.visited(seed) {
                continue;
            }
            self.visit(next(seed));
            self.visit(prev(seed));
            stack.push(seed);
            while let Some(&start) = stack.last() {
                if self.visited(start) {
                    stack.pop();
                    continue;
                }
                let mut c = start;
                loop {
                    budget.steps(1)?;
                    if c == NONE || self.visited(c) {
                        return Err(Error::Invalid);
                    }
                    self.faces[c / 3] = true;
                    if self.visit(c) && !self.boundary(self.corners()[c]) {
                        c = self.side(c, true);
                        continue;
                    }
                    let r = self.side(c, true);
                    let l = self.side(c, false);
                    if self.visited(r) {
                        if self.visited(l) {
                            stack.pop();
                            break;
                        }
                        c = l;
                    } else if self.visited(l) {
                        c = r;
                    } else {
                        *stack.last_mut().ok_or(Error::Invalid)? = l;
                        stack.push(r);
                        break;
                    }
                }
            }
        }
        Ok(())
    }
    fn priority(&self, c: usize, degrees: &mut [usize]) -> usize {
        let v = self.corners()[c];
        if self.vertices[v] {
            0
        } else {
            degrees[v] += 1;
            if degrees[v] > 1 { 1 } else { 2 }
        }
    }
    #[inline(never)]
    fn degree(&mut self, budget: &mut Budget) -> Result<()> {
        let mut degrees = budget.vector(self.vertices.len(), 0_usize)?;
        let mut stacks = [Vec::new(), Vec::new(), Vec::new()];
        for s in &mut stacks {
            *s = budget.vector(self.faces.len(), 0_usize)?;
            s.clear();
        }
        for seed in (0..self.topo.corners.len()).step_by(3) {
            // Unlike depth-first traversal, the specification's prediction-
            // degree entry visits all three seed vertices before testing the
            // face. A previously visited cap can still have an unvisited tip.
            stacks[0].push(seed);
            let mut best = 0;
            self.visit(next(seed));
            self.visit(prev(seed));
            self.visit(seed);
            loop {
                let mut candidate = NONE;
                for (priority, stack) in stacks.iter_mut().enumerate().skip(best) {
                    if let Some(c) = stack.pop() {
                        candidate = c;
                        best = priority;
                        break;
                    }
                }
                if candidate == NONE {
                    break;
                }
                if self.visited(candidate) {
                    continue;
                }
                let mut c = candidate;
                loop {
                    budget.steps(1)?;
                    self.faces[c / 3] = true;
                    self.visit(c);
                    let r = self.side(c, true);
                    let l = self.side(c, false);
                    let rv = self.visited(r);
                    let lv = self.visited(l);
                    if !lv {
                        let p = self.priority(l, &mut degrees);
                        if rv && p <= best {
                            c = l;
                            continue;
                        }
                        stacks[p].push(l);
                        best = best.min(p);
                    }
                    if !rv {
                        let p = self.priority(r, &mut degrees);
                        if p <= best {
                            c = r;
                            continue;
                        }
                        stacks[p].push(r);
                        best = best.min(p);
                    }
                    break;
                }
            }
        }
        Ok(())
    }
}
pub(crate) fn sequence(
    topo: &Topology,
    mapping: &Mapping,
    group: Group,
    budget: &mut Budget,
) -> Result<Sequence> {
    if (group.corner && group.data_id == 255)
        || (group.data_id != 255 && group.data_id as usize >= mapping.attributes.len())
    {
        return Err(Error::Invalid);
    }
    let n = if group.corner {
        mapping.attributes[group.data_id as usize]
            .vertex_corner
            .len()
    } else {
        topo.vertex_corner.len()
    };
    let mut entries = budget.vector(n, 0_usize)?;
    entries.clear();
    let mut walk = Walk {
        topo,
        mapping,
        group,
        faces: budget.vector(topo.corners.len() / 3, false)?,
        vertices: budget.vector(n, false)?,
        sequence: Sequence {
            entry_corner: entries,
            vertex_entry: budget.vector(n, NONE)?,
            point_entry: budget.vector(mapping.points, NONE)?,
        },
    };
    if group.degree {
        walk.degree(budget)?;
    } else {
        walk.depth_first(budget)?;
    }
    for (c, &point) in mapping.corner_to_point.iter().enumerate() {
        let entry = walk.sequence.vertex_entry[walk.corners()[c]];
        if entry == NONE
            || (walk.sequence.point_entry[point] != NONE
                && walk.sequence.point_entry[point] != entry)
        {
            return Err(Error::Invalid);
        }
        walk.sequence.point_entry[point] = entry;
    }
    if walk.sequence.point_entry.contains(&NONE) {
        return Err(Error::Invalid);
    }
    Ok(walk.sequence)
}
