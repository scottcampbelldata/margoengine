use crate::grid::{Bucket, Grid};
use crate::vector::{Vec3, ZERO, add, cross, dot, floor, length, norm2, scale, sqrt, sub};
use crate::{
    Boundary, Particle, Reaction, Solid, clip_solid, item, item_mut, rebuild, record_impulse,
};

const CUBIC: f64 = 8.0 / core::f64::consts::PI;

#[repr(C)]
pub struct Settings {
    gravity: Vec3,
    lower: Vec3,
    upper: Vec3,
    support: f64,
    rest: f64,
    radius: f64,
    spacing: f64,
    density_tolerance: f64,
    divergence_tolerance: f64,
    viscosity: f64,
    friction: f64,
    density_iterations: f64,
    divergence_iterations: f64,
    walls: f64,
    warm_start: f64,
    viscosity_iterations: f64,
    wall_pressure: f64,
    wall_lattice: f64,
    liquid_vapor: f64,
    solid_liquid: f64,
    solid_vapor: f64,
}

#[repr(C)]
pub struct Work {
    change: Vec3,
    inverse: f64,
    lambda: f64,
    multiplier: f64,
    saved_density: f64,
    saved_divergence: f64,
    error: f64,
    residual: Vec3,
    direction: Vec3,
    product: Vec3,
    rhs: Vec3,
    diagonal: Vec3,
    wall_gradient: Vec3,
    wall_drag: WallDrag,
    surface_slope: f64,
    solid_slope: f64,
}

#[inline]
fn cubic(q: f64) -> f64 {
    if q < 0.5 {
        CUBIC * (1.0 - 6.0 * q * q * (1.0 - q))
    } else {
        let k = (1.0 - q).max(0.0);
        2.0 * CUBIC * k * k * k
    }
}

#[inline]
fn gradient(r: Vec3, q: f64) -> Vec3 {
    let factor = if q < 0.5 {
        CUBIC * (18.0 * q - 12.0)
    } else {
        let k = 1.0 - q;
        -6.0 * CUBIC * k * k / q
    };
    scale(r, factor)
}

struct Neighborhood<'a, 'grid> {
    points: &'a [Particle],
    boundary: &'a [Boundary],
    grid: &'a Grid<'grid>,
    inverse_support: f64,
    inverse_rest_volume: f64,
    boundary_volume_scale: f64,
}

impl Neighborhood<'_, '_> {
    #[inline]
    fn around(
        &self,
        i: usize,
        position: Vec3,
        mut use_neighbor: impl FnMut(usize, f64, Vec3, f64),
    ) {
        self.grid.nearby(position, |j| {
            if i == j {
                return;
            }
            let (neighbor, volume) = if j < self.points.len() {
                let p = item(self.points, j);
                (p.position, p.mass * self.inverse_rest_volume)
            } else {
                let b = item(self.boundary, j - self.points.len());
                (b.position, b.volume * self.boundary_volume_scale)
            };
            let r = scale(sub(position, neighbor), self.inverse_support);
            let q2 = norm2(r);
            if q2 < 1.0 {
                let q = sqrt(q2);
                use_neighbor(
                    j,
                    q,
                    scale(gradient(r, q), volume * self.inverse_support),
                    volume * cubic(q),
                );
            }
        });
    }
}

#[inline]
fn neighborhood<'a, 'grid>(
    points: &'a [Particle],
    boundary: &'a [Boundary],
    grid: &'a Grid<'grid>,
    settings: &Settings,
    support: f64,
) -> Neighborhood<'a, 'grid> {
    let inverse_support = 1.0 / support;
    let scale = settings.support / support;
    Neighborhood {
        points,
        boundary,
        grid,
        inverse_support,
        inverse_rest_volume: inverse_support * inverse_support * inverse_support / settings.rest,
        boundary_volume_scale: scale * scale * scale,
    }
}

#[inline]
fn visit(
    i: usize,
    points: &[Particle],
    boundary: &[Boundary],
    grid: &Grid<'_>,
    settings: &Settings,
    use_neighbor: impl FnMut(usize, f64, Vec3, f64),
) {
    neighborhood(points, boundary, grid, settings, settings.support).around(
        i,
        item(points, i).position,
        use_neighbor,
    );
}
#[inline]
fn body_velocity(object: &Solid, at: Vec3) -> Vec3 {
    add(object.linear, cross(object.angular, sub(at, object.centre)))
}

