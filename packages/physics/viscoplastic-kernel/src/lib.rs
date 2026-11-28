#![no_std]
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_floor, f64x2_mul, f64x2_splat, f64x2_sqrt, unreachable,
};
use margoengine_physics_kernel_common::pinned::pow;

const MAX_SUBSTEPS: u32 = 4096;

struct ArenaOnly;
unsafe impl core::alloc::GlobalAlloc for ArenaOnly {
    unsafe fn alloc(&self, _: core::alloc::Layout) -> *mut u8 {
        core::ptr::null_mut()
    }
    unsafe fn dealloc(&self, _: *mut u8, _: core::alloc::Layout) {}
}
#[global_allocator]
static NO_HEAP: ArenaOnly = ArenaOnly;

#[panic_handler]
fn abort(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Vector {
    x: f64,
    y: f64,
    z: f64,
}

impl Vector {
    const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };

    #[inline(always)]
    const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    fn add(self, rhs: Self) -> Self {
        Self::new(self.x + rhs.x, self.y + rhs.y, self.z + rhs.z)
    }

    fn sub(self, rhs: Self) -> Self {
        Self::new(self.x - rhs.x, self.y - rhs.y, self.z - rhs.z)
    }

    fn scale(self, scale: f64) -> Self {
        Self::new(self.x * scale, self.y * scale, self.z * scale)
    }

    fn dot(self, rhs: Self) -> f64 {
        let p = f64x2_mul(f64x2(self.x, self.y), f64x2(rhs.x, rhs.y));
        f64x2_extract_lane::<0>(p) + f64x2_extract_lane::<1>(p) + self.z * rhs.z
    }

    fn cross(self, rhs: Self) -> Self {
        Self::new(
            self.y * rhs.z - self.z * rhs.y,
            self.z * rhs.x - self.x * rhs.z,
            self.x * rhs.y - self.y * rhs.x,
        )
    }

    fn length(self) -> f64 {
        let square = self.dot(self);
        if square.is_normal() || !self.finite() {
            return sqrt(square);
        }
        let scale = self.max_abs();
        if scale == 0.0 {
            return 0.0;
        }
        let scaled = Self::new(self.x / scale, self.y / scale, self.z / scale);
        scale * sqrt(scaled.dot(scaled))
    }

    fn max_abs(self) -> f64 {
        self.x.abs().max(self.y.abs()).max(self.z.abs())
    }

    fn one_norm(self) -> f64 {
        self.x.abs() + self.y.abs() + self.z.abs()
    }

    fn divide(self, divisor: f64) -> Self {
        let reciprocal = 1.0 / divisor;
        if reciprocal.is_finite() {
            self.scale(reciprocal)
        } else {
            Self::new(self.x / divisor, self.y / divisor, self.z / divisor)
        }
    }

    fn finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }
}

fn sqrt(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(value)))
}

fn floor(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(value)))
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Matrix {
    a: Vector,
    b: Vector,
    c: Vector,
}

impl Matrix {
    const ZERO: Self = Self {
        a: Vector::ZERO,
        b: Vector::ZERO,
        c: Vector::ZERO,
    };
    const ID: Self = Self {
        a: Vector::new(1.0, 0.0, 0.0),
        b: Vector::new(0.0, 1.0, 0.0),
        c: Vector::new(0.0, 0.0, 1.0),
    };

    fn add(self, rhs: Self) -> Self {
        Self {
            a: self.a.add(rhs.a),
            b: self.b.add(rhs.b),
            c: self.c.add(rhs.c),
        }
    }

    fn sub(self, rhs: Self) -> Self {
        Self {
            a: self.a.sub(rhs.a),
            b: self.b.sub(rhs.b),
            c: self.c.sub(rhs.c),
        }
    }

    fn scale(self, scale: f64) -> Self {
        Self {
            a: self.a.scale(scale),
            b: self.b.scale(scale),
            c: self.c.scale(scale),
        }
    }

    fn outer(a: Vector, b: Vector) -> Self {
        Self {
            a: b.scale(a.x),
            b: b.scale(a.y),
            c: b.scale(a.z),
        }
    }

    fn vector(self, v: Vector) -> Vector {
        Vector::new(self.a.dot(v), self.b.dot(v), self.c.dot(v))
    }

    fn transpose(self) -> Self {
        Self {
            a: Vector::new(self.a.x, self.b.x, self.c.x),
            b: Vector::new(self.a.y, self.b.y, self.c.y),
            c: Vector::new(self.a.z, self.b.z, self.c.z),
        }
    }

