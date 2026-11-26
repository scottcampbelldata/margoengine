use super::Point;
use super::tensor::{V, ZERO, add, scale, sub};

#[repr(C)]
struct WallJet {
    x: f64,
    z: f64,
    elevation: f64,
    radius: f64,
    band: f64,
    impulse_x: f64,
    impulse_z: f64,
    radial: f64,
}

impl WallJet {
    fn weight(&self, position: V) -> (f64, V) {
        let radial = [
            (position[0] - self.x) / self.radius,
            0.0,
            (position[2] - self.z) / self.radius,
        ];
        let r2 = radial[0] * radial[0] + radial[2] * radial[2];
        let distance = (position[1] - self.elevation).abs();
        let horizontal = (1.0 - r2).max(0.0);
        let vertical = (1.0 - distance / self.band).max(0.0);
        (horizontal * horizontal * vertical, radial)
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn mpm_wake(
    points: *const Point,
    kicks: *mut V,
    count: usize,
    jet: *const WallJet,
) -> f64 {
    let points = unsafe { core::slice::from_raw_parts(points, count) };
    let kicks = unsafe { core::slice::from_raw_parts_mut(kicks, count) };
    let jet = unsafe { &*jet };
    let mut mass = 0.0;
    let mut volume = 0.0;
    let mut radial_mean = ZERO;
    for point in points {
        let (weight, radial) = jet.weight(point.position);
        let share = weight * point.mass;
        if share > 0.0 {
            mass += share;
            volume += weight * point.rest_volume;
            radial_mean = add(radial_mean, scale(radial, share));
        }
    }
    if mass == 0.0 {
        return 0.0;
    }
    radial_mean = scale(radial_mean, 1.0 / mass);
    let impulse = [jet.impulse_x, 0.0, jet.impulse_z];
    // Integrate the radial quartic over its disk and the depth taper over the solid half-band.
    let supported_volume = core::f64::consts::PI * jet.radius * jet.radius * jet.band / 6.0;
    let captured = (volume / supported_volume).min(1.0);
    for (point, kick) in points.iter().zip(kicks.iter_mut()) {
        let (weight, radial) = jet.weight(point.position);
        if weight > 0.0 {
            let push = add(impulse, scale(sub(radial, radial_mean), jet.radial));
            *kick = add(*kick, scale(push, captured * weight / mass));
        }
    }
    captured
}
