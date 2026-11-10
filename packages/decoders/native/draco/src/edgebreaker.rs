//! Connectivity from the published Version 2,2 EdgeBreaker algorithms.
//! Valence framing is confirmed by E8 in the clean-room inference ledger.
use crate::{
    Budget, Error, Limits, Result,
    cursor::{Bits, Cursor},
    entropy::{self, Ans},
};

pub(crate) const NONE: usize = usize::MAX;
pub(crate) fn next(c: usize) -> usize {
    if c == NONE {
        NONE
    } else if c % 3 == 2 {
        c - 2
    } else {
        c + 1
    }
}
pub(crate) fn prev(c: usize) -> usize {
    if c == NONE {
        NONE
    } else if c.is_multiple_of(3) {
        c + 2
    } else {
        c - 1
    }
}
pub(crate) struct Binary<'a> {
    p0: u8,
    ans: Ans<'a>,
}
impl<'a> Binary<'a> {
    pub fn read(c: &mut Cursor<'a>) -> Result<Self> {
        let p0 = c.byte()?;
        Ok(Self {
            p0,
            ans: Ans::new(
                if c.version < 0x202 {
                    c.fixed_blob(32)?
                } else {
                    c.blob(32)?
                },
                4096,
            )?,
        })
    }
    pub fn bit(&mut self) -> Result<bool> {
        self.ans.binary(self.p0)
    }
}
enum StartFaces<'a> {
    Binary(Binary<'a>),
    Direct(Bits<'a>),
}
impl StartFaces<'_> {
    fn bit(&mut self) -> Result<bool> {
        match self {
            Self::Binary(binary) => binary.bit(),
            Self::Direct(bits) => Ok(bits.read(1)? != 0),
        }
    }
}