    fn product(self, rhs: Self) -> Self {
        let t = rhs.transpose();
        Self {
            a: t.vector(self.a),
            b: t.vector(self.b),
            c: t.vector(self.c),
        }
    }

    fn trace(self) -> f64 {
        self.a.x + self.b.y + self.c.z
    }

    fn det(self) -> f64 {
        self.a.dot(self.b.cross(self.c))
    }

    fn norm(self) -> f64 {
        sqrt(self.a.dot(self.a) + self.b.dot(self.b) + self.c.dot(self.c))
    }

    fn finite(self) -> bool {
        self.a.finite() && self.b.finite() && self.c.finite()
    }

    fn isochoric(self) -> Option<Self> {
        let det = self.det();
        if det > 0.0 && det.is_finite() {
            Some(self.scale(pow(det, -1.0 / 3.0)))
        } else {
            None
        }
    }
}

#[repr(C)]
struct Grain {
    position: Vector,
    velocity: Vector,
    reference: f64,
    ratio: f64,
    elastic: Matrix,
    affine: Matrix,
    plastic: f64,
}

#[repr(C)]
struct Node {
    mass: f64,
    velocity: Vector,
}

#[repr(C)]
struct Material {
    density: f64,
    bulk: f64,
    shear: f64,
    yield_stress: f64,
    consistency: f64,
    exponent: f64,
    solvent: f64,
    friction: f64,
    walls: f64,
    spacing: f64,
    origin: Vector,
    gravity: Vector,
}

#[repr(C)]
struct Viscous {
    search: Vector,
    residual: Vector,
    product: Vector,
    inverse_diagonal: f64,
}

#[repr(C)]
struct BedNode {
    h: f64,
    n: Vector,
}

#[derive(Clone, Copy)]
struct Domain {
    shape: GridSize,
    spacing: f64,
    min: Vector,
    max: Vector,
}

#[derive(Clone, Copy)]
struct GridSize {
    x: u32,
    y: u32,
    z: u32,
}

impl Domain {
    fn index(self, x: u32, y: u32, z: u32) -> usize {
        x as usize
            + (self.shape.x as usize + 3) * (y as usize + (self.shape.y as usize + 3) * z as usize)
    }

    fn bed_index(self, x: u32, z: u32) -> usize {
        x as usize + (self.shape.x as usize + 3) * z as usize
    }

    fn position(self, x: u32, y: u32, z: u32) -> Vector {
        self.min.add(
            Vector::new(f64::from(x) - 1.0, f64::from(y) - 1.0, f64::from(z) - 1.0)
                .scale(self.spacing),
        )
    }
}

struct Stencil {
    start: u32,
    w: [f64; 3],
    dw: [f64; 3],
}

impl Stencil {
    fn of(x: f64, inv_dx: f64) -> Self {
        let lower = floor(x - 0.5);
        let f = x - lower;
        let a = 1.5 - f;
        let b = f - 1.0;
        let c = f - 0.5;
        Self {
            start: (lower + 1.0) as u32,
            w: [0.5 * a * a, 0.75 - b * b, 0.5 * c * c],
            dw: [-a * inv_dx, -2.0 * b * inv_dx, c * inv_dx],
        }
    }
}

struct Neighbor {
    index: usize,
    position: Vector,
    weight: f64,
    gradient: Vector,
}

fn neighbors(domain: Domain, p: Vector, mut visit: impl FnMut(Neighbor)) -> bool {
    let inv_dx = 1.0 / domain.spacing;
    let q = p.sub(domain.min).scale(inv_dx);
    // A quadratic stencil extends to the two ghost nodes at either end.
    // Check the local coordinate before the saturating float-to-index cast.
    let size = domain.shape;
    if !(q.x >= 0.0
        && q.x < f64::from(size.x) + 0.5
        && q.y >= 0.0
        && q.y < f64::from(size.y) + 0.5
        && q.z >= 0.0
        && q.z < f64::from(size.z) + 0.5)
    {
        return false;
    }
    let sx = Stencil::of(q.x, inv_dx);
    let sy = Stencil::of(q.y, inv_dx);
    let sz = Stencil::of(q.z, inv_dx);
    for (k, (&wz, &dz)) in sz.w.iter().zip(sz.dw.iter()).enumerate() {
        let z = sz.start + k as u32;
        for (j, (&wy, &dy)) in sy.w.iter().zip(sy.dw.iter()).enumerate() {
            let y = sy.start + j as u32;
            for (i, (&wx, &dx)) in sx.w.iter().zip(sx.dw.iter()).enumerate() {
                let x = sx.start + i as u32;
                visit(Neighbor {
                    index: domain.index(x, y, z),
                    position: domain.position(x, y, z),
                    weight: wx * wy * wz,
                    gradient: Vector::new(dx * wy * wz, wx * dy * wz, wx * wy * dz),
                });
            }
        }
    }
    true
}

