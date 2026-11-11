// Clean-room real dense decompositions. No dependency or companion source used.
// See Demmel/Veselic 1992 (one-sided Jacobi), Golub/Reinsch 1970,
// Householder reflectors and partial-pivoted Gaussian elimination.
fn dot(x: &[f64], y: &[f64]) -> f64 {
    // SIMD products, same left-to-right additions as a scalar reference.
    let mut s = 0.0;
    let mut i = 0;
    #[cfg(target_arch = "wasm32")]
    unsafe {
        use core::arch::wasm32::*;
        while i + 1 < x.len() {
            let v = f64x2_mul(
                v128_load(x.as_ptr().add(i) as *const v128),
                v128_load(y.as_ptr().add(i) as *const v128),
            );
            s += f64x2_extract_lane::<0>(v);
            s += f64x2_extract_lane::<1>(v);
            i += 2;
        }
    }
    while i < x.len() {
        s += x[i] * y[i];
        i += 1;
    }
    s
}

fn lu(a: &mut [f64], n: usize) -> Result<(Vec<usize>, f64), usize> {
    let mut pivots: Vec<usize> = (0..n).collect();
    let mut sign = 1.0;
    for k in 0..n {
        let mut pivot = k;
        for r in k + 1..n {
            if a[r * n + k].abs() > a[pivot * n + k].abs() {
                pivot = r;
            }
        }
        if a[pivot * n + k] == 0.0 {
            return Err(k);
        }
        if pivot != k {
            for c in 0..n {
                a.swap(k * n + c, pivot * n + c);
            }
            pivots.swap(k, pivot);
            sign = -sign;
        }
        for r in k + 1..n {
            a[r * n + k] /= a[k * n + k];
            let factor = a[r * n + k];
            for c in k + 1..n {
                a[r * n + c] -= factor * a[k * n + c];
            }
        }
    }
    Ok((pivots, sign))
}

fn solve(a: &[f64], b: &[f64], n: usize, rhs: usize) -> Result<Vec<f64>, usize> {
    let mut factors = a.to_vec();
    let (pivots, _) = lu(&mut factors, n)?;
    let mut out = vec![0.0; n * rhs];
    for r in 0..n {
        for c in 0..rhs {
            out[r * rhs + c] = b[pivots[r] * rhs + c];
        }
    }
    for r in 0..n {
        for j in 0..r {
            for c in 0..rhs {
                out[r * rhs + c] -= factors[r * n + j] * out[j * rhs + c];
            }
        }
    }
    for r in (0..n).rev() {
        for c in 0..rhs {
            for j in r + 1..n {
                out[r * rhs + c] -= factors[r * n + j] * out[j * rhs + c];
            }
            out[r * rhs + c] /= factors[r * n + r];
        }
    }
    Ok(out)
}

fn cholesky(a: &[f64], n: usize) -> Result<Vec<f64>, usize> {
    let mut l = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..=i {
            let mut s = a[i * n + j];
            for k in 0..j {
                s -= l[i * n + k] * l[j * n + k];
            }
            if i == j {
                if s <= 0.0 {
                    return Err(i);
                }
                l[i * n + j] = s.sqrt();
            } else {
                l[i * n + j] = s / l[j * n + j];
            }
        }
    }
    Ok(l)
}

fn qr(a: &[f64], m: usize, n: usize, full: bool) -> (Vec<f64>, Vec<f64>) {
    let k = m.min(n);
    let qcols = if full { m } else { k };
    let scale = a
        .iter()
        .fold(0.0_f64, |s, x| s.max(x.abs()))
        .max(f64::MIN_POSITIVE);
    let mut r: Vec<f64> = a.iter().map(|x| x / scale).collect();
    let mut reflectors = Vec::with_capacity(k);
    for col in 0..k {
        let mut v: Vec<f64> = (col..m).map(|i| r[i * n + col]).collect();
        let norm = v.iter().fold(0.0_f64, |s, x| s.hypot(*x));
        if norm == 0.0 {
            reflectors.push(v);
            continue;
        }
        v[0] += norm.copysign(v[0]);
        let scale = v.iter().fold(0.0_f64, |s, x| s.hypot(*x));
        for x in &mut v {
            *x /= scale;
        }
        for c in col..n {
            let mut d = 0.0;
            for (i, x) in v.iter().enumerate() {
                d += *x * r[(col + i) * n + c];
            }
            for (i, x) in v.iter().enumerate() {
                r[(col + i) * n + c] -= 2.0 * *x * d;
            }
        }
        for i in col + 1..m {
            r[i * n + col] = 0.0;
        }
        reflectors.push(v);
    }
    let mut q = vec![0.0; m * qcols];
    for i in 0..qcols {
        q[i * qcols + i] = 1.0;
    }
    for col in (0..k).rev() {
        let v = &reflectors[col];
        for c in 0..qcols {
            let mut d = 0.0;
            for (i, x) in v.iter().enumerate() {
                d += *x * q[(col + i) * qcols + c];
            }
            for (i, x) in v.iter().enumerate() {
                q[(col + i) * qcols + c] -= 2.0 * *x * d;
            }
        }
    }
    r.resize(qcols * n, 0.0);
    for x in &mut r {
        *x *= scale;
    }
    (q, r)
}