#[inline]
fn half_space(q: f64) -> (f64, f64) {
    if q >= 1.0 {
        return (0.0, 0.0);
    }
    if q < 0.0 {
        let (volume, gradient) = half_space(-q);
        return (1.0 - volume, gradient);
    }
    if q >= 0.5 {
        let u = 1.0 - q;
        let u2 = u * u;
        let u4 = u2 * u2;
        return (
            32.0 * u4 * u * (0.05 - u / 30.0),
            -32.0 * u4 * (0.25 - 0.2 * u),
        );
    }
    let q2 = q * q;
    let q4 = q2 * q2;
    let q5 = q4 * q;
    let moment1 = 7.0 / 80.0 - (0.5 * q2 - 1.5 * q4 + 1.2 * q5);
    let moment2 = 1.0 / 32.0 - (q2 * q / 3.0 - 1.2 * q5 + q5 * q);
    (16.0 * (moment2 - q * moment1), -16.0 * moment1)
}

fn wall_terms(position: Vec3, settings: &Settings, support: f64) -> (f64, Vec3) {
    let mask = settings.walls as u32;
    let mut fluid = 1.0;
    let mut gradient = ZERO;
    for axis in 0..3 {
        let mut miss = 1.0;
        let mut slope = 0.0;
        if (mask & (1 << (2 * axis))) != 0 {
            let q = (position[axis] - settings.lower[axis]) / support;
            let (density, derivative) = half_space(q);
            miss -= density;
            slope += derivative;
        }
        if (mask & (1 << (2 * axis + 1))) != 0 {
            let q = (settings.upper[axis] - position[axis]) / support;
            let (density, derivative) = half_space(q);
            miss -= density;
            slope -= derivative;
        }
        // Opposite half-spaces are disjoint. At right-angle edges the product
        // removes shared kernel volume approximately, keeping the gradient consistent.
        gradient = scale(gradient, miss);
        gradient[axis] = fluid * slope / support;
        fluid *= miss;
    }
    (1.0 - fluid, gradient)
}

#[repr(C)]
struct WallDrag {
    diagonal: Vec3,
    cross: Vec3,
}

impl WallDrag {
    const ZERO: Self = Self {
        diagonal: ZERO,
        cross: ZERO,
    };

    #[inline]
    fn multiply(&self, v: Vec3) -> Vec3 {
        [
            self.diagonal[0] * v[0] + self.cross[0] * v[1] + self.cross[1] * v[2],
            self.cross[0] * v[0] + self.diagonal[1] * v[1] + self.cross[2] * v[2],
            self.cross[1] * v[0] + self.cross[2] * v[1] + self.diagonal[2] * v[2],
        ]
    }

    #[inline]
    fn add_sample(&mut self, normal: Vec3, scale: f64) {
        for axis in 0..3 {
            self.diagonal[axis] += scale * normal[axis] * normal[axis];
        }
        self.cross[0] += scale * normal[0] * normal[1];
        self.cross[1] += scale * normal[0] * normal[2];
        self.cross[2] += scale * normal[1] * normal[2];
    }
}

fn integrate_pair(f: impl Fn(f64) -> (f64, f64), lower: f64, upper: f64) -> (f64, f64) {
    let centre = 0.5 * (lower + upper);
    let radius = 0.5 * (upper - lower);
    let c = f(centre);
    let a0 = f(centre - radius * 0.538_469_310_105_683_1);
    let a1 = f(centre + radius * 0.538_469_310_105_683_1);
    let b0 = f(centre - radius * 0.906_179_845_938_664);
    let b1 = f(centre + radius * 0.906_179_845_938_664);
    let sum = |c, a0, a1, b0, b1| {
        radius
            * (0.568_888_888_888_888_9 * c
                + 0.478_628_670_499_366_5 * (a0 + a1)
                + 0.236_926_885_056_189_1 * (b0 + b1))
    };
    (
        sum(c.0, a0.0, a1.0, b0.0, b1.0),
        sum(c.1, a0.1, a1.1, b0.1, b1.1),
    )
}

fn half_space_drag(q: f64, support: f64) -> (f64, f64) {
    if q >= 1.0 {
        return (0.0, 0.0);
    }
    let q = q.max(0.0);
    let radial = |r: f64| {
        let x = q / r;
        let angle = (1.0 - x) / 3.0;
        let slope = if r < 0.5 {
            r * (12.0 - 18.0 * r)
        } else {
            6.0 * (1.0 - r) * (1.0 - r)
        };
        let size = 10.0 * core::f64::consts::PI * CUBIC * slope * r * r * r
            / ((r * r + 0.01) * support * support);
        // Angular moments of the wall-facing cone, per tangential direction
        // and in the face-normal direction, respectively.
        (
            size * angle * (1.0 - x) * (2.0 + x),
            size * 2.0 * angle * (1.0 + x + x * x),
        )
    };
    let (mut tangent, mut normal) = integrate_pair(radial, q.max(0.5), 1.0);
    if q < 0.5 {
        let (t, n) = integrate_pair(radial, q, 0.5);
        tangent += t;
        normal += n;
    }
    (tangent, normal)
}