pub(crate) struct Topology<'a> {
    pub corners: Vec<usize>,
    pub opposite: Vec<usize>,
    pub vertex_corner: Vec<usize>,
    pub hole: Vec<bool>,
    pub seams: Vec<Binary<'a>>,
    seam_twice: bool,
    isolated: Vec<usize>,
    created: usize,
}
pub(crate) struct AttributeTopology {
    pub corners: Vec<usize>,
    pub vertex_corner: Vec<usize>,
    pub boundary: Vec<bool>,
    pub seam: Vec<bool>,
}
pub(crate) struct Mapping {
    pub attributes: Vec<AttributeTopology>,
    pub corner_to_point: Vec<usize>,
    pub points: usize,
}
impl Topology<'_> {
    pub fn swing_left(&self, c: usize) -> usize {
        next(self.opp(next(c)))
    }
    pub fn swing_right(&self, c: usize) -> usize {
        prev(self.opp(prev(c)))
    }
    pub fn opp(&self, c: usize) -> usize {
        self.opposite.get(c).copied().unwrap_or(NONE)
    }
    fn pair(&mut self, a: usize, b: usize) -> Result<()> {
        if a == b
            || a >= self.opposite.len()
            || b >= self.opposite.len()
            || self.opposite[a] != NONE
            || self.opposite[b] != NONE
        {
            return Err(Error::Invalid);
        }
        self.opposite[a] = b;
        self.opposite[b] = a;
        Ok(())
    }
    fn boundary(&self, mut c: usize, left: bool, budget: &mut Budget) -> Result<usize> {
        for _ in 0..=self.corners.len() {
            budget.steps(1)?;
            let opposite = self.opp(c);
            if opposite == NONE {
                return Ok(c);
            }
            c = if left { prev(opposite) } else { next(opposite) };
        }
        Err(Error::Invalid)
    }
    pub fn update_boundary_corners(&mut self, budget: &mut Budget) -> Result<()> {
        for v in 0..self.vertex_corner.len() {
            let first = self.vertex_corner[v];
            if first == NONE || !self.hole[v] {
                continue;
            }
            let mut c = first;
            for _ in 0..=self.corners.len() {
                budget.steps(1)?;
                let act = self.swing_left(c);
                // A malformed interior cap can join different vertex fans.
                // E9 held-out caps: keep representatives on their own vertex.
                if act != NONE && self.corners[act] != v {
                    self.vertex_corner[v] = c;
                    break;
                }
                if act == NONE {
                    self.vertex_corner[v] = c;
                    break;
                }
                if act == first {
                    break;
                }
                c = act;
            }
        }
        Ok(())
    }
    pub fn mapping(&mut self, budget: &mut Budget) -> Result<Mapping> {
        let count = self.corners.len();
        if self.seams.is_empty() {
            let mut mapping = budget.vector(self.created, 0_usize)?;
            for (i, v) in mapping.iter_mut().enumerate() {
                *v = i;
            }
            let mut vertices = self.created;
            for &removed in &self.isolated {
                while vertices > 0 && self.vertex_corner[mapping[vertices - 1]] == NONE {
                    vertices -= 1;
                }
                if removed >= vertices {
                    continue;
                }
                vertices = vertices.checked_sub(1).ok_or(Error::Invalid)?;
                mapping[removed] = mapping[vertices];
            }
            let mut inverse = budget.vector(self.created, NONE)?;
            for (point, &vertex) in mapping[..vertices].iter().enumerate() {
                inverse[vertex] = point;
            }
            let mut corner_to_point = budget.vector(count, NONE)?;
            for (out, &vertex) in corner_to_point.iter_mut().zip(&self.corners) {
                *out = inverse[vertex];
            }
            if corner_to_point.contains(&NONE) {
                return Err(Error::Invalid);
            }
            return Ok(Mapping {
                attributes: Vec::new(),
                corner_to_point,
                points: vertices,
            });
        }
        budget.charge(self.seams.len(), std::mem::size_of::<AttributeTopology>())?;
        let mut attributes = Vec::new();
        attributes
            .try_reserve_exact(self.seams.len())
            .map_err(|_| Error::Limit)?;
        for _ in 0..self.seams.len() {
            attributes.push(AttributeTopology {
                corners: Vec::new(),
                vertex_corner: Vec::new(),
                boundary: Vec::new(),
                seam: Vec::new(),
            });
        }
        for attr in &mut attributes {
            attr.corners = budget.vector(count, NONE)?;
            attr.seam = budget.vector(count, false)?;
        }
        for c in 0..count {
            budget.steps(1)?;
            let opposite = self.opp(c);
            if !self.seam_twice && opposite != NONE && opposite < c {
                continue;
            }
            for (attr, decoder) in attributes.iter_mut().zip(&mut self.seams) {
                if opposite == NONE || decoder.bit()? {
                    attr.seam[c] = true;
                    if opposite != NONE {
                        attr.seam[opposite] = true;
                    }
                }
            }
        }
        for attr in &mut attributes {
            let mut incident = budget.vector(self.vertex_corner.len(), false)?;
            for c in 0..count {
                if attr.seam[c] {
                    incident[self.corners[next(c)]] = true;
                    incident[self.corners[prev(c)]] = true;
                }
            }
            // At most one attribute vertex per corner. Reserve once so every
            // later push is covered by the checked allocation budget.
            budget.charge(count, std::mem::size_of::<usize>() + 1)?;
            attr.vertex_corner
                .try_reserve_exact(count)
                .map_err(|_| Error::Limit)?;
            attr.boundary
                .try_reserve_exact(count)
                .map_err(|_| Error::Limit)?;
            for (v, &start) in self.vertex_corner.iter().enumerate() {
                if start == NONE {
                    continue;
                }
                let mut first = start;
                if incident[v] {
                    for _ in 0..=count {
                        budget.steps(1)?;
                        if attr.seam[next(first)] {
                            break;
                        }
                        let act = self.swing_left(first);
                        if act == NONE || act == start {
                            return Err(Error::Invalid);
                        }
                        first = act;
                    }
                }
                let mut id = attr.vertex_corner.len();
                attr.vertex_corner.push(first);
                attr.boundary.push(incident[v]);
                attr.corners[first] = id;
                let mut act = self.swing_right(first);
                for _ in 0..=count {
                    if act == NONE || act == first {
                        break;
                    }
                    budget.steps(1)?;
                    if attr.seam[next(act)] {
                        id = attr.vertex_corner.len();
                        attr.vertex_corner.push(act);
                        attr.boundary.push(true);
                    }
                    attr.corners[act] = id;
                    act = self.swing_right(act);
                }
                if act != NONE && act != first {
                    return Err(Error::Invalid);
                }
            }
            if attr.corners.contains(&NONE) {
                return Err(Error::Invalid);
            }
        }
        let mut mapping = Mapping {
            attributes,
            // E9 capped-boundary probes confirm zero for corners that no
            // deduplication walk reaches, including overwritten partial fans.
            corner_to_point: budget.vector(count, 0)?,
            points: 0,
        };
        for (v, &start) in self.vertex_corner.iter().enumerate() {
            if start == NONE {
                continue;
            }
            let mut first = start;
            if !self.hole[v] {
                for attr in &mapping.attributes {
                    let id = attr.corners[start];
                    // An attribute vertex without an incident seam has one
                    // value throughout its fan. Attribute construction above
                    // has already walked and validated that fan; do not walk
                    // it again just to look for a seam that cannot exist.
                    if !attr.boundary[id] {
                        continue;
                    }
                    let mut act = self.swing_right(start);
                    for _ in 0..=count {
                        if act == start {
                            break;
                        }
                        if act == NONE {
                            return Err(Error::Invalid);
                        }
                        budget.steps(1)?;
                        if attr.corners[act] != id {
                            first = act;
                            break;
                        }
                        act = self.swing_right(act);
                    }
                    if first != start {
                        break;
                    }
                }
            }
            mapping.corner_to_point[first] = mapping.points;
            mapping.points += 1;
            let mut previous = first;
            let mut act = self.swing_right(first);
            for _ in 0..=count {
                if act == NONE || act == first {
                    break;
                }
                budget.steps(1)?;
                if mapping
                    .attributes
                    .iter()
                    .any(|attr| attr.corners[act] != attr.corners[previous])
                {
                    mapping.corner_to_point[act] = mapping.points;
                    mapping.points += 1;
                } else {
                    mapping.corner_to_point[act] = mapping.corner_to_point[previous];
                }
                previous = act;
                act = self.swing_right(act);
            }
            if act != NONE && act != first {
                return Err(Error::Invalid);
            }
        }
        Ok(mapping)
    }
}