// Column-major cyclic, one-sided Jacobi SVD of a tall or square matrix.
// Caller transposes wide inputs and swaps U/V. No A^T A condition-number squaring.
fn tall_svd(
    a: &[f64],
    m: usize,
    n: usize,
    sweeps: usize,
) -> Result<(Vec<f64>, Vec<f64>, Vec<f64>), ()> {
    let scale = a.iter().fold(0.0_f64, |s, x| s.max(x.abs()));
    let scale = if scale == 0.0 { 1.0 } else { scale };
    let mut columns: Vec<Vec<f64>> = (0..n)
        .map(|c| (0..m).map(|r| a[r * n + c] / scale).collect())
        .collect();
    let mut vectors = vec![0.0; n * n];
    for i in 0..n {
        vectors[i * n + i] = 1.0;
    }
    // Stop when every pair's cosine |a_p . a_q| / (|a_p| |a_q|) is at most 8 eps. Demmel and Veselic (LAWN 15, 1992,
    // their one-sided Jacobi algorithm) leave tol to the user, "usually machine precision"; Drmac and Veselic (LAWN
    // 169, 2007, eq. 2.8) usually take m eps. 8 eps is Margo's choice, measured to converge on uniform random 700 x
    // 700, 1000 x 300 and 1180 x 40 (the workspace limit); outputs are f32, so the tighter test costs no visible
    // accuracy.
    // Numerically zero columns. Exactly repeated columns leave a rounding-level residual column per repeat, which
    // keeps rotating against the others, shrinking by about eps each time, until it reaches the subnormal range where
    // the relative test above can no longer pass (Drmac and Veselic, LAWN 170, 2007, section 3.2: underflow can stop
    // Jacobi converging). Inputs and outputs are f32, so a column whose norm times `scale` is below 2^-150 (half the
    // smallest f32 subnormal) gives a singular value that rounds to 0 in every case: it is set to exactly zero, takes
    // no further rotations and gets its left singular vector from the basis completion below. Graded columns above
    // that floor keep every rotation, so one-sided Jacobi's relative accuracy (Demmel and Veselic, LAWN 15) holds for
    // every singular value the output can represent.
    let floor = (2.0_f64.powi(-150) / scale).powi(2);
    let mut converged = n < 2;
    for _ in 0..sweeps {
        let mut changed = false;
        for p in 0..n {
            for q in p + 1..n {
                let alpha = dot(&columns[p], &columns[p]);
                if alpha < floor {
                    if alpha != 0.0 {
                        columns[p].fill(0.0);
                    }
                    break;
                }
                let beta = dot(&columns[q], &columns[q]);
                if beta < floor {
                    if beta != 0.0 {
                        columns[q].fill(0.0);
                    }
                    continue;
                }
                let gamma = dot(&columns[p], &columns[q]);
                if gamma == 0.0 || gamma.abs() <= 8.0 * f64::EPSILON * alpha.sqrt() * beta.sqrt() {
                    continue;
                }
                changed = true;
                let tau = (beta - alpha) / (2.0 * gamma);
                let t = 1.0_f64.copysign(tau) / (tau.abs() + tau.hypot(1.0));
                let c = 1.0 / (1.0 + t * t).sqrt();
                let s = t * c;
                for r in 0..m {
                    let x = columns[p][r];
                    let y = columns[q][r];
                    columns[p][r] = c * x - s * y;
                    columns[q][r] = s * x + c * y;
                }
                for r in 0..n {
                    let x = vectors[r * n + p];
                    let y = vectors[r * n + q];
                    vectors[r * n + p] = c * x - s * y;
                    vectors[r * n + q] = s * x + c * y;
                }
            }
        }
        if !changed {
            converged = true;
            break;
        }
    }
    if !converged {
        return Err(());
    }
    let norms: Vec<f64> = columns
        .iter()
        .map(|c| c.iter().fold(0.0_f64, |s, x| s.hypot(*x)))
        .collect();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|a, b| norms[*b].total_cmp(&norms[*a]));
    let mut u = vec![0.0; m * n];
    let mut vh = vec![0.0; n * n];
    let singular: Vec<f64> = order.iter().map(|i| norms[*i] * scale).collect();
    for (j, old) in order.iter().enumerate() {
        if norms[*old] != 0.0 {
            for r in 0..m {
                u[r * n + j] = columns[*old][r] / norms[*old];
            }
        } else {
            // Complete a basis for zero singular values without disturbing A=USV^T.
            extend_basis(&mut u, n, m, j);
        }
        for c in 0..n {
            vh[j * n + c] = vectors[c * n + *old];
        }
    }
    Ok((u, singular, vh))
}