fn continuum_drag(position: Vec3, settings: &Settings) -> WallDrag {
    let mut drag = WallDrag::ZERO;
    if settings.viscosity == 0.0 {
        return drag;
    }
    let h = settings.support;
    let mask = settings.walls as u32;
    for axis in 0..3 {
        for side in 0..2 {
            if (mask & (1 << (2 * axis + side))) == 0 {
                continue;
            }
            let distance = if side == 0 {
                position[axis] - settings.lower[axis]
            } else {
                settings.upper[axis] - position[axis]
            };
            let (tangent, normal) = half_space_drag(distance / h, h);
            drag.diagonal = add(drag.diagonal, [tangent; 3]);
            drag.diagonal[axis] += normal - tangent;
        }
    }
    drag
}

struct PlanarLattice {
    spacing: Vec3,
    cells: [i64; 3],
    volume: f64,
}

impl PlanarLattice {
    fn new(settings: &Settings) -> Option<Self> {
        if settings.wall_lattice == 0.0 || settings.walls == 0.0 {
            return None;
        }
        let span = sub(settings.upper, settings.lower);
        let dimensions = span.map(|width| floor(width / settings.spacing + 0.5).max(1.0));
        let spacing = [
            span[0] / dimensions[0],
            span[1] / dimensions[1],
            span[2] / dimensions[2],
        ];
        // The finite sum resolves the discrete exclusion correction for short
        // kernels. At larger support-to-spacing ratios use the continuous limit.
        if spacing.iter().any(|d| *d < 0.25 * settings.support)
            || dimensions.iter().any(|d| *d > 4_503_599_627_370_496.0)
        {
            return None;
        }
        let [dx, dy, dz] = spacing.map(|size| size / settings.support);
        Some(Self {
            spacing,
            cells: dimensions.map(|d| d as i64),
            volume: dx * dy * dz,
        })
    }

    fn at(&self, p: Vec3, settings: &Settings, evaluations: &mut f64) -> (f64, Vec3, WallDrag) {
        let mask = settings.walls as u32;
        let h = settings.support;
        let low_distance = sub(p, settings.lower);
        let high_distance = sub(settings.upper, p);
        let near = (0..3).any(|axis| {
            ((mask & (1 << (2 * axis))) != 0 && low_distance[axis] < h)
                || ((mask & (1 << (2 * axis + 1))) != 0 && high_distance[axis] < h)
        });
        if !near {
            return (0.0, ZERO, WallDrag::ZERO);
        }
        // A coordinate beyond the representable local lattice uses the continuous half-space.
        if low_distance
            .iter()
            .chain(high_distance.iter())
            .any(|d| !d.is_finite())
        {
            let (density, gradient) = wall_terms(p, settings, h);
            return (density, gradient, continuum_drag(p, settings));
        }
        let centre = [
            low_distance[0] / self.spacing[0],
            low_distance[1] / self.spacing[1],
            low_distance[2] / self.spacing[2],
        ];
        if centre.iter().any(|x| x.abs() > 4_503_599_627_370_496.0) {
            let (density, gradient) = wall_terms(p, settings, h);
            return (density, gradient, continuum_drag(p, settings));
        }
        let low = [0, 1, 2].map(|i| floor(centre[i] - h / self.spacing[i]) as i64);
        let high = [0, 1, 2].map(|i| floor(centre[i] + h / self.spacing[i]) as i64);
        let outside = |axis: usize, cell: i64| {
            (cell < 0 && (mask & (1 << (2 * axis))) != 0)
                || (cell >= self.cells[axis] && (mask & (1 << (2 * axis + 1))) != 0)
        };
        let inverse_h = 1.0 / h;
        let mut weight = 0.0;
        let mut derivative = ZERO;
        let mut drag = WallDrag::ZERO;
        for z in low[2]..=high[2] {
            for y in low[1]..=high[1] {
                let row = outside(2, z) || outside(1, y);
                for x in low[0]..=high[0] {
                    if row || outside(0, x) {
                        let r = [x, y, z].map(|cell| cell as f64 + 0.5);
                        let q = [0, 1, 2].map(|i| (centre[i] - r[i]) * self.spacing[i] * inverse_h);
                        let distance2 = norm2(q);
                        if distance2 < 1.0 {
                            *evaluations += 1.0;
                            let distance = sqrt(distance2);
                            weight += self.volume * cubic(distance);
                            let grad = scale(gradient(q, distance), self.volume * inverse_h);
                            derivative = add(derivative, grad);
                            if settings.viscosity > 0.0 && distance > 0.0 {
                                let strength =
                                    10.0 * distance * length(grad) * inverse_h / (distance2 + 0.01);
                                drag.add_sample(scale(q, 1.0 / distance), strength);
                            }
                        }
                    }
                }
            }
        }
        (weight, derivative, drag)
    }
}