fn compressive_term(ratio: f64, bulk: f64) -> f64 {
    0.5 * bulk * (ratio - 1.0) * (ratio + 1.0)
}

impl Material {
    fn wave_speed(&self) -> f64 {
        let square = (self.bulk + 4.0 / 3.0 * self.shear) / self.density;
        if square.is_normal() {
            return sqrt(square);
        }
        // Compute square roots before forming ratios at the ends of the f64 range.
        let root_density = sqrt(self.density);
        Vector::new(
            sqrt(self.bulk) / root_density,
            sqrt(4.0 / 3.0) * (sqrt(self.shear) / root_density),
            0.0,
        )
        .length()
    }
}

fn cfl_step(spacing: f64, wave_speed: f64, speed: f64, gravity: f64, remaining: f64) -> f64 {
    let kick = remaining * gravity;
    let sum = wave_speed + speed + kick;
    if sum.is_finite() {
        return 0.4 * spacing / sum;
    }
    let scale = wave_speed.max(speed).max(gravity);
    (0.4 * spacing / scale) / (wave_speed / scale + speed / scale + remaining * (gravity / scale))
}

fn relax(trial: f64, threshold: f64, eta: f64, exponent: f64, time_shear: f64) -> f64 {
    if trial <= threshold {
        return trial;
    }
    let excess = trial - threshold;
    if eta == 0.0 {
        return threshold;
    }
    if exponent == 1.0 {
        return threshold + excess / (1.0 + time_shear / eta);
    }
    let inverse = 1.0 / exponent;
    let mut low = 0.0;
    let mut high = excess;
    for _ in 0..53 {
        let middle = low + (high - low) * 0.5;
        if time_shear * pow(middle / eta, inverse) >= excess - middle {
            high = middle;
        } else {
            low = middle;
        }
    }
    threshold + low + (high - low) * 0.5
}

#[derive(Clone, Copy)]
struct Interval {
    low: f64,
    high: f64,
}

impl Interval {
    #[inline(never)]
    fn quotient(value: f64, positive: f64) -> Self {
        let rounded = value / positive;
        Self {
            low: rounded.next_down(),
            high: rounded.next_up(),
        }
    }

    #[inline(never)]
    fn add(self, rhs: Self) -> Self {
        Self {
            low: (self.low + rhs.low).next_down(),
            high: (self.high + rhs.high).next_up(),
        }
    }

    #[inline(never)]
    fn sub(self, rhs: Self) -> Self {
        Self {
            low: (self.low - rhs.high).next_down(),
            high: (self.high - rhs.low).next_up(),
        }
    }

    #[inline(never)]
    fn product(self, rhs: Self) -> Self {
        let a = self.low * rhs.low;
        let b = self.low * rhs.high;
        let c = self.high * rhs.low;
        let d = self.high * rhs.high;
        Self {
            low: a.min(b).min(c).min(d).next_down(),
            high: a.max(b).max(c).max(d).next_up(),
        }
    }
}

fn positive_bernstein([a, b, c, d]: [f64; 4], splits_left: u32) -> bool {
    if !(a > 0.0 && d > 0.0) {
        return false;
    }
    if b > 0.0 && c > 0.0 {
        return true;
    }
    if splits_left == 0 {
        return false;
    }
    let middle = |left: f64, right: f64| ((left + right).next_down() * 0.5).next_down();
    let ab = middle(a, b);
    let bc = middle(b, c);
    let cd = middle(c, d);
    let abc = middle(ab, bc);
    let bcd = middle(bc, cd);
    let abcd = middle(abc, bcd);
    positive_bernstein([a, ab, abc, abcd], splits_left - 1)
        && positive_bernstein([abcd, bcd, cd, d], splits_left - 1)
}