fn transpose(a: &[f64], m: usize, n: usize) -> Vec<f64> {
    (0..m * n).map(|i| a[(i % n) * m + i / n]).collect()
}

// Fills column `filled` of the row-major m-row matrix `u` (row stride `stride`) with a unit vector orthogonal to columns
// 0..filled, which must be orthonormal. The axis e_k furthest from their span is the one whose row k has the smallest
// sum of squares (its residual is 1 - |row k|^2), so one pass over the rows picks it and only that axis is
// orthogonalized, twice (classical Gram-Schmidt with one reorthogonalization: Giraud, Langou and Rozloznik, "The loss of
// orthogonality in the Gram-Schmidt orthogonalization process", Computers and Mathematics with Applications, 2005).
// Trying every axis cost O(m^2 filled) per column, which made a rank-deficient 512 x 512 SVD spend most of a minute here.
fn extend_basis(u: &mut [f64], stride: usize, m: usize, filled: usize) {
    let mut axis = 0;
    let mut smallest = f64::INFINITY;
    for r in 0..m {
        let row = &u[r * stride..r * stride + filled];
        let norm = dot(row, row);
        if norm < smallest {
            smallest = norm;
            axis = r;
        }
    }
    let mut v = vec![0.0; m];
    v[axis] = 1.0;
    let mut d = vec![0.0; filled];
    for _ in 0..2 {
        d.fill(0.0);
        for r in 0..m {
            let row = &u[r * stride..r * stride + filled];
            for c in 0..filled {
                d[c] += row[c] * v[r];
            }
        }
        for r in 0..m {
            let row = &u[r * stride..r * stride + filled];
            v[r] -= dot(row, &d);
        }
    }
    let norm = dot(&v, &v).sqrt();
    for r in 0..m {
        u[r * stride + filled] = v[r] / norm;
    }
}

fn complete(u: &[f64], m: usize, n: usize) -> Vec<f64> {
    let mut out = vec![0.; m * m];
    for r in 0..m {
        for c in 0..n {
            out[r * m + c] = u[r * n + c];
        }
    }
    for c in n..m {
        extend_basis(&mut out, m, m, c);
    }
    out
}

fn svd(a: &[f64], m: usize, n: usize, full: bool, sweeps: usize) -> Result<Vec<f64>, ()> {
    let (u, s, vh) = if m >= n {
        let (u, s, vh) = tall_svd(a, m, n, sweeps)?;
        (if full { complete(&u, m, n) } else { u }, s, vh)
    } else {
        let (v, s, ut) = tall_svd(&transpose(a, n, m), n, m, sweeps)?;
        let v = if full { complete(&v, n, m) } else { v };
        (
            transpose(&ut, m, m),
            s,
            transpose(&v, if full { n } else { m }, n),
        )
    };
    Ok([u, s, vh].concat())
}