fn prepare(
    points: &mut [Particle],
    work: &mut [Work],
    boundary: &[Boundary],
    grid: &Grid<'_>,
    settings: &Settings,
    evaluations: &mut f64,
) {
    let inverse_h = 1.0 / settings.support;
    let mass_scale = inverse_h * inverse_h * inverse_h / settings.rest;
    let lattice = PlanarLattice::new(settings);
    for i in 0..points.len() {
        let particle = item(points, i);
        let (wall_density, wall_gradient, wall_drag) = if settings.wall_pressure == 0.0 {
            (0.0, ZERO, WallDrag::ZERO)
        } else if let Some(samples) = &lattice {
            samples.at(particle.position, settings, evaluations)
        } else {
            let (density, gradient) = wall_terms(particle.position, settings, settings.support);
            (
                density,
                gradient,
                continuum_drag(particle.position, settings),
            )
        };
        let mut density = particle.mass * mass_scale * CUBIC + wall_density;
        let mut centre = wall_gradient;
        let mut diagonal = 0.0;
        visit(i, points, boundary, grid, settings, |j, _, grad, weight| {
            *evaluations += 1.0;
            density += weight;
            centre = add(centre, grad);
            // Boundary particles have prescribed velocity during the liquid solve.
            if j < points.len() {
                diagonal += norm2(grad);
            }
        });
        let denominator = diagonal + norm2(centre);
        let w = item_mut(work, i);
        w.wall_gradient = wall_gradient;
        w.wall_drag = wall_drag;
        w.inverse = if denominator > 0.0 {
            1.0 / denominator
        } else {
            0.0
        };
        item_mut(points, i).density = density * settings.rest;
    }
}

fn pressure_error(
    points: &[Particle],
    work: &mut [Work],
    boundary: &[Boundary],
    shapes: &[Solid],
    grid: &Grid<'_>,
    settings: &Settings,
    dt: f64,
    density: bool,
    evaluations: &mut f64,
) -> (f64, f64) {
    let mut compression = 0.0;
    let mut complementarity = 0.0;
    for (i, (p, w)) in points.iter().zip(work.iter_mut()).enumerate() {
        let mut derivative = dot(p.velocity, w.wall_gradient);
        visit(i, points, boundary, grid, settings, |j, _, grad, _| {
            *evaluations += 1.0;
            let velocity = if j < points.len() {
                item(points, j).velocity
            } else {
                let b = item(boundary, j - points.len());
                body_velocity(item(shapes, b.shape as usize), b.position)
            };
            derivative += dot(sub(p.velocity, velocity), grad);
        });
        // Eqs. (7–12): solve only compression at a free surface. Store both residuals
        // as normalized rates, so one symmetric velocity update serves either solve.
        let bias = if density {
            (p.density / settings.rest - 1.0) / dt
        } else {
            0.0
        };
        w.error = bias + derivative;
        compression += w.error.max(0.0);
        // A positive existing multiplier must also relax when it over-corrects.
        complementarity += if w.multiplier > 0.0 {
            w.error.abs()
        } else {
            w.error.max(0.0)
        };
    }
    let inverse_count = 1.0 / points.len().max(1) as f64;
    (compression * inverse_count, complementarity * inverse_count)
}

fn pressure_velocity(
    points: &mut [Particle],
    work: &mut [Work],
    boundary: &[Boundary],
    shapes: &[Solid],
    reactions: &mut [Reaction],
    trial: &mut [Reaction],
    grid: &Grid<'_>,
    settings: &Settings,
    evaluations: &mut f64,
) -> f64 {
    trial.fill([0.0; 6]);
    for (i, p) in points.iter().enumerate() {
        let lambda = item(work, i).lambda;
        let mut change = scale(item(work, i).wall_gradient, -lambda);
        visit(i, points, boundary, grid, settings, |j, _, grad, _| {
            *evaluations += 1.0;
            if j < points.len() {
                change = sub(change, scale(grad, lambda + item(work, j).lambda));
            } else {
                let b = item(boundary, j - points.len());
                let dv = scale(grad, -lambda);
                change = add(change, dv);
                record_impulse(
                    trial,
                    item(shapes, b.shape as usize),
                    b.position,
                    scale(dv, -p.mass),
                );
            }
        });
        item_mut(work, i).change = change;
    }
    // The pressure dual is quadratic for this fixed neighborhood, with
    // directional gradient lambda·error and curvature |Dᵀlambda|².
    // Constrain the line to the non-negative multiplier segment.
    let (descent, curvature) = work.iter().fold((0.0, 0.0), |(slope, norm), w| {
        (slope + w.lambda * w.error, norm + norm2(w.change))
    });
    let fraction = if curvature > 0.0 {
        (descent / curvature).clamp(0.0, 1.0)
    } else {
        0.0
    };
    for (p, w) in points.iter_mut().zip(work.iter()) {
        p.velocity = add(p.velocity, scale(w.change, fraction));
    }
    for (out, impulse) in reactions.iter_mut().zip(trial.iter()) {
        for axis in 0..6 {
            out[axis] += fraction * impulse[axis];
        }
    }
    fraction
}