// det((1-s)I + s(I+A)) has Bernstein coefficients given by the average
// determinants with zero, one, two, or three rows from I+A. Positive lower
// bounds on the subdivided coefficients certify the whole trajectory.
// Farouki (2012), doi:10.1016/j.cagd.2012.03.001.
#[inline(never)]
fn regular_large_increment(a: Matrix) -> bool {
    let scale = 1.0_f64
        .max(a.a.max_abs())
        .max(a.b.max_abs())
        .max(a.c.max_abs());
    let q = |value| Interval::quotient(value, scale);
    let id = q(1.0);
    let (xx, xy, xz) = (id.add(q(a.a.x)), q(a.a.y), q(a.a.z));
    let (yx, yy, yz) = (q(a.b.x), id.add(q(a.b.y)), q(a.b.z));
    let (zx, zy, zz) = (q(a.c.x), q(a.c.y), id.add(q(a.c.z)));
    let yz_minor = yy.product(zz).sub(yz.product(zy));
    let xz_minor = xx.product(zz).sub(xz.product(zx));
    let xy_minor = xx.product(yy).sub(xy.product(yx));
    let third = Interval::quotient(1.0, 3.0);
    let id2 = id.product(id);
    let b0 = id2.product(id);
    let b1 = id2.product(xx.add(yy).add(zz)).product(third);
    let b2 = id
        .product(xy_minor.add(xz_minor).add(yz_minor))
        .product(third);
    let b3 = xx
        .product(yz_minor)
        .sub(xy.product(yx.product(zz).sub(yz.product(zx))))
        .add(xz.product(yx.product(zy).sub(yy.product(zx))));
    positive_bernstein([b0.low, b1.low, b2.low, b3.low], f64::MANTISSA_DIGITS)
}

fn constitutive(point: &mut Grain, gradient: Matrix, material: &Material, dt: f64) -> bool {
    let increment = gradient.scale(dt);
    let f = Matrix::ID.add(increment);
    let ratio = point.ratio * f.det();
    if !ratio.is_finite() || ratio <= 0.0 {
        return false;
    }
    // The induced infinity norm bounds the spectral radius. Reserve enough
    // roundoff for the two additions in each row before using this fast proof.
    let bound = increment
        .a
        .one_norm()
        .max(increment.b.one_norm())
        .max(increment.c.one_norm());
    if bound >= 1.0 - 4.0 * f64::EPSILON && !regular_large_increment(increment) {
        return false;
    }
    let Some(projected) = f.product(point.elastic).product(f.transpose()).isochoric() else {
        return false;
    };
    let mean = projected.trace() / 3.0;
    let iso = Matrix::ID.scale(mean);
    let dev = projected.sub(iso);
    let stress = dev.norm() * material.shear * core::f64::consts::FRAC_1_SQRT_2;
    let relaxation = dt * material.shear * mean;
    if !(stress.is_finite() && mean > 0.0 && mean.is_finite() && relaxation.is_finite()) {
        return false;
    }
    let returned = relax(
        stress,
        material.yield_stress,
        material.consistency,
        material.exponent,
        relaxation,
    );
    let corrected = if returned < stress {
        let Some(fixed) = iso.add(dev.scale(returned / stress)).isochoric() else {
            return false;
        };
        point.plastic += (stress - returned) / (material.shear * mean);
        fixed
    } else {
        projected
    };
    if !(corrected.finite() && point.plastic.is_finite() && returned.is_finite()) {
        return false;
    }
    point.ratio = ratio;
    point.elastic = corrected;
    true
}

fn resolve_contact(velocity: Vector, normal: Vector, friction: f64) -> Vector {
    let inward = velocity.dot(normal);
    if inward >= 0.0 {
        return velocity;
    }
    let tangent = velocity.sub(normal.scale(inward));
    let speed = tangent.length();
    if speed == 0.0 {
        tangent
    } else {
        tangent.scale((1.0 + friction * inward / speed).max(0.0))
    }
}

fn close_grid_wall(v: Vector, p: Vector, domain: Domain, mask: u32, friction: f64) -> Vector {
    let mut out = v;
    if (mask & 1) != 0 && p.x <= domain.min.x {
        out = resolve_contact(out, Vector::new(1.0, 0.0, 0.0), friction);
    }
    if (mask & 2) != 0 && p.x >= domain.max.x {
        out = resolve_contact(out, Vector::new(-1.0, 0.0, 0.0), friction);
    }
    if (mask & 4) != 0 && p.y <= domain.min.y {
        out = resolve_contact(out, Vector::new(0.0, 1.0, 0.0), friction);
    }
    if (mask & 8) != 0 && p.y >= domain.max.y {
        out = resolve_contact(out, Vector::new(0.0, -1.0, 0.0), friction);
    }
    if (mask & 16) != 0 && p.z <= domain.min.z {
        out = resolve_contact(out, Vector::new(0.0, 0.0, 1.0), friction);
    }
    if (mask & 32) != 0 && p.z >= domain.max.z {
        out = resolve_contact(out, Vector::new(0.0, 0.0, -1.0), friction);
    }
    out
}

