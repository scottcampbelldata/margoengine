// Splits a simple polygon, convex or not, into convex pieces of at most `MAX_VERTICES` corners.
// Ear clipping cuts the polygon into triangles (Meisters, "Polygons have ears", American Mathematical Monthly 82(6),
// 1975; the O(n^2) search for an ear without a vertex inside, as in Eberly, "Triangulation by Ear Clipping", Geometric
// Tools, 2002), then Hertel and Mehlhorn's greedy merge joins neighbours across a shared diagonal while the union stays
// convex and small enough (Hertel, Mehlhorn, "Fast triangulation of simple polygons", FCT 1983: never more than four
// times the optimum number of pieces, and in practice close to it).
use alloc::vec::Vec;

use crate::math::V2;
use crate::shape::{MAX_VERTICES, WELD};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum DecomposeError {
    /// Fewer than three distinct points, no area, or a number that is not finite.
    Degenerate,
    /// The outline crosses itself, so no triangulation exists.
    NotSimple,
}

fn cross(o: V2, a: V2, b: V2) -> f32 {
    a.sub(o).cross(b.sub(o))
}

fn area2(points: &[V2]) -> f64 {
    let mut sum = 0.0f64;
    for i in 0..points.len() {
        let (a, b) = (points[i], points[(i + 1) % points.len()]);
        sum += a.x as f64 * b.y as f64 - b.x as f64 * a.y as f64;
    }
    sum
}

fn in_triangle(p: V2, a: V2, b: V2, c: V2) -> bool {
    cross(a, b, p) >= 0.0 && cross(b, c, p) >= 0.0 && cross(c, a, p) >= 0.0
}

/// The convex pieces of the polygon through `points`, each as counter-clockwise points.
pub fn decompose(points: &[V2]) -> Result<Vec<Vec<V2>>, DecomposeError> {
    if points.iter().any(|p| !p.x.is_finite() || !p.y.is_finite()) {
        return Err(DecomposeError::Degenerate);
    }
    // Weld repeated points, including a closing copy of the first.
    let mut pts: Vec<V2> = Vec::with_capacity(points.len());
    for &p in points {
        if pts.last().is_none_or(|q| p.sub(*q).length_squared() > WELD * WELD) {
            pts.push(p);
        }
    }
    while pts.len() > 1 && pts[0].sub(pts[pts.len() - 1]).length_squared() <= WELD * WELD {
        pts.pop();
    }
    if pts.len() < 3 {
        return Err(DecomposeError::Degenerate);
    }
    let signed = area2(&pts);
    if !(signed.abs() > 1.0e-12) {
        return Err(DecomposeError::Degenerate);
    }
    if signed < 0.0 {
        pts.reverse();
    }
    let n = pts.len();
    // Two edges that cross properly make the outline not simple.
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        for j in i + 2..n {
            if i == 0 && j == n - 1 {
                continue;
            }
            let (c, d) = (pts[j], pts[(j + 1) % n]);
            if cross(a, b, c) * cross(a, b, d) < 0.0 && cross(c, d, a) * cross(c, d, b) < 0.0 {
                return Err(DecomposeError::NotSimple);
            }
        }
    }
    // Ear clipping over a ring of vertex indices.
    let mut ring: Vec<usize> = (0..n).collect();
    let mut triangles: Vec<[usize; 3]> = Vec::with_capacity(n - 2);
    let mut guard = 0;
    while ring.len() > 3 {
        let m = ring.len();
        let mut clipped = false;
        for k in 0..m {
            let (ia, ib, ic) = (ring[(k + m - 1) % m], ring[k], ring[(k + 1) % m]);
            let (a, b, c) = (pts[ia], pts[ib], pts[ic]);
            if cross(a, b, c) <= 0.0 {
                continue;
            }
            let blocked = ring.iter().any(|&j| j != ia && j != ib && j != ic && {
                let p = pts[j];
                // A vertex that coincides with a corner is the same point, not an intruder.
                p.sub(a).length_squared() > WELD * WELD && p.sub(b).length_squared() > WELD * WELD && p.sub(c).length_squared() > WELD * WELD && in_triangle(p, a, b, c)
            });
            if blocked {
                continue;
            }
            triangles.push([ia, ib, ic]);
            ring.remove(k);
            clipped = true;
            break;
        }
        if !clipped {
            // A flat run of points has no ear: drop a collinear vertex, else the outline is not simple.
            let m = ring.len();
            let flat = (0..m).find(|&k| cross(pts[ring[(k + m - 1) % m]], pts[ring[k]], pts[ring[(k + 1) % m]]).abs() <= WELD * 0.5);
            match flat {
                Some(k) => {
                    ring.remove(k);
                }
                None => return Err(DecomposeError::NotSimple),
            }
        }
        guard += 1;
        if guard > 4 * n * n {
            return Err(DecomposeError::NotSimple);
        }
    }
    if ring.len() == 3 && cross(pts[ring[0]], pts[ring[1]], pts[ring[2]]) > 0.0 {
        triangles.push([ring[0], ring[1], ring[2]]);
    }
    if triangles.is_empty() {
        return Err(DecomposeError::Degenerate);
    }
    // Hertel-Mehlhorn: merge across shared diagonals while convex and small.
    let mut pieces: Vec<Vec<usize>> = triangles.iter().map(|t| t.to_vec()).collect();
    loop {
        let mut merged = false;
        'search: for i in 0..pieces.len() {
            for j in i + 1..pieces.len() {
                if pieces[i].len() + pieces[j].len() - 2 > MAX_VERTICES {
                    continue;
                }
                if let Some(joined) = join(&pts, &pieces[i], &pieces[j]) {
                    pieces[i] = joined;
                    pieces.remove(j);
                    merged = true;
                    break 'search;
                }
            }
        }
        if !merged {
            break;
        }
    }
    Ok(pieces.into_iter().map(|piece| piece.into_iter().map(|i| pts[i]).collect()).collect())
}

/// The union of two counter-clockwise pieces that share an edge, when it is convex.
fn join(pts: &[V2], p: &[usize], q: &[usize]) -> Option<Vec<usize>> {
    for i in 0..p.len() {
        let (a, b) = (p[i], p[(i + 1) % p.len()]);
        // The neighbour runs the shared edge the other way: b then a.
        let Some(j) = (0..q.len()).find(|&j| q[j] == b && q[(j + 1) % q.len()] == a) else { continue };
        // p from b round to a, then q's vertices after a up to the one before b.
        let mut out = Vec::with_capacity(p.len() + q.len() - 2);
        for k in 0..p.len() {
            out.push(p[(i + 1 + k) % p.len()]);
        }
        for k in 2..q.len() {
            out.push(q[(j + k) % q.len()]);
        }
        // `out` starts at b and ends at a; check every corner turns left or goes straight.
        let m = out.len();
        let convex = (0..m).all(|k| cross(pts[out[(k + m - 1) % m]], pts[out[k]], pts[out[(k + 1) % m]]) >= -WELD * 0.25);
        return convex.then_some(out);
    }
    None
}