fn pressure(
    points: &mut [Particle],
    work: &mut [Work],
    boundary: &[Boundary],
    shapes: &[Solid],
    reactions: &mut [Reaction],
    trial: &mut [Reaction],
    grid: &Grid<'_>,
    settings: &Settings,
    dt: f64,
    density: bool,
    evaluations: &mut f64,
) -> (f64, f64) {
    for w in work.iter_mut() {
        w.multiplier = 0.0;
    }
    let mut error = pressure_error(
        points,
        work,
        boundary,
        shapes,
        grid,
        settings,
        dt,
        density,
        evaluations,
    );
    let (iterations, tolerance) = if density {
        (settings.density_iterations, settings.density_tolerance / dt)
    } else {
        (
            settings.divergence_iterations,
            settings.divergence_tolerance,
        )
    };
    let mut warm = false;
    for w in work.iter_mut() {
        w.lambda = if error.1 > tolerance && settings.warm_start > 0.0 && w.error > 0.0 {
            let saved = if density {
                w.saved_density / dt
            } else {
                w.saved_divergence
            };
            (0.5 * saved).min(w.error * w.inverse)
        } else {
            0.0
        };
        warm |= w.lambda > 0.0;
    }
    let fraction = if warm {
        let fraction = pressure_velocity(
            points,
            work,
            boundary,
            shapes,
            reactions,
            trial,
            grid,
            settings,
            evaluations,
        );
        fraction
    } else {
        0.0
    };
    for w in work.iter_mut() {
        w.multiplier = fraction * w.lambda;
    }
    if fraction > 0.0 {
        error = pressure_error(
            points,
            work,
            boundary,
            shapes,
            grid,
            settings,
            dt,
            density,
            evaluations,
        );
    }
    let mut used = 0.0;
    for _ in 0..iterations as usize {
        if error.1 <= tolerance {
            break;
        }
        for w in work.iter_mut() {
            w.lambda = (w.error * w.inverse).max(-w.multiplier);
        }
        let fraction = pressure_velocity(
            points,
            work,
            boundary,
            shapes,
            reactions,
            trial,
            grid,
            settings,
            evaluations,
        );
        if fraction == 0.0 {
            break;
        }
        for w in work.iter_mut() {
            w.multiplier = (w.multiplier + fraction * w.lambda).max(0.0);
        }
        used += 1.0;
        error = pressure_error(
            points,
            work,
            boundary,
            shapes,
            grid,
            settings,
            dt,
            density,
            evaluations,
        );
    }
    for w in work.iter_mut() {
        if density {
            w.saved_density = w.multiplier * dt;
        } else {
            w.saved_divergence = w.multiplier;
        }
    }
    (used, error.0)
}

fn remove_inward(p: &mut Particle, normal: Vec3, surface_velocity: Vec3, friction: f64) -> Vec3 {
    let relative = sub(p.velocity, surface_velocity);
    let inward = dot(relative, normal);
    if inward >= 0.0 {
        return ZERO;
    }
    let tangent = sub(relative, scale(normal, inward));
    let change = sub(scale(normal, -inward), scale(tangent, friction));
    p.velocity = add(p.velocity, change);
    scale(change, -p.mass)
}

fn contacts(settings: &Settings, p: &mut Particle, shapes: &[Solid], out: &mut [Reaction]) -> f64 {
    let mut normal_impulse = 0.0;
    let walls = settings.walls as u32;
    for axis in 0..3 {
        let low = settings.lower[axis] + settings.radius;
        let high = settings.upper[axis] - settings.radius;
        let mut normal = ZERO;
        if (walls & (1 << (2 * axis))) != 0 && p.position[axis] < low {
            p.position[axis] = low;
            normal[axis] = 1.0;
        }
        if (walls & (1 << (2 * axis + 1))) != 0 && p.position[axis] > high {
            p.position[axis] = high;
            normal[axis] = -1.0;
        }
        normal_impulse += dot(normal, remove_inward(p, normal, ZERO, settings.friction)).abs();
    }
    for shape in shapes {
        if let Some((normal, depth)) = clip_solid(shape, p.position, settings.radius) {
            p.position = add(p.position, scale(normal, depth));
            let at = sub(p.position, scale(normal, settings.radius));
            let impulse = remove_inward(p, normal, body_velocity(shape, at), settings.friction);
            normal_impulse += dot(normal, impulse).abs();
            record_impulse(out, shape, at, impulse);
        }
    }
    normal_impulse
}