struct Flow {
    domain: Domain,
    model: *const Material,
    points: *mut Grain,
    count: usize,
    nodes: *mut Node,
    active: *mut u32,
    diffusion: *mut Viscous,
    bed: *const BedNode,
    escaped: f64,
    escaped_reference: f64,
}

impl Flow {
    unsafe fn p2g(&self, dt: f64, material: &Material) -> Option<usize> {
        let domain = self.domain;
        let mut occupied = 0;
        for i in 0..self.count {
            let p = &*self.points.add(i);
            if p.reference == 0.0 {
                continue;
            }
            let mass = p.reference * material.density;
            let iso = p.elastic.trace() / 3.0;
            let stress = p
                .elastic
                .sub(Matrix::ID.scale(iso))
                .scale(material.shear)
                .add(Matrix::ID.scale(compressive_term(p.ratio, material.bulk)));
            if !(mass > 0.0 && mass.is_finite() && stress.finite()) {
                return None;
            }
            let in_grid = neighbors(domain, p.position, |sample| {
                if sample.weight == 0.0 {
                    return;
                }
                let m = sample.weight * mass;
                if m == 0.0 {
                    return;
                }
                let g = &mut *self.nodes.add(sample.index);
                if g.mass == 0.0 {
                    self.active.add(occupied).write(sample.index as u32);
                    occupied += 1;
                }
                let transport = p
                    .velocity
                    .add(p.affine.vector(sample.position.sub(p.position)));
                let force = stress.vector(sample.gradient).scale(-dt * p.reference);
                g.mass += m;
                g.velocity = g.velocity.add(transport.scale(m)).add(force);
            });
            if !in_grid {
                return None;
            }
        }
        Some(occupied)
    }

    unsafe fn normalize(&self, occupied: usize, gravity: Vector) -> bool {
        for i in 0..occupied {
            let node = &mut *self.nodes.add(*self.active.add(i) as usize);
            if !(node.mass.is_finite() && node.mass > 0.0) {
                return false;
            }
            node.velocity = node.velocity.divide(node.mass).add(gravity);
            if !node.velocity.finite() {
                return false;
            }
        }
        true
    }

    unsafe fn viscous_row(
        &self,
        key: usize,
        factor: f64,
        resident_mass: f64,
        get: impl Fn(usize) -> Vector,
    ) -> (Vector, f64) {
        let nx = self.domain.shape.x as usize + 3;
        let ny = self.domain.shape.y as usize + 3;
        let nz = self.domain.shape.z as usize + 3;
        let slab = nx * ny;
        let z = key.checked_div(slab).unwrap_or_else(|| unreachable());
        let yz = key - z * slab;
        let y = yz.checked_div(nx).unwrap_or_else(|| unreachable());
        let x = yz - y * nx;
        let mass = (*self.nodes.add(key)).mass;
        let value = get(key);
        let mut result = value.scale(mass);
        let mut diagonal = mass;
        let mut face = |other: usize| {
            let other_mass = (*self.nodes.add(other)).mass;
            if other_mass > 0.0 {
                let w = factor * (mass.min(other_mass) / resident_mass).min(1.0);
                result = result.add(value.sub(get(other)).scale(w));
                diagonal += w;
            }
        };
        if x > 0 {
            face(key - 1);
        }
        if x + 1 < nx {
            face(key + 1);
        }
        if y > 0 {
            face(key - nx);
        }
        if y + 1 < ny {
            face(key + nx);
        }
        if z > 0 {
            face(key - slab);
        }
        if z + 1 < nz {
            face(key + slab);
        }
        (result, diagonal)
    }

