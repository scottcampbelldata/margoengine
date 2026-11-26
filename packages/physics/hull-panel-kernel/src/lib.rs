mod complex;
mod depth;
mod geometry;
mod green;

use std::f64::consts::TAU;

use complex::Complex;
use geometry::{Panel, Vector};
use green::Green;

const AXES: usize = 6;
const MATRIX: usize = AXES * AXES;
const MAX_PANELS: usize = 768;
const MAX_HEADINGS: usize = 64;

fn coordinates(words: &[f64]) -> Vector {
    Vector(words[0], words[1], words[2])
}

/// A single partial-pivot factorization applied to the radiation and incident-wave columns.
fn solve(matrix: &mut [Complex], right: &mut [Complex], n: usize, columns: usize) -> bool {
    for k in 0..n {
        let mut pivot = k;
        for row in k + 1..n {
            if matrix[row * n + k].squared() > matrix[pivot * n + k].squared() {
                pivot = row;
            }
        }
        if pivot != k {
            for col in k..n {
                matrix.swap(k * n + col, pivot * n + col);
            }
            for col in 0..columns {
                right.swap(k * columns + col, pivot * columns + col);
            }
        }
        let inverse = Complex::ONE / matrix[k * n + k];
        if !inverse.re.is_finite() || !inverse.im.is_finite() || inverse.squared() > 1e24 {
            return false;
        }
        for row in k + 1..n {
            let factor = matrix[row * n + k] * inverse;
            for col in k + 1..n {
                let reduction = factor * matrix[k * n + col];
                matrix[row * n + col] -= reduction;
            }
            for col in 0..columns {
                let reduction = factor * right[k * columns + col];
                right[row * columns + col] -= reduction;
            }
        }
    }
    for row in (0..n).rev() {
        let inverse = Complex::ONE / matrix[row * n + row];
        for col in 0..columns {
            let mut value = right[row * columns + col];
            for known in row + 1..n {
                value -= matrix[row * n + known] * right[known * columns + col];
            }
            right[row * columns + col] = value * inverse;
        }
    }
    true
}

fn incident(panel: &Panel, direction: (f64, f64), k: f64, depth: f64) -> Complex {
    let (x, z) = direction;
    let centre = panel.centre;
    let horizontal = panel.normal.0 * x + panel.normal.2 * z;
    let phase = k * (x * centre.0 + z * centre.2);
    // The normalized Airy potential, with its amplitude at the free surface set to one.
    let upper = (k * centre.1).exp();
    let vertical = if depth.is_finite() {
        (-k * (centre.1 + 2.0 * depth)).exp()
    } else {
        0.0
    };
    let denominator = if depth.is_finite() {
        1.0 + (-2.0 * k * depth).exp()
    } else {
        1.0
    };
    Complex::new(
        k * panel.normal.1 * (upper - vertical),
        k * horizontal * (upper + vertical),
    ) * Complex::new(0.0, phase).exp()
        * (1.0 / denominator)
}

/// Assemble the boundary integral at one frequency. Matrices use body axes and moments about `reference`.
/// The pressure factors (density, frequency, gravity) are applied once in the caller.
fn coefficients(
    vertices: &[f64],
    reference: Vector,
    wavenumber: f64,
    depth: f64,
    directions: &[f64],
    output: &mut [f64],
) -> bool {
    let n = vertices.len() / 9;
    let mut panels = Vec::with_capacity(n);
    let mut extent = 0.0_f64;
    for row in vertices.chunks_exact(9) {
        let points = [
            coordinates(row),
            coordinates(&row[3..]),
            coordinates(&row[6..]),
        ];
        let Some(panel) = Panel::new(points, reference) else {
            return false;
        };
        extent = extent.max((panel.centre - reference).length());
        panels.push(panel);
    }
    let green = Green::new(wavenumber, depth, 2.0 * extent);
    let headings: Vec<_> = directions
        .iter()
        .map(|heading| {
            let (sin, cos) = heading.sin_cos();
            (cos, sin)
        })
        .collect();
    let columns = AXES + headings.len();
    let mut matrix = vec![Complex::ZERO; n * n];
    let mut right = vec![Complex::ZERO; n * columns];
    let mut normal_velocity = Vec::with_capacity(n * headings.len());
    for panel in &panels {
        normal_velocity.extend(
            headings
                .iter()
                .map(|heading| -incident(panel, *heading, wavenumber, depth)),
        );
    }
    for (i, target) in panels.iter().enumerate() {
        for (j, source) in panels.iter().enumerate() {
            let (potential, derivative) = green.panel(target.centre, source, i == j);
            matrix[i * n + j] = derivative + Complex::real(if i == j { TAU } else { 0.0 });
            for axis in 0..AXES {
                right[i * columns + axis] -= potential * source.motion[axis];
            }
            for h in 0..headings.len() {
                right[i * columns + AXES + h] -=
                    potential * normal_velocity[j * headings.len() + h];
            }
        }
    }
    if !solve(&mut matrix, &mut right, n, columns) {
        return false;
    }
    output.fill(0.0);
    for (i, panel) in panels.iter().enumerate() {
        for row in 0..AXES {
            let weight = -panel.area * panel.motion[row];
            for col in 0..AXES {
                let phi = right[i * columns + col];
                output[row * AXES + col] += weight * phi.re;
                output[MATRIX + row * AXES + col] += weight * phi.im;
            }
            for h in 0..headings.len() {
                let phi = right[i * columns + AXES + h];
                let at = 2 * (MATRIX + h * AXES + row);
                output[at] += weight * phi.re;
                output[at + 1] += weight * phi.im;
            }
        }
    }
    // The continuous generalized radiation pairs are reciprocal. Average the collocation estimates.
    for offset in [0, MATRIX] {
        for row in 0..AXES {
            for col in 0..row {
                let forward = offset + row * AXES + col;
                let backward = offset + col * AXES + row;
                let average = (output[forward] + output[backward]) * 0.5;
                output[forward] = average;
                output[backward] = average;
            }
        }
    }
    output.iter().all(|value| value.is_finite())
}