#[inline]
fn diffusion(
    points: &[Particle],
    i: usize,
    j: usize,
    settings: &Settings,
    dt: f64,
    q: f64,
    grad: Vec3,
) -> (Vec3, f64) {
    let norm = length(grad);
    if norm == 0.0 {
        return (ZERO, 0.0);
    }
    let density_i = item(points, i).density;
    let density_j = if j < points.len() {
        item(points, j).density
    } else {
        density_i
    };
    let volume = (settings.rest / density_i) * (settings.rest / density_j);
    // Weiler et al. 2018, Eq. (7–12). The central rank-one diffusion conserves rigid rotation.
    let weight =
        10.0 * settings.viscosity * dt * q * norm * volume / (settings.support * (q * q + 0.01));
    (scale(grad, 1.0 / norm), weight)
}

#[inline]
fn along(direction: Vec3, value: Vec3, weight: f64) -> Vec3 {
    scale(direction, weight * dot(value, direction))
}

#[inline]
fn precondition(v: Vec3, diagonal: Vec3) -> Vec3 {
    [v[0] / diagonal[0], v[1] / diagonal[1], v[2] / diagonal[2]]
}

fn diffuse(
    points: &mut [Particle],
    work: &mut [Work],
    boundary: &[Boundary],
    shapes: &[Solid],
    reactions: &mut [Reaction],
    grid: &Grid<'_>,
    settings: &Settings,
    dt: f64,
    evaluations: &mut f64,
) -> f64 {
    if settings.viscosity == 0.0 {
        return 0.0;
    }
    let mut squared = 0.0;
    for (i, p) in points.iter().enumerate() {
        let w = item_mut(work, i);
        w.rhs = p.velocity;
        let wall_scale = settings.rest / p.density;
        let drag = settings.viscosity * dt * wall_scale * wall_scale;
        w.residual = scale(w.wall_drag.multiply(p.velocity), -drag);
        w.diagonal = add([1.0; 3], scale(w.wall_drag.diagonal, drag));
        visit(i, points, boundary, grid, settings, |j, q, grad, _| {
            *evaluations += 1.0;
            let (axis, weight) = diffusion(points, i, j, settings, dt, q, grad);
            let v = if j < points.len() {
                item(points, j).velocity
            } else {
                let b = item(boundary, j - points.len());
                body_velocity(item(shapes, b.shape as usize), b.position)
            };
            for k in 0..3 {
                w.diagonal[k] += weight * axis[k] * axis[k];
            }
            w.residual = add(w.residual, along(axis, sub(v, p.velocity), weight));
        });
        w.direction = precondition(w.residual, w.diagonal);
        squared += dot(w.direction, w.residual);
    }
    let target = squared * 1e-20;
    let mut used = 0.0;
    for _ in 0..settings.viscosity_iterations as usize {
        if squared <= target {
            break;
        }
        let mut denominator = 0.0;
        for (i, w) in work.iter().enumerate() {
            let wall_scale = settings.rest / item(points, i).density;
            let drag = settings.viscosity * dt * wall_scale * wall_scale;
            let mut product = add(w.direction, scale(w.wall_drag.multiply(w.direction), drag));
            visit(i, points, boundary, grid, settings, |j, q, grad, _| {
                *evaluations += 1.0;
                let (axis, weight) = diffusion(points, i, j, settings, dt, q, grad);
                let neighbor = if j < points.len() {
                    item(work, j).direction
                } else {
                    ZERO
                };
                product = add(product, along(axis, sub(w.direction, neighbor), weight));
            });
            denominator += dot(w.direction, product);
            item_mut(points, i).velocity = product;
        }
        if denominator <= 0.0 {
            break;
        }
        let step = squared / denominator;
        let mut next = 0.0;
        for (p, w) in points.iter_mut().zip(work.iter_mut()) {
            w.rhs = add(w.rhs, scale(w.direction, step));
            w.residual = sub(w.residual, scale(p.velocity, step));
            w.product = precondition(w.residual, w.diagonal);
            next += dot(w.product, w.residual);
        }
        for w in work.iter_mut() {
            w.direction = add(w.product, scale(w.direction, next / squared));
        }
        squared = next;
        used += 1.0;
    }
    for (p, w) in points.iter_mut().zip(work.iter()) {
        p.velocity = w.rhs;
    }
    for (i, p) in points.iter().enumerate() {
        visit(i, points, boundary, grid, settings, |j, q, grad, _| {
            *evaluations += 1.0;
            if j >= points.len() {
                let b = item(boundary, j - points.len());
                let object = item(shapes, b.shape as usize);
                let relative = sub(p.velocity, body_velocity(object, b.position));
                let (axis, weight) = diffusion(points, i, j, settings, dt, q, grad);
                record_impulse(
                    reactions,
                    object,
                    b.position,
                    along(axis, relative, p.mass * weight),
                );
            }
        });
    }
    used
}
#[inline]
fn interface_slope(contribution: f64) -> f64 {
    contribution.max(0.0) / sqrt(contribution * contribution + 0.05 * 0.05)
}

