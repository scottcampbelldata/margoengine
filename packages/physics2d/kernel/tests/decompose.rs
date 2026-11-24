// Convex decomposition: the pieces are convex, small, cover the polygon exactly (their areas sum to its area and a grid
// of points falls in a piece exactly when it falls in the polygon), and bad outlines are refused.
use margoengine_physics2d_kernel::decompose::{DecomposeError, decompose};
use margoengine_physics2d_kernel::math::{V2, v2};
use margoengine_physics2d_kernel::shape::{Core, MAX_VERTICES};

fn area(points: &[V2]) -> f32 {
    let mut s = 0.0;
    for i in 0..points.len() {
        s += points[i].cross(points[(i + 1) % points.len()]);
    }
    0.5 * s
}

fn inside_polygon(poly: &[V2], p: V2) -> bool {
    // Even-odd.
    let mut inside = false;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
    }
    inside
}

fn inside_convex(piece: &[V2], p: V2) -> bool {
    (0..piece.len()).all(|i| piece[(i + 1) % piece.len()].sub(piece[i]).cross(p.sub(piece[i])) >= 0.0)
}

fn check(poly: &[V2]) -> usize {
    let pieces = decompose(poly).unwrap();
    let total: f32 = pieces.iter().map(|p| area(p)).sum();
    assert!((total - area(poly).abs()).abs() < 1.0e-3 * area(poly).abs().max(1.0), "area {total} against {}", area(poly));
    for piece in &pieces {
        assert!(piece.len() <= MAX_VERTICES && piece.len() >= 3);
        assert!(area(piece) > 0.0);
        // Every piece builds as a core: convex, counter-clockwise.
        assert!(Core::polygon(piece, 0.0).unwrap().count <= piece.len());
    }
    let (mut lo, mut hi) = (poly[0], poly[0]);
    for p in poly {
        lo = v2(lo.x.min(p.x), lo.y.min(p.y));
        hi = v2(hi.x.max(p.x), hi.y.max(p.y));
    }
    for gx in 0..40 {
        for gy in 0..40 {
            let p = v2(lo.x + (hi.x - lo.x) * (gx as f32 + 0.37) / 40.0, lo.y + (hi.y - lo.y) * (gy as f32 + 0.61) / 40.0);
            let in_pieces = pieces.iter().any(|piece| inside_convex(piece, p));
            assert_eq!(in_pieces, inside_polygon(poly, p), "point {p:?}");
        }
    }
    pieces.len()
}

#[test]
fn a_convex_polygon_with_few_corners_stays_one_piece() {
    assert_eq!(check(&[v2(0.0, 0.0), v2(2.0, 0.0), v2(2.0, 1.0), v2(0.0, 1.0)]), 1);
    // Clockwise input is turned.
    assert_eq!(check(&[v2(0.0, 0.0), v2(0.0, 1.0), v2(2.0, 1.0), v2(2.0, 0.0)]), 1);
}

#[test]
fn a_convex_polygon_with_many_corners_is_split_in_few() {
    let circle: Vec<V2> = (0..40).map(|i| {
        let a = i as f32 / 40.0 * core::f32::consts::TAU;
        v2(a.cos(), a.sin())
    }).collect();
    let pieces = check(&circle);
    assert!((6..=9).contains(&pieces), "{pieces}");
}

#[test]
fn concave_shapes_are_covered_exactly() {
    // An L, a U, a star and a comb.
    check(&[v2(0.0, 0.0), v2(3.0, 0.0), v2(3.0, 1.0), v2(1.0, 1.0), v2(1.0, 3.0), v2(0.0, 3.0)]);
    check(&[v2(0.0, 0.0), v2(3.0, 0.0), v2(3.0, 3.0), v2(2.0, 3.0), v2(2.0, 1.0), v2(1.0, 1.0), v2(1.0, 3.0), v2(0.0, 3.0)]);
    let star: Vec<V2> = (0..10).map(|i| {
        let a = i as f32 / 10.0 * core::f32::consts::TAU;
        let r = if i % 2 == 0 { 2.0 } else { 0.8 };
        v2(r * a.cos(), r * a.sin())
    }).collect();
    assert!(check(&star) <= 5);
    let mut comb = vec![v2(0.0, 0.0)];
    for i in 0..6 {
        let x = i as f32 * 2.0;
        comb.extend([v2(x, 0.5), v2(x, 3.0), v2(x + 1.0, 3.0), v2(x + 1.0, 0.5)]);
    }
    comb.extend([v2(12.0, 0.0)]);
    let n = check(&comb);
    assert!(n <= 14, "{n}");
}

#[test]
fn repeated_closing_points_and_collinear_runs_are_fine() {
    check(&[v2(0.0, 0.0), v2(1.0, 0.0), v2(2.0, 0.0), v2(2.0, 2.0), v2(0.0, 2.0), v2(0.0, 0.0)]);
}

#[test]
fn bad_outlines_are_refused() {
    assert_eq!(decompose(&[v2(0.0, 0.0), v2(1.0, 0.0)]).unwrap_err(), DecomposeError::Degenerate);
    assert_eq!(decompose(&[v2(0.0, 0.0), v2(1.0, 1.0), v2(2.0, 2.0)]).unwrap_err(), DecomposeError::Degenerate);
    assert_eq!(decompose(&[v2(f32::NAN, 0.0), v2(1.0, 0.0), v2(0.0, 1.0)]).unwrap_err(), DecomposeError::Degenerate);
    // A bow tie has no area, a pentagram crosses itself.
    assert_eq!(decompose(&[v2(0.0, 0.0), v2(2.0, 2.0), v2(2.0, 0.0), v2(0.0, 2.0)]).unwrap_err(), DecomposeError::Degenerate);
    let star: Vec<V2> = [0usize, 2, 4, 1, 3].iter().map(|&i| {
        let a = i as f32 / 5.0 * core::f32::consts::TAU;
        v2(a.cos(), a.sin())
    }).collect();
    assert_eq!(decompose(&star).unwrap_err(), DecomposeError::NotSimple);
}