fn eigh(a: &[f64], n: usize, sweeps: usize) -> Result<Vec<f64>, ()> {
    let scale = a
        .iter()
        .fold(0.0_f64, |s, x| s.max(x.abs()))
        .max(f64::MIN_POSITIVE);
    let mut a: Vec<f64> = a.iter().map(|x| x / scale).collect();
    let mut v = vec![0.; n * n];
    for i in 0..n {
        v[i * n + i] = 1.;
    }
    // Demmel and Veselic's relative test |a_pq| <= tol sqrt(|a_pp a_qq|) (LAWN 15, their two-sided Jacobi), with tol 4
    // eps, Margo's choice measured to converge on uniform random symmetric 256 x 256 and 600 x 600. Their analysis is
    // for positive definite H; the absolute values extend the test to indefinite input.
    let mut converged = n < 2;
    for _ in 0..sweeps {
        let mut changed = false;
        for p in 0..n {
            for q in p + 1..n {
                let apq = a[p * n + q];
                if apq == 0.
                    || apq.abs()
                        <= f64::EPSILON * 4. * a[p * n + p].abs().sqrt() * a[q * n + q].abs().sqrt()
                {
                    continue;
                }
                changed = true;
                let tau = (a[q * n + q] - a[p * n + p]) / (2. * apq);
                let t = 1.0_f64.copysign(tau) / (tau.abs() + tau.hypot(1.));
                let c = 1. / (1. + t * t).sqrt();
                let s = t * c;
                a[p * n + p] -= t * apq;
                a[q * n + q] += t * apq;
                a[p * n + q] = 0.;
                a[q * n + p] = 0.;
                for r in 0..n {
                    if r != p && r != q {
                        let x = a[r * n + p];
                        let y = a[r * n + q];
                        a[r * n + p] = c * x - s * y;
                        a[p * n + r] = a[r * n + p];
                        a[r * n + q] = s * x + c * y;
                        a[q * n + r] = a[r * n + q];
                    }
                    let x = v[r * n + p];
                    let y = v[r * n + q];
                    v[r * n + p] = c * x - s * y;
                    v[r * n + q] = s * x + c * y;
                }
            }
        }
        if !changed {
            converged = true;
            break;
        }
    }
    if !converged {
        return Err(());
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|i, j| a[i * n + i].total_cmp(&a[j * n + j]));
    let mut out: Vec<f64> = order.iter().map(|i| a[i * n + i] * scale).collect();
    for r in 0..n {
        for i in &order {
            out.push(v[r * n + i]);
        }
    }
    Ok(out)
}