fn capillary(
    points: &mut [Particle],
    work: &mut [Work],
    boundary: &[Boundary],
    boundary_color: &mut [f64],
    shapes: &[Solid],
    reactions: &mut [Reaction],
    grid: &Grid<'_>,
    settings: &Settings,
    dt: f64,
    evaluations: &mut f64,
) {
    let support = 3.0 * settings.spacing;
    let neighbors = neighborhood(points, boundary, grid, settings, support);
    let area = core::f64::consts::FRAC_PI_4 * settings.spacing * settings.spacing;

    // Probst and Teschner, Eqs. (8), (10), and (12). Vertex energy uses the
    // positive free surface residue and the kernel fraction occupied by the solid.
    for (i, (p, w)) in points.iter().zip(work.iter_mut()).enumerate() {
        let mut fluid = p.mass * neighbors.inverse_rest_volume * CUBIC;
        let mut solid = 0.0;
        neighbors.around(i, p.position, |j, _, _, weight| {
            *evaluations += 1.0;
            if j < points.len() {
                fluid += weight;
            } else {
                solid += weight;
            }
        });
        let (plane, derivative) = wall_terms(p.position, settings, support);
        w.surface_slope = settings.liquid_vapor * interface_slope(1.0 - fluid - solid - plane);
        w.solid_slope = settings.solid_liquid * interface_slope(solid + plane);
        let wall_slope = settings.solid_vapor * interface_slope(plane);
        w.change = scale(
            derivative,
            (w.surface_slope - w.solid_slope + wall_slope) * area * dt,
        );
    }
    for (index, sample) in boundary.iter().enumerate() {
        if sample.volume == 0.0 {
            *item_mut(boundary_color, index) = 0.0;
            continue;
        }
        let mut fluid = 0.0;
        let mut solid = sample.volume * neighbors.boundary_volume_scale * CUBIC;
        neighbors.around(points.len() + index, sample.position, |j, _, _, weight| {
            *evaluations += 1.0;
            if j < points.len() {
                fluid += weight;
            } else {
                solid += weight;
            }
        });
        *item_mut(boundary_color, index) = settings.solid_vapor
            * interface_slope(1.0 - fluid - solid)
            - settings.solid_liquid * interface_slope(fluid);
    }

    // Negative derivative of the surface energy, Eq. (11). Pair forces are
    // central. The force on any rigid boundary sample is recorded at that point.
    for (i, p) in points.iter().enumerate() {
        let w = item(work, i);
        let mut impulse = w.change;
        let fluid_volume = p.mass * neighbors.inverse_rest_volume;
        neighbors.around(i, p.position, |j, _, grad, _| {
            *evaluations += 1.0;
            if j < points.len() {
                let color = w.surface_slope + item(work, j).surface_slope;
                impulse = add(impulse, scale(grad, color * area * dt));
            } else {
                let index = j - points.len();
                let b = item(boundary, index);
                let solid_volume = b.volume * neighbors.boundary_volume_scale;
                let color = w.surface_slope - w.solid_slope
                    + *item(boundary_color, index) * fluid_volume / solid_volume;
                let contact = scale(grad, color * area * dt);
                impulse = add(impulse, contact);
                record_impulse(
                    reactions,
                    item(shapes, b.shape as usize),
                    b.position,
                    scale(contact, -1.0),
                );
            }
        });
        item_mut(work, i).change = impulse;
    }
    for (p, w) in points.iter_mut().zip(work.iter()) {
        p.velocity = add(p.velocity, scale(w.change, 1.0 / p.mass));
    }
}