    unsafe fn implicit_viscosity(&self, occupied: usize, material: &Material, dt: f64) -> bool {
        if self.diffusion.is_null() {
            return true;
        }
        let h = self.domain.spacing;
        let factor = material.solvent * dt * h;
        let resident_mass = material.density * h * h * h;
        if !(factor.is_finite() && resident_mass > 0.0 && resident_mass.is_finite()) {
            return false;
        }
        let mut rhs_norm = 0.0;
        let mut residual_norm = 0.0;
        let mut inner = 0.0;
        for i in 0..occupied {
            let key = *self.active.add(i) as usize;
            let node = &*self.nodes.add(key);
            let rhs = node.velocity.scale(node.mass);
            let (ap, diagonal) = self.viscous_row(key, factor, resident_mass, |j| {
                (*self.nodes.add(j)).velocity
            });
            let residual = rhs.sub(ap);
            let inverse_diagonal = 1.0 / diagonal;
            let search = residual.scale(inverse_diagonal);
            if !(inverse_diagonal > 0.0 && inverse_diagonal.is_finite() && search.finite()) {
                return false;
            }
            self.diffusion.add(key).write(Viscous {
                search,
                residual,
                product: Vector::ZERO,
                inverse_diagonal,
            });
            rhs_norm += rhs.dot(rhs);
            residual_norm += residual.dot(residual);
            inner += residual.dot(search);
        }
        let target = rhs_norm * 1e-22;
        if !(rhs_norm.is_finite() && residual_norm.is_finite() && inner.is_finite()) {
            return false;
        }
        if residual_norm <= target {
            return true;
        }
        // This graph is symmetric positive definite on occupied nodes. The free
        // surface omits missing neighbours instead of damping against empty air.
        for _ in 0..3 * occupied {
            let mut denominator = 0.0;
            for i in 0..occupied {
                let key = *self.active.add(i) as usize;
                let (product, _) = self.viscous_row(key, factor, resident_mass, |j| {
                    (*self.diffusion.add(j)).search
                });
                let work = &mut *self.diffusion.add(key);
                work.product = product;
                denominator += work.search.dot(product);
            }
            if !(denominator > 0.0 && denominator.is_finite()) {
                return false;
            }
            let alpha = inner / denominator;
            if !(alpha > 0.0 && alpha.is_finite()) {
                return false;
            }
            let mut next_inner = 0.0;
            let mut norm = 0.0;
            for i in 0..occupied {
                let key = *self.active.add(i) as usize;
                let work = &mut *self.diffusion.add(key);
                let node = &mut *self.nodes.add(key);
                node.velocity = node.velocity.add(work.search.scale(alpha));
                work.residual = work.residual.sub(work.product.scale(alpha));
                if !node.velocity.finite() {
                    return false;
                }
                let square = work.residual.dot(work.residual);
                norm += square;
                next_inner += square * work.inverse_diagonal;
            }
            if !(norm.is_finite() && next_inner.is_finite()) {
                return false;
            }
            if norm <= target {
                return true;
            }
            let beta = next_inner / inner;
            if !beta.is_finite() {
                return false;
            }
            inner = next_inner;
            for i in 0..occupied {
                let work = &mut *self.diffusion.add(*self.active.add(i) as usize);
                work.search = work
                    .residual
                    .scale(work.inverse_diagonal)
                    .add(work.search.scale(beta));
            }
        }
        false
    }

    unsafe fn contacts(&self, occupied: usize, material: &Material) {
        let domain = self.domain;
        let nx = domain.shape.x as usize + 3;
        let ny = domain.shape.y as usize + 3;
        let horizontal = nx * ny;
        let mask = material.walls as u32;
        for i in 0..occupied {
            let key = *self.active.add(i) as usize;
            let z = key.checked_div(horizontal).unwrap_or_else(|| unreachable());
            let rest = key - z * horizontal;
            let y = rest.checked_div(nx).unwrap_or_else(|| unreachable());
            let x = rest - y * nx;
            let pos = domain.position(x as u32, y as u32, z as u32);
            let node = &mut *self.nodes.add(key);
            let mut velocity = node.velocity;
            velocity = close_grid_wall(velocity, pos, domain, mask, material.friction);
            if !self.bed.is_null() {
                let b = &*self.bed.add(domain.bed_index(x as u32, z as u32));
                if pos.y < b.h {
                    velocity = resolve_contact(velocity, b.n, material.friction);
                }
            }
            node.velocity = velocity;
        }
    }