// A merge changes vertex identity, not corner order. Path compression expresses
// the specification's ReplaceVerts without rescanning every previous face.
fn root(parent: &mut [usize], v: usize, budget: &mut Budget) -> Result<usize> {
    let mut r = v;
    loop {
        budget.steps(1)?;
        let p = *parent.get(r).ok_or(Error::Invalid)?;
        if p == r {
            break;
        }
        r = p;
    }
    let mut c = v;
    while parent[c] != r {
        let p = parent[c];
        parent[c] = r;
        c = p;
    }
    Ok(r)
}

pub(crate) fn decode<'a>(
    c: &mut Cursor<'a>,
    limits: Limits,
    budget: &mut Budget,
) -> Result<Topology<'a>> {
    let traversal = c.byte()?;
    if traversal > 2 {
        return Err(Error::Unsupported);
    }
    // E17: older streams have an informational count before the vertex count.
    // Its 0/1/2/3/97 sweep leaves crafted topology output unchanged.
    if c.version < 0x202 {
        c.legacy_count()?;
    }
    let vertices = c.legacy_count()?;
    let faces = c.legacy_count()?;
    let attributes = usize::from(c.byte()?);
    let symbols = c.legacy_count()?;
    let splits = c.legacy_count()?;
    let max_vertices = vertices.checked_add(splits).ok_or(Error::Overflow)?;
    let corners = faces.checked_mul(3).ok_or(Error::Overflow)?;
    if vertices > limits.vertices || corners > limits.indices || max_vertices > 16_777_216 {
        return Err(Error::Limit);
    }
    if symbols > faces || splits > symbols || faces > symbols.saturating_mul(2) {
        return Err(Error::Invalid);
    }
    if max_vertices > symbols.saturating_mul(3) {
        return Err(Error::Invalid);
    }
    let mut legacy_traversal = if c.version < 0x202 {
        let size = c.legacy_count()?;
        let mut traversal = Cursor::new(c.take(size)?);
        traversal.version = c.version;
        Some(traversal)
    } else {
        None
    };
    let event_count = c.legacy_count()?;
    if event_count > splits {
        return Err(Error::Invalid);
    }
    let mut events = budget.vector(event_count, (0_usize, 0_usize, false))?;
    let mut source = 0_usize;
    for event in &mut events {
        let (target, right) = if c.version < 0x102 {
            let target = c.le(4)? as usize;
            source = c.le(4)? as usize;
            (target, c.byte()? & 1 != 0)
        } else {
            source = source.checked_add(c.count()?).ok_or(Error::Overflow)?;
            (source.checked_sub(c.count()?).ok_or(Error::Invalid)?, false)
        };
        if source >= symbols || target >= source {
            return Err(Error::Invalid);
        }
        *event = (source, target, right);
    }
    let mut bits = Bits::new(&c.data[c.at..]);
    if c.version >= 0x102 {
        for e in &mut events {
            e.2 = bits.read(if c.version < 0x202 { 2 } else { 1 })? & 1 != 0;
        }
    }
    c.take(bits.used_bytes())?;
    if c.version < 0x201 {
        // E17: the obsolete hole list is framing only. Removing or changing it
        // in three historical seeds preserves every exposed output byte.
        let holes = c.legacy_count()?;
        budget.steps(holes)?;
        for _ in 0..holes {
            if c.version < 0x102 {
                c.le(4)?;
            } else {
                c.count()?;
            }
        }
    }
    let c = legacy_traversal.as_mut().unwrap_or(c);
    let symbol_data = if traversal != 2 {
        if c.version < 0x202 {
            c.fixed_blob(64)?
        } else {
            c.blob(64)?
        }
    } else {
        &[]
    };
    let mut start_faces = if c.version < 0x202 {
        StartFaces::Direct(Bits::new(c.fixed_blob(64)?))
    } else {
        StartFaces::Binary(Binary::read(c)?)
    };
    let mut seams = Vec::new();
    budget.charge(attributes, std::mem::size_of::<Binary>())?;
    seams
        .try_reserve_exact(attributes)
        .map_err(|_| Error::Limit)?;
    for _ in 0..attributes {
        seams.push(Binary::read(c)?);
    }
    // E16: predictive traversal adds a fixed-width word and a binary stream
    // after all seam streams. Its standard-symbol stream contains fallbacks
    // only. The word's output-independent role is not specified.
    let mut predictions = if traversal == 1 {
        c.le(4)?;
        Some(Binary::read(c)?)
    } else {
        None
    };
    let mut contexts = budget.vector(6, Vec::<u32>::new())?;
    if traversal == 2 {
        let mut total = 0_usize;
        for ctx in &mut contexts {
            let n = c.count()?;
            total = total.checked_add(n).ok_or(Error::Overflow)?;
            if total > symbols.saturating_sub(1) {
                return Err(Error::Invalid);
            }
            if n > 0 {
                *ctx = entropy::symbols(c, n, 1, budget)?;
            }
        }
        if total != symbols.saturating_sub(1) {
            return Err(Error::Invalid);
        }
    }
    let mut topo = Topology {
        corners: budget.vector(corners, NONE)?,
        opposite: budget.vector(corners, NONE)?,
        vertex_corner: budget.vector(max_vertices, NONE)?,
        hole: budget.vector(max_vertices, true)?,
        seams,
        seam_twice: c.version < 0x201,
        isolated: budget.vector(splits, 0_usize)?,
        created: 0,
    };
    topo.isolated.clear();
    let mut parent = budget.vector(max_vertices, 0_usize)?;
    for (i, p) in parent.iter_mut().enumerate() {
        *p = i;
    }
    let mut valences = budget.vector(max_vertices, 0_usize)?;
    let mut stack = budget.vector(symbols, 0_usize)?;
    stack.clear();
    let mut pending = budget.vector(symbols, NONE)?;
    let mut symbol_bits = Bits::new(symbol_data);
    let mut created = 0_usize;
    let mut active_context = NONE;
    let mut predicted = NONE;
    let mut merged = 0_usize;
    for id in 0..symbols {
        budget.steps(1)?;
        let predicted_ok = if predicted != NONE {
            predictions.as_mut().ok_or(Error::Invalid)?.bit()?
        } else {
            false
        };
        let symbol = if predicted_ok {
            predicted as u32
        } else if traversal != 2 {
            if symbol_bits.read(1)? == 0 {
                0
            } else {
                1 | (symbol_bits.read(2)? << 1)
            }
        } else if active_context == NONE {
            7
        } else {
            let symbol = contexts[active_context].pop().ok_or(Error::Invalid)?;
            *[0, 1, 3, 5, 7].get(symbol as usize).ok_or(Error::Invalid)?
        };
        let nc = id * 3;
        let (v, n, p);
        match symbol {
            7 => {
                v = created;
                n = v + 1;
                p = v + 2;
                created += 3;
                if created > max_vertices {
                    return Err(Error::Invalid);
                }
                stack.push(nc);
                valences[v] = 2;
                valences[n] = 2;
                valences[p] = 2;
            }
            3 | 5 => {
                let a = *stack.last().ok_or(Error::Invalid)?;
                let vn = root(&mut parent, topo.corners[next(a)], budget)?;
                let vp = root(&mut parent, topo.corners[prev(a)], budget)?;
                let new = created;
                created += 1;
                if created > max_vertices {
                    return Err(Error::Invalid);
                }
                if symbol == 3 {
                    v = vn;
                    n = new;
                    p = vp;
                    topo.pair(nc + 1, a)?;
                } else {
                    v = vp;
                    n = vn;
                    p = new;
                    topo.pair(nc + 2, a)?;
                }
                valences[v] += 1;
                valences[n] += if symbol == 3 { 2 } else { 1 };
                valences[p] += if symbol == 3 { 1 } else { 2 };
                *stack.last_mut().ok_or(Error::Invalid)? = nc;
            }
            0 => {
                let a = *stack.last().ok_or(Error::Invalid)?;
                let b = topo.boundary(prev(a), true, budget)?;
                v = root(&mut parent, topo.corners[next(a)], budget)?;
                n = root(&mut parent, topo.corners[next(b)], budget)?;
                p = root(&mut parent, topo.corners[prev(a)], budget)?;
                topo.pair(a, nc + 1)?;
                topo.pair(b, nc + 2)?;
                topo.hole[v] = false;
                valences[n] += 1;
                valences[p] += 1;
                *stack.last_mut().ok_or(Error::Invalid)? = nc;
            }
            1 => {
                let b = stack.pop().ok_or(Error::Invalid)?;
                if pending[id] != NONE {
                    stack.push(pending[id]);
                    pending[id] = NONE;
                }
                let a = *stack.last().ok_or(Error::Invalid)?;
                v = root(&mut parent, topo.corners[prev(a)], budget)?;
                n = root(&mut parent, topo.corners[next(a)], budget)?;
                p = root(&mut parent, topo.corners[prev(b)], budget)?;
                let removed = root(&mut parent, topo.corners[next(b)], budget)?;
                if removed == v {
                    return Err(Error::Invalid);
                }
                topo.pair(a, nc + 2)?;
                topo.pair(b, nc + 1)?;
                parent[removed] = v;
                topo.vertex_corner[removed] = NONE;
                topo.isolated.push(removed);
                valences[v] += valences[removed];
                valences[n] += 1;
                valences[p] += 1;
                merged += 1;
                *stack.last_mut().ok_or(Error::Invalid)? = nc;
            }
            _ => return Err(Error::Invalid),
        }
        topo.corners[nc..nc + 3].copy_from_slice(&[v, n, p]);
        // Keep the left boundary representative. Closing a fan preserves its
        // representative, which determines the first point at an attribute seam.
        match symbol {
            7 => {
                topo.vertex_corner[v] = nc;
                topo.vertex_corner[n] = nc + 1;
                topo.vertex_corner[p] = nc + 2;
            }
            3 => {
                topo.vertex_corner[n] = nc + 1;
                topo.vertex_corner[p] = nc + 2;
            }
            5 => {
                topo.vertex_corner[v] = nc;
                topo.vertex_corner[p] = nc + 2;
            }
            0 => {
                topo.vertex_corner[p] = nc + 2;
            }
            1 => {
                let mut corner = next(topo.opp(nc + 1));
                for _ in 0..=corners {
                    if corner == NONE {
                        break;
                    }
                    budget.steps(1)?;
                    topo.vertex_corner[v] = corner;
                    corner = topo.swing_left(corner);
                }
                if corner != NONE {
                    return Err(Error::Invalid);
                }
                topo.vertex_corner[p] = nc + 2;
            }
            _ => unreachable!(),
        }
        active_context = valences[n].clamp(2, 7) - 2;
        if traversal == 1 {
            // E16 controls isolate this vertex and threshold: after C or R,
            // degree >= 6 predicts C, otherwise R. E/L/S clear prediction.
            predicted = if symbol == 0 || symbol == 5 {
                if valences[n] >= 6 { 0 } else { 5 }
            } else {
                NONE
            };
        }
        if symbol == 7 || symbol == 3 || symbol == 5 {
            let encoder_id = symbols - id - 1;
            while events.last().is_some_and(|event| event.0 == encoder_id) {
                let (_, target, right) = events.pop().ok_or(Error::Invalid)?;
                let target = symbols - target - 1;
                if target <= id || pending[target] != NONE {
                    return Err(Error::Invalid);
                }
                pending[target] = if right { next(nc) } else { prev(nc) };
            }
        }
    }
    if merged != splits || !events.is_empty() || pending.iter().any(|v| *v != NONE) {
        return Err(Error::Invalid);
    }
    let mut made_faces = symbols;
    while let Some(a) = stack.pop() {
        if !start_faces.bit()? {
            continue;
        }
        let b = topo.boundary(prev(a), true, budget)?;
        let cc = topo.boundary(prev(b), true, budget)?;
        if made_faces >= faces {
            return Err(Error::Invalid);
        }
        let nc = made_faces * 3;
        made_faces += 1;
        let v = root(&mut parent, topo.corners[next(b)], budget)?;
        let n = root(&mut parent, topo.corners[next(cc)], budget)?;
        let p = root(&mut parent, topo.corners[next(a)], budget)?;
        topo.pair(nc, a)?;
        topo.pair(nc + 1, b)?;
        topo.pair(nc + 2, cc)?;
        topo.corners[nc..nc + 3].copy_from_slice(&[v, n, p]);
        for vertex in [v, n, p] {
            topo.hole[vertex] = false;
        }
    }
    if made_faces != faces || created.checked_sub(merged) != Some(vertices) {
        return Err(Error::Invalid);
    }
    for v in &mut topo.corners {
        *v = root(&mut parent, *v, budget)?;
    }
    topo.created = created;
    topo.update_boundary_corners(budget)?;
    Ok(topo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seamless_attribute_fans_are_not_searched_again_for_a_seam() {
        // Independently constructed, consistently oriented closed tetrahedron.
        // Every vertex has a three-corner fan. A seam-free attribute must not
        // add another two fan steps per vertex to find a point-ordering seam.
        const FALSE_BITS: &[u8] = &[128, 4, 128, 191, 255, 128];
        let corners = vec![0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];
        let mut opposite = vec![NONE; corners.len()];
        for c in 0..corners.len() {
            for d in c + 1..corners.len() {
                if corners[next(c)] == corners[prev(d)] && corners[prev(c)] == corners[next(d)] {
                    assert_eq!(opposite[c], NONE);
                    assert_eq!(opposite[d], NONE);
                    opposite[c] = d;
                    opposite[d] = c;
                }
            }
        }
        assert!(!opposite.contains(&NONE));
        for attribute_count in [1, 4, 16] {
            let mut topo = Topology {
                corners: corners.clone(),
                opposite: opposite.clone(),
                vertex_corner: vec![0, 1, 2, 4],
                hole: vec![false; 4],
                seams: (0..attribute_count)
                    .map(|_| Binary::read(&mut Cursor::new(FALSE_BITS)).unwrap())
                    .collect(),
                seam_twice: false,
                isolated: Vec::new(),
                created: 4,
            };
            let mut budget = Budget::new(1 << 20);
            let before = budget.work;
            let mapping = topo.mapping(&mut budget).unwrap();
            assert_eq!(mapping.points, 4);
            assert_eq!(mapping.corner_to_point, corners);
            // 12 corner visits, 8 steps to build each attribute's fans, and
            // 8 final point-assignment steps. No second per-attribute search.
            assert_eq!(before - budget.work, 20 + 8 * attribute_count);
        }
    }

    fn num(b: &[u8], at: &mut usize) -> usize {
        let v = u32::from_le_bytes(b[*at..*at + 4].try_into().unwrap()) as usize;
        *at += 4;
        v
    }
    fn blob<'a>(b: &'a [u8], at: &mut usize) -> &'a [u8] {
        let n = num(b, at);
        let out = &b[*at..*at + n];
        *at += n;
        out
    }
    #[test]
    fn standard_and_valence_connectivity_match_black_box() {
        let b = include_bytes!("../tests/fixtures/connectivity.bin");
        let mut at = 0;
        let count = num(b, &mut at);
        assert_eq!(count, 730);
        let mut failures = Vec::new();
        for _ in 0..count {
            let name = std::str::from_utf8(blob(b, &mut at)).unwrap();
            let input = blob(b, &mut at);
            let points = num(b, &mut at);
            let n = num(b, &mut at);
            let expected: Vec<_> = (0..n).map(|_| num(b, &mut at)).collect();
            let mut c = Cursor::new(&input[11..]);
            c.version = u16::from(input[5]) * 256 + u16::from(input[6]);
            let mut budget = Budget::new(256 * 1024 * 1024);
            match decode(&mut c, Limits::default(), &mut budget) {
                Err(e) => failures.push(format!("{name}: {e:?} offset {}", c.at)),
                Ok(mut t) => {
                    match t.mapping(&mut budget) {
                        Err(e) => failures.push(format!("{name}: mapping {e:?}")),
                        Ok(mapping) => {
                            if points != mapping.points || mapping.corner_to_point != expected {
                                let differences: Vec<_> = mapping
                                    .corner_to_point
                                    .iter()
                                    .zip(&expected)
                                    .enumerate()
                                    .filter(|(_, (a, b))| a != b)
                                    .take(8)
                                    .collect();
                                failures.push(format!(
                                    "{name}: points {}/{points}, differences {differences:?}",
                                    mapping.points
                                ));
                            }
                        }
                    }
                    assert_eq!(
                        input[c.at + 11],
                        0,
                        "{name}: expected zero attribute groups"
                    );
                }
            }
        }
        assert_eq!(at, b.len());
        assert!(
            failures.is_empty(),
            "{} failures: {failures:?}",
            failures.len()
        );
    }
    #[test]
    fn corner_algebra_preserves_invalid_and_rotates_each_face() {
        assert_eq!(next(NONE), NONE);
        assert_eq!(prev(NONE), NONE);
        for c in 0..300 {
            assert_eq!(prev(next(c)), c);
            assert_eq!(next(prev(c)), c);
            assert_eq!(next(next(next(c))), c);
        }
    }

    #[test]
    fn wide_parallelogram_predictors_reuse_complete_component_scratch() {
        use crate::prediction::Mesh;
        use crate::traversal::{Group, Sequence};
        let topology = Topology {
            corners: vec![3, 1, 2, 0, 2, 1],
            opposite: vec![3, NONE, NONE, 0, NONE, NONE],
            vertex_corner: vec![3, 1, 2, 0],
            hole: vec![true; 4],
            seams: Vec::new(),
            seam_twice: false,
            isolated: Vec::new(),
            created: 4,
        };
        let mapping = Mapping {
            attributes: Vec::new(),
            corner_to_point: vec![3, 1, 2, 0, 2, 1],
            points: 4,
        };
        let sequence = Sequence {
            entry_corner: vec![3, 1, 2, 0],
            vertex_entry: vec![0, 1, 2, 3],
            point_entry: vec![0, 1, 2, 3],
        };
        let mesh = Mesh {
            topology: &topology,
            mapping: &mapping,
            sequence: &sequence,
            group: Group::default(),
        };
        for components in [1, 16, 17, 31, 64, 127, 255] {
            let data: Vec<i32> = (0..4)
                .flat_map(|row| {
                    (0..components).map(move |component| row * 10 + component as i32 * 3)
                })
                .collect();
            let expected = &data[3 * components..];
            let mut prediction = vec![77; components];
            let mut scratch = vec![99; components * 4];
            let mut budget = Budget::new(1024 * 1024);
            assert!(mesh.parallelogram(3, components, &data, &mut prediction));
            assert_eq!(prediction, expected);
            assert!(
                mesh.multi(
                    3,
                    components,
                    &data,
                    &mut budget,
                    &mut prediction,
                    &mut scratch
                )
                .unwrap()
            );
            assert_eq!(prediction, expected);
            let flags = [vec![false], Vec::new(), Vec::new(), Vec::new()];
            let mut positions = [0; 4];
            assert!(
                mesh.constrained(
                    3,
                    components,
                    &data,
                    &flags,
                    &mut positions,
                    &mut budget,
                    &mut prediction,
                    &mut scratch
                )
                .unwrap()
            );
            assert_eq!(prediction, expected);
            assert_eq!(positions, [1, 0, 0, 0]);
        }
    }
}
