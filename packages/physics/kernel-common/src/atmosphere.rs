// The standard atmosphere (K03 of docs/physics-solvers.md): ISO 2533:1975 and ICAO Doc 7488, the same model, temperature and
// pressure of dry air by height, computed with the pinned exp and pow (K01) so a native build, a Wasm build and the
// TypeScript twin (`@margoengine/math/atmosphere`) give the same bits; tests/atmosphere-vectors.txt pins both. Heights are
// metres above sea level without the geopotential correction (under 0.2 % in temperature below 11 km); the sea-level
// temperature and the tropopause height may be shifted for a warmer or colder day.
use crate::pinned::{exp, pow};

/// Standard gravity, m/s^2 (3rd CGPM, 1901; ISO 80000-3).
pub const STANDARD_GRAVITY: f64 = 9.80665;
/// The gas constant of dry air the standard atmosphere uses, J/(kg K) (ICAO Doc 7488).
pub const DRY_AIR_GAS_CONSTANT: f64 = 287.05287;
/// Sea-level pressure, Pa.
pub const SEA_LEVEL_PRESSURE: f64 = 101325.0;
/// Sea-level temperature, K.
pub const SEA_LEVEL_TEMPERATURE: f64 = 288.15;

/// The standard atmosphere at `z` metres: (temperature K, pressure Pa). Layers: -6.5 K/km to the tropopause, isothermal for
/// 9 km, +1 K/km to 32 km, +2.8 K/km to 47 km, isothermal above; below sea level the first layer continues (ISO 2533
/// tabulates to -2 km).
pub fn standard_atmosphere(z: f64, sea_level: f64, tropopause: f64) -> (f64, f64) {
    if z < 0.0 {
        let t1 = sea_level - 0.0065 * z;
        return (
            t1,
            SEA_LEVEL_PRESSURE * pow(t1 / sea_level, STANDARD_GRAVITY / (0.0065 * DRY_AIR_GAS_CONSTANT)),
        );
    }
    let layers = [
        (tropopause, -0.0065),
        (tropopause + 9000.0, 0.0),
        (32000.0, 0.001),
        (47000.0, 0.0028),
        (f64::INFINITY, 0.0),
    ];
    let (mut t, mut p, mut base) = (sea_level, SEA_LEVEL_PRESSURE, 0.0f64);
    for (top, lapse) in layers {
        let h = z.max(base).min(top.max(base)) - base;
        let t1 = t + lapse * h;
        p = if lapse == 0.0 {
            p * exp((-STANDARD_GRAVITY * h) / (DRY_AIR_GAS_CONSTANT * t))
        } else {
            p * pow(t1 / t, -STANDARD_GRAVITY / (lapse * DRY_AIR_GAS_CONSTANT))
        };
        t = t1;
        if z <= top {
            break;
        }
        base = top.max(base);
    }
    (t, p)
}

/// Density of dry air, kg/m^3, at temperature `temperature` K and pressure `pressure` Pa (the ideal gas law).
pub fn air_density(temperature: f64, pressure: f64) -> f64 {
    pressure / (DRY_AIR_GAS_CONSTANT * temperature)
}

/// Density of the standard atmosphere at `z` metres, kg/m^3: 1.225 at sea level.
pub fn standard_density(z: f64, sea_level: f64, tropopause: f64) -> f64 {
    let (t, p) = standard_atmosphere(z, sea_level, tropopause);
    air_density(t, p)
}