    unsafe fn material_step(&mut self, material: &Material, dt: f64) -> bool {
        let domain = self.domain;
        let dx2 = domain.spacing * domain.spacing;
        let mask = material.walls as u32;
        for i in 0..self.count {
            let p = &mut *self.points.add(i);
            if p.reference == 0.0 {
                continue;
            }
            let mut velocity = Vector::ZERO;
            let mut moments = Matrix::ZERO;
            let mut gradient = Matrix::ZERO;
            let in_grid = neighbors(domain, p.position, |sample| {
                let g = &*self.nodes.add(sample.index);
                velocity = velocity.add(g.velocity.scale(sample.weight));
                moments = moments.add(
                    Matrix::outer(g.velocity, sample.position.sub(p.position)).scale(sample.weight),
                );
                gradient = gradient.add(Matrix::outer(g.velocity, sample.gradient));
            });
            let affine = moments.scale(4.0 / dx2);
            let mut position = p.position.add(velocity.scale(dt));
            if !(in_grid
                && position.finite()
                && velocity.finite()
                && affine.finite()
                && constitutive(p, gradient, material, dt))
            {
                return false;
            }

            let exit = (mask & 1 == 0 && position.x < domain.min.x)
                || (mask & 2 == 0 && position.x > domain.max.x)
                || (mask & 4 == 0 && position.y < domain.min.y)
                || (mask & 8 == 0 && position.y > domain.max.y)
                || (mask & 16 == 0 && position.z < domain.min.z)
                || (mask & 32 == 0 && position.z > domain.max.z);
            if exit {
                self.escaped += p.ratio * p.reference;
                self.escaped_reference += p.reference;
                p.reference = 0.0;
                p.position = position;
                p.velocity = velocity;
                continue;
            }
            velocity = close_grid_wall(velocity, position, domain, mask, material.friction);
            position.x = position.x.max(domain.min.x).min(domain.max.x);
            position.y = position.y.max(domain.min.y).min(domain.max.y);
            position.z = position.z.max(domain.min.z).min(domain.max.z);
            if !self.bed.is_null() {
                let local = position.sub(domain.min).scale(1.0 / domain.spacing);
                let x = (floor(local.x + 0.5) + 1.0) as u32;
                let z = (floor(local.z + 0.5) + 1.0) as u32;
                let b = &*self.bed.add(domain.bed_index(x, z));
                let sample = domain.position(x, 1, z);
                let h = b.h
                    - ((position.x - sample.x) * b.n.x + (position.z - sample.z) * b.n.z) / b.n.y;
                if !(b.n.y > 0.0 && h.is_finite()) {
                    return false;
                }
                if position.y <= h {
                    position.y = h.min(domain.max.y);
                    velocity = resolve_contact(velocity, b.n, material.friction);
                }
            }
            if !velocity.finite() {
                return false;
            }
            p.position = position;
            p.velocity = velocity;
            p.affine = affine;
        }
        true
    }

    unsafe fn step(&mut self, records: *mut f64, budget: *mut f64, dt: f64) -> u32 {
        let model = &*self.model;
        let n = self.domain;
        let spacing_square = n.spacing * n.spacing;
        if !(dt > 0.0
            && dt.is_finite()
            && n.spacing > 0.0
            && spacing_square.is_finite()
            && (4.0 / spacing_square).is_finite()
            && n.max.x > n.min.x
            && n.max.y > n.min.y
            && n.max.z > n.min.z
            && n.min
                .sub(Vector::new(n.spacing, n.spacing, n.spacing))
                .finite()
            && n.max
                .add(Vector::new(n.spacing, n.spacing, n.spacing))
                .finite()
            && model.density > 0.0
            && model.density.is_finite()
            && model.bulk > 0.0
            && model.bulk.is_finite()
            && model.shear > 0.0
            && model.shear.is_finite()
            && model.exponent > 0.0
            && model.exponent.is_finite()
            && (1.0 / model.exponent).is_finite()
            && model.gravity.finite())
        {
            return 1;
        }
        let Some(count) = (n.shape.x as usize)
            .checked_add(3)
            .and_then(|x| x.checked_mul((n.shape.y as usize).checked_add(3)?))
            .and_then(|xy| xy.checked_mul((n.shape.z as usize).checked_add(3)?))
        else {
            return 1;
        };
        self.nodes.write_bytes(0, count);
        let wave_speed = model.wave_speed();
        let gravity_speed = model.gravity.length();
        if !(wave_speed.is_finite() && gravity_speed.is_finite()) {
            return 1;
        }
        let mut remaining = dt;
        let mut substeps = 0;
        let mut occupied = 0;
        while remaining > 0.0 {
            let mut speed: f64 = 0.0;
            let mut live = false;
            for i in 0..self.count {
                let p = &*self.points.add(i);
                if p.reference > 0.0 {
                    live = true;
                    let velocity = p.velocity.length();
                    if !velocity.is_finite() {
                        return 1;
                    }
                    speed = speed.max(velocity);
                }
            }
            if !live {
                break;
            }
            if substeps == MAX_SUBSTEPS {
                return 4;
            }
            let safe_step = cfl_step(n.spacing, wave_speed, speed, gravity_speed, remaining);
            if !(safe_step > 0.0) {
                return 1;
            }
            let step = remaining.min(safe_step);
            let next = remaining - step;
            if !(step.is_finite() && next < remaining) {
                return 1;
            }
            remaining = next;
            let Some(count) = self.p2g(step, model) else {
                return 1;
            };
            occupied = count;
            if !self.normalize(occupied, model.gravity.scale(step)) {
                return 1;
            }
            if !self.implicit_viscosity(occupied, model, step) {
                return 3;
            }
            self.contacts(occupied, model);
            if !self.material_step(model, step) {
                return 2;
            }
            substeps += 1;
            for i in 0..occupied {
                self.nodes.add(*self.active.add(i) as usize).write(Node {
                    mass: 0.0,
                    velocity: Vector::ZERO,
                });
            }
        }

        self.publish(records, budget, substeps, occupied)
    }