// One bounded arena per instance, no caller-supplied pointers, no retained input.
// Calls are synchronous and the TS facade copies results before another call.
use std::cell::RefCell;
thread_local! { static ARENA: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) }; }
const LIMIT: usize = 16_777_216;
#[no_mangle]
pub extern "C" fn reserve(len: usize) -> usize {
    if len > LIMIT {
        return 0;
    }
    ARENA.with(|s| {
        let mut a = s.borrow_mut();
        a.resize(len.max(1), 0.);
        a.as_mut_ptr() as usize
    })
}
#[no_mangle]
pub extern "C" fn release() {
    ARENA.with(|s| *s.borrow_mut() = Vec::new());
}
// Internal arithmetic conformance probe: callers use the same bounded arena.
#[no_mangle]
pub extern "C" fn inner_product(len: usize) -> f64 {
    ARENA.with(|s| {
        let a = s.borrow();
        if len > LIMIT / 2 || len * 2 > a.len() {
            return f64::NAN;
        }
        dot(&a[..len], &a[len..len * 2])
    })
}
#[no_mangle]
pub extern "C" fn run(
    op: usize,
    m: usize,
    n: usize,
    rhs: usize,
    full: usize,
    sweeps: usize,
) -> i32 {
    if m > 4096 || n > 4096 || rhs > 4096 || sweeps == 0 || sweeps > 1000 || op > 6 {
        return 1;
    }
    if op <= 3 || op == 6 {
        if m != n {
            return 1;
        }
    }
    let size = m * n;
    let nb = if op == 0 { n * rhs } else { 0 };
    // Bound all algorithm workspaces as well as the public arena.
    if size * 8 + m * m * 2 + n * n * 2 + nb * 2 > LIMIT {
        return 1;
    }
    ARENA.with(|s| {
        let mut arena = s.borrow_mut();
        if size + nb > arena.len() {
            return 1;
        }
        let a = &arena[..size];
        if arena[..size + nb].iter().any(|x| !x.is_finite()) {
            return 2;
        }
        if op == 3 || op == 6 {
            for i in 0..n {
                for j in 0..i {
                    if a[i * n + j] != a[j * n + i] {
                        return 3;
                    }
                }
            }
        }
        let result = match op {
            0 => solve(a, &arena[size..size + nb], n, rhs).map_err(|_| 4),
            1 => {
                let mut eye = vec![0.; size];
                for i in 0..n {
                    eye[i * n + i] = 1.;
                }
                solve(a, &eye, n, n).map_err(|_| 4)
            }
            2 => {
                let mut factors = a.to_vec();
                Ok(vec![match lu(&mut factors, n) {
                    Ok((_, sign)) => (0..n).fold(sign, |v, i| v * factors[i * n + i]),
                    Err(_) => 0.,
                }])
            }
            3 => cholesky(a, n).map_err(|_| 5),
            4 => {
                let (q, r) = qr(a, m, n, full != 0);
                Ok([q, r].concat())
            }
            5 => svd(a, m, n, full != 0, sweeps).map_err(|_| 6),
            _ => eigh(a, n, sweeps).map_err(|_| 6),
        };
        match result {
            Err(code) => code,
            Ok(out) => {
                if size + nb + out.len() > arena.len() {
                    return 1;
                }
                if out.iter().any(|x| !x.is_finite()) {
                    return 7;
                }
                arena[size + nb..size + nb + out.len()].copy_from_slice(&out);
                0
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn near(a: &[f64], b: &[f64]) {
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(b) {
            assert!((x - y).abs() < 1e-12, "{x} != {y}");
        }
    }
    fn product(a: &[f64], b: &[f64], m: usize, k: usize, n: usize) -> Vec<f64> {
        (0..m * n)
            .map(|i| (0..k).map(|j| a[(i / n) * k + j] * b[j * n + i % n]).sum())
            .collect()
    }
    #[test]
    fn pivot_solve_and_cholesky() {
        near(
            &solve(&[0., 2., 1., 3.], &[4., 7.], 2, 1).unwrap(),
            &[1., 2.],
        );
        near(&cholesky(&[4., 2., 2., 5.], 2).unwrap(), &[2., 0., 1., 2.]);
        assert!(cholesky(&[1., 2., 2., 1.], 2).is_err());
        assert!(solve(&[1., 2., 2., 4.], &[1., 2.], 2, 1).is_err());
    }
    #[test]
    fn qr_reconstruction_and_orthogonality() {
        let a = [1., 2., 3., 4., 5., 7.];
        let (q, r) = qr(&a, 3, 2, false);
        near(&product(&q, &r, 3, 2, 2), &a);
        for i in 0..2 {
            for j in 0..2 {
                let d: f64 = (0..3).map(|k| q[k * 2 + i] * q[k * 2 + j]).sum();
                near(&[d], &[if i == j { 1. } else { 0. }]);
            }
        }
    }
    #[test]
    fn svd_floor_keeps_graded_values_and_zeroes_only_f32_zero_columns() {
        // Graded: 1e-30 is far above the 2^-150 floor and keeps full relative accuracy.
        let (_, s, _) = tall_svd(&[1., 0.5e-30, 0.5, 1e-30], 2, 2, 100).unwrap();
        let exact = 0.75e-30 / (1.25_f64).sqrt();
        assert!(
            (s[1] - exact).abs() <= 1e-12 * exact,
            "{} vs {}",
            s[1],
            exact
        );
        // A column below the floor gives exactly zero, never a nonconvergence.
        let (_, s, _) = tall_svd(&[1., 1e-47, 0., 0.], 2, 2, 100).unwrap();
        assert_eq!(s[1], 0.0);
    }
    #[test]
    fn svd_reconstruction_and_orthogonality() {
        for a in [[3., 0., 0., 2., 0., 0.], [1., 2., 2., 4., 3., 6.], [0.; 6]] {
            let (u, s, vh) = tall_svd(&a, 3, 2, 100).unwrap();
            let us: Vec<f64> = u.iter().enumerate().map(|(i, v)| v * s[i % 2]).collect();
            near(&product(&us, &vh, 3, 2, 2), &a);
            assert!(s[0] >= s[1] && s[1] >= 0.);
            for i in 0..2 {
                for j in 0..2 {
                    let d: f64 = (0..3).map(|k| u[k * 2 + i] * u[k * 2 + j]).sum();
                    near(&[d], &[if i == j { 1. } else { 0. }]);
                }
            }
        }
    }
}