#[unsafe(no_mangle)]
pub extern "C" fn hull_panel_allocate(words: usize) -> *mut f64 {
    let buffer = vec![0.0; words].into_boxed_slice();
    Box::into_raw(buffer).cast::<f64>()
}

/// # Safety
/// `pointer` must be the active allocation returned by `hull_panel_allocate(words)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hull_panel_free(pointer: *mut f64, words: usize) {
    let slice = std::ptr::slice_from_raw_parts_mut(pointer, words);
    drop(unsafe { Box::from_raw(slice) });
}

/// # Safety
/// Buffers must be valid Wasm ranges of the specified sizes and the result must be disjoint from both inputs.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hull_panel_coefficients(
    points: *const f64,
    panels: usize,
    centre_x: f64,
    centre_y: f64,
    centre_z: f64,
    wavenumber: f64,
    depth: f64,
    directions: *const f64,
    headings: usize,
    output: *mut f64,
) -> bool {
    if panels == 0 || panels > MAX_PANELS || headings > MAX_HEADINGS || !wavenumber.is_finite() {
        return false;
    }
    let vertices = unsafe { std::slice::from_raw_parts(points, panels * 9) };
    let heading_angles = unsafe { std::slice::from_raw_parts(directions, headings) };
    let result = unsafe { std::slice::from_raw_parts_mut(output, 2 * (MATRIX + AXES * headings)) };
    coefficients(
        vertices,
        Vector(centre_x, centre_y, centre_z),
        wavenumber,
        depth,
        heading_angles,
        result,
    )
}

#[cfg(test)]
mod tests {
    use std::f64::consts::FRAC_PI_2;

    use super::*;

    fn hemisphere(meridians: usize, rings: usize) -> Vec<f64> {
        let mut points = Vec::new();
        let mut panels = Vec::new();
        for j in 0..rings {
            let (sin, cos) = (j as f64 * FRAC_PI_2 / rings as f64).sin_cos();
            for i in 0..meridians {
                let (z, x) = (i as f64 * TAU / meridians as f64).sin_cos();
                points.push([cos * x, -sin, cos * z]);
            }
        }
        points.push([0.0, -1.0, 0.0]);
        for j in 0..rings {
            for i in 0..meridians {
                let a = j * meridians + i;
                let b = j * meridians + (i + 1) % meridians;
                if j == rings - 1 {
                    for index in [a, b, meridians * rings] {
                        panels.extend(points[index]);
                    }
                } else {
                    for index in [a, b, b + meridians, a, b + meridians, a + meridians] {
                        panels.extend(points[index]);
                    }
                }
            }
        }
        panels
    }

    fn solve_hemisphere(vertices: &[f64], k: f64, depth: f64, headings: &[f64]) -> Vec<f64> {
        let mut result = vec![0.0; 2 * (MATRIX + AXES * headings.len())];
        assert!(coefficients(
            vertices,
            Vector(0.0, 0.0, 0.0),
            k,
            depth,
            headings,
            &mut result
        ));
        result
    }

    #[test]
    fn follows_hulme_hemisphere_tables_in_surge_and_heave() {
        let coarse = hemisphere(20, 4);
        let fine = hemisphere(32, 8);
        let volume = TAU / 3.0;
        // A / (rho V), B / (rho omega V), Hulme (1982), Table 1 heave and Table 2 surge.
        for (k, expected) in [
            (0.2, [0.5515, 0.0082, 0.7938, 0.2793]),
            (0.5, [0.6439, 0.0987, 0.5861, 0.3391]),
            (1.0, [0.5740, 0.3535, 0.4284, 0.2484]),
            (2.0, [0.2493, 0.3424, 0.3884, 0.1031]),
        ] {
            let normalized = |result: &[f64]| {
                [result[0], result[MATRIX], result[7], result[MATRIX + 7]]
                    .map(|value| value / volume)
            };
            let result = normalized(&solve_hemisphere(
                &fine,
                k,
                f64::INFINITY,
                &[0.0, FRAC_PI_2],
            ));
            let previous = normalized(&solve_hemisphere(&coarse, k, f64::INFINITY, &[]));
            println!("ka={k}: coarse={previous:?}; fine={result:?}");
            for i in 0..expected.len() {
                let error = (result[i] - expected[i]).abs();
                assert!(
                    error < 0.04 * expected[i],
                    "ka={k}, coefficient={i}, got {}, want {}",
                    result[i],
                    expected[i]
                );
                assert!(error < (previous[i] - expected[i]).abs());
            }
        }
    }

    #[test]
    fn directional_diffraction_rotates_with_incident_heading() {
        let mesh = hemisphere(24, 5);
        let result = solve_hemisphere(&mesh, 1.0, f64::INFINITY, &[0.0, FRAC_PI_2]);
        let close = |a: f64, b: f64| assert!((a - b).abs() < 1e-10, "{a} vs {b}");
        for component in 0..2 {
            let a = 2 * MATRIX + component;
            let b = a + 2 * AXES;
            close(result[a], result[b + 4]);
            close(result[a + 4], -result[b]);
            close(result[a + 2], result[b + 2]);
        }
        assert!(result[2 * MATRIX].abs() > 0.1);
        let high = solve_hemisphere(&mesh, -1.0, f64::INFINITY, &[]);
        assert!(high[0] > 0.26 * TAU / 3.0);
        assert!(high[MATRIX..].iter().all(|value| *value == 0.0));
    }
}