    unsafe fn publish(
        &self,
        records: *mut f64,
        budget: *mut f64,
        substeps: u32,
        occupied: usize,
    ) -> u32 {
        let model = &*self.model;
        let mut volume = 0.0;
        let mut reference_volume = 0.0;
        let mut active = 0.0;
        for i in 0..self.count {
            let p = &*self.points.add(i);
            if !(p.reference >= 0.0 && p.reference.is_finite()) {
                return 1;
            }
            let vol = p.reference * p.ratio;
            let present = if p.reference > 0.0 { 1.0 } else { 0.0 };
            let (pressure, shear) = if present == 0.0 {
                (0.0, 0.0)
            } else {
                if !(vol > 0.0) {
                    return 1;
                }
                let t = p.elastic.sub(Matrix::ID.scale(p.elastic.trace() / 3.0));
                (
                    -compressive_term(p.ratio, model.bulk) / p.ratio,
                    t.norm() * model.shear * core::f64::consts::FRAC_1_SQRT_2 / p.ratio,
                )
            };
            let row = [
                p.position.x,
                p.position.y,
                p.position.z,
                p.velocity.x,
                p.velocity.y,
                p.velocity.z,
                vol,
                pressure,
                shear,
                p.plastic,
                present,
            ];
            if !row.iter().all(|value| value.is_finite()) {
                return 1;
            }
            records
                .add(i * row.len())
                .copy_from_nonoverlapping(row.as_ptr(), row.len());
            volume += vol;
            reference_volume += p.reference;
            active += present;
        }
        if !(volume.is_finite()
            && reference_volume.is_finite()
            && self.escaped.is_finite()
            && self.escaped_reference.is_finite())
        {
            return 1;
        }
        budget.write(reference_volume);
        budget.add(1).write(volume);
        budget.add(2).write(self.escaped);
        budget.add(3).write(self.escaped_reference);
        budget.add(4).write(f64::from(substeps));
        budget.add(5).write(occupied as f64);
        budget.add(6).write(active);
        0
    }
}

// Typed-array pointers live in separate caller-owned arena regions.
#[unsafe(no_mangle)]
unsafe extern "C" fn viscoplastic_step(
    points: *mut Grain,
    count: u32,
    nx: u32,
    ny: u32,
    nz: u32,
    nodes: *mut Node,
    active: *mut u32,
    diffusion: *mut Viscous,
    bed: *const BedNode,
    model: *const Material,
    records: *mut f64,
    budget: *mut f64,
    dt: f64,
) -> u32 {
    let min = (*model).origin;
    let spacing = (*model).spacing;
    let shape = GridSize {
        x: nx,
        y: ny,
        z: nz,
    };
    let max = min.add(Vector::new(f64::from(nx), f64::from(ny), f64::from(nz)).scale(spacing));
    let domain = Domain {
        shape,
        spacing,
        min,
        max,
    };
    Flow {
        domain,
        model,
        points,
        count: count as usize,
        nodes,
        active,
        diffusion,
        bed,
        escaped: 0.0,
        escaped_reference: 0.0,
    }
    .step(records, budget, dt)
}