fn bound_extent(object: &Solid) -> f64 {
    if object.active >= 2.0 {
        object.half[0] + object.half[1]
    } else {
        length(object.half)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn solve_dfsph(
    particles: *mut Particle,
    count: usize,
    work: *mut Work,
    buckets: *mut Bucket,
    bucket_count: usize,
    next: *mut u32,
    used: *mut u32,
    boundary: *const Boundary,
    boundary_count: usize,
    shapes: *const Solid,
    shape_count: usize,
    reactions: *mut Reaction,
    trial: *mut Reaction,
    body_count: usize,
    settings: *const Settings,
    stats: *mut [f64; 10],
    dt: f64,
    boundary_color: *mut f64,
) -> u32 {
    let (points, work, boundary, shapes, reactions, trial, settings, stats) = unsafe {
        (
            core::slice::from_raw_parts_mut(particles, count),
            core::slice::from_raw_parts_mut(work, count),
            core::slice::from_raw_parts(boundary, boundary_count),
            core::slice::from_raw_parts(shapes, shape_count),
            core::slice::from_raw_parts_mut(reactions, body_count),
            core::slice::from_raw_parts_mut(trial, body_count),
            &*settings,
            &mut *stats,
        )
    };
    let surface = settings
        .liquid_vapor
        .max(settings.solid_liquid)
        .max(settings.solid_vapor);
    let grid_radius = if surface > 0.0 {
        settings.support.max(3.0 * settings.spacing)
    } else {
        settings.support
    };
    let boundary_color = unsafe {
        core::slice::from_raw_parts_mut(
            boundary_color,
            if surface > 0.0 { boundary_count } else { 0 },
        )
    };
    let mut grid = unsafe {
        Grid::new(
            core::slice::from_raw_parts_mut(buckets, bucket_count),
            core::slice::from_raw_parts_mut(next, count + boundary_count),
            core::slice::from_raw_parts_mut(used, count + boundary_count),
            1.0 / grid_radius,
        )
    };
    reactions.fill([0.0; 6]);
    let mut bounds_speed = 0.0_f64;
    for object in shapes.iter().filter(|o| o.active > 0.0) {
        bounds_speed =
            bounds_speed.max(length(object.linear) + length(object.angular) * bound_extent(object));
    }
    let travel = 0.4 * settings.spacing.min(2.0 * settings.radius);
    let gravity = length(settings.gravity);
    let capillary_step = if surface > 0.0 {
        let inverse_wave_number = settings.spacing / core::f64::consts::PI;
        sqrt(
            settings.rest * inverse_wave_number * inverse_wave_number * inverse_wave_number
                / surface,
        )
    } else {
        dt
    };
    let mut remaining = dt;
    let mut substeps = 0.0;
    let mut density_rounds = 0.0;
    let mut divergence_rounds = 0.0;
    let mut viscosity_rounds = 0.0;
    let mut evaluations = 0.0;
    let mut density_error = 0.0;
    let mut divergence_error = 0.0;
    let mut normal_impulse = 0.0;
    rebuild(&mut grid, points, boundary);
    prepare(points, work, boundary, &grid, settings, &mut evaluations);
    while remaining > 0.0 && !points.is_empty() {
        let drift = points
            .iter()
            .fold(bounds_speed, |top, p| top.max(length(p.velocity)));
        let speed = drift + remaining * gravity;
        let step = if speed > 0.0 {
            remaining.min(travel / speed)
        } else {
            remaining
        };
        let step = step.min(capillary_step);
        let following = remaining - step;
        if !speed.is_finite() || following == remaining || dt / step >= u32::MAX as f64 {
            grid.clear();
            return 1;
        }
        for p in points.iter_mut() {
            p.velocity = add(p.velocity, scale(settings.gravity, step));
        }
        if surface > 0.0 {
            capillary(
                points,
                work,
                boundary,
                boundary_color,
                shapes,
                reactions,
                &grid,
                settings,
                step,
                &mut evaluations,
            );
        }
        viscosity_rounds += diffuse(
            points,
            work,
            boundary,
            shapes,
            reactions,
            &grid,
            settings,
            step,
            &mut evaluations,
        );
        let (rounds, error) = pressure(
            points,
            work,
            boundary,
            shapes,
            reactions,
            trial,
            &grid,
            settings,
            step,
            true,
            &mut evaluations,
        );
        density_rounds += rounds;
        density_error = error * step;
        for p in points.iter_mut() {
            p.position = add(p.position, scale(p.velocity, step));
            normal_impulse += contacts(settings, p, shapes, reactions);
        }
        rebuild(&mut grid, points, boundary);
        prepare(points, work, boundary, &grid, settings, &mut evaluations);
        let (rounds, error) = pressure(
            points,
            work,
            boundary,
            shapes,
            reactions,
            trial,
            &grid,
            settings,
            step,
            false,
            &mut evaluations,
        );
        divergence_rounds += rounds;
        divergence_error = error;
        substeps += 1.0;
        remaining = following;
    }
    let max_speed = points
        .iter()
        .fold(0.0_f64, |top, p| top.max(length(p.velocity)));
    if !points.iter().all(|p| {
        p.position
            .iter()
            .chain(p.velocity.iter())
            .all(|v| v.is_finite())
            && p.density.is_finite()
    }) {
        grid.clear();
        return 1;
    }
    *stats = [
        count as f64,
        substeps,
        density_rounds,
        divergence_rounds,
        evaluations,
        density_error,
        max_speed,
        divergence_error,
        viscosity_rounds,
        normal_impulse,
    ];
    grid.clear();
    0
}
