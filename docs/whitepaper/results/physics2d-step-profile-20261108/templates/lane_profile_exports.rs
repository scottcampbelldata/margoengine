// Own diagnostic exports, identical in control and instrumented source.
#[unsafe(no_mangle)]
pub extern "C" fn profile_phase(i: u32) -> f64 {
    #[cfg(feature = "lane-profile")]
    if (i as usize) < margoengine_physics2d_kernel::lane_profile::PHASES {
        return margoengine_physics2d_kernel::lane_profile::phase(i as usize);
    }
    let _ = i;
    0.0
}
#[unsafe(no_mangle)]
pub extern "C" fn profile_entries(i: u32) -> u64 {
    #[cfg(feature = "lane-profile")]
    if (i as usize) < margoengine_physics2d_kernel::lane_profile::PHASES {
        return margoengine_physics2d_kernel::lane_profile::entries(i as usize);
    }
    let _ = i;
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn profile_count(i: u32) -> u64 {
    #[cfg(feature = "lane-profile")]
    if (i as usize) < margoengine_physics2d_kernel::lane_profile::COUNTS {
        return margoengine_physics2d_kernel::lane_profile::count(i as usize);
    }
    let _ = i;
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn profile_clock_calls() -> u64 {
    #[cfg(feature = "lane-profile")]
    return margoengine_physics2d_kernel::lane_profile::calls();
    #[cfg(not(feature = "lane-profile"))]
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn profile_calibrate(n: u32, import_clock: u32) -> f64 {
    #[cfg(feature = "lane-profile")]
    return if import_clock != 0 {
        margoengine_physics2d_kernel::lane_profile::clock_loop(n)
    } else {
        margoengine_physics2d_kernel::lane_profile::empty_loop(n)
    };
    #[cfg(not(feature = "lane-profile"))]
    { let _ = (n, import_clock); 0.0 }
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_public_count(i: u32) -> u64 {
    let Some(w) = (unsafe { &*super::BENCH.0.get() }) else { return 0; };
    let c = w.counts;
    [c.compared, c.pairs, c.manifolds, c.cold_points, c.constraints, c.block,
        c.sequential, c.colours, c.overflow, c.islands, c.awake_bodies]
        .get(i as usize).copied().unwrap_or(0)
}

struct Hash(u64);
impl Hash {
    fn add(&mut self, v: u64) {
        for b in v.to_le_bytes() { self.0 ^= b as u64; self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3); }
    }
    fn float(&mut self, v: f32) { self.add(v.to_bits() as u64); }
}
#[unsafe(no_mangle)]
pub extern "C" fn profile_state() -> u64 {
    let Some(w) = (unsafe { &*super::BENCH.0.get() }) else { return 0; };
    let mut h = Hash(0xcbf2_9ce4_8422_2325);
    h.add(w.steps);
    h.add(w.bodies.len() as u64);
    for b in &w.bodies {
        h.add(b.kind as u64);
        for v in [b.xf.p.x, b.xf.p.y, b.xf.q.c, b.xf.q.s, b.center.x, b.center.y,
            b.local_center.x, b.local_center.y, b.linear_velocity.x, b.linear_velocity.y,
            b.angular_velocity, b.mass, b.inv_mass, b.inertia, b.inv_inertia, b.extent,
            b.linear_damping, b.angular_damping, b.gravity_scale, b.sleep_time] { h.float(v); }
        h.add(b.exact_center[0].to_bits()); h.add(b.exact_center[1].to_bits());
        h.add(b.can_sleep as u64); h.add(b.fixed_rotation as u64); h.add(b.awake as u64);
        h.add(b.shapes.len() as u64); for &s in &b.shapes { h.add(s as u64); }
    }
    h.add(w.contacts.len() as u64);
    for c in &w.contacts {
        h.add(c.a as u64); h.add(c.b as u64); h.add(c.manifold.count as u64);
        h.float(c.manifold.normal.x); h.float(c.manifold.normal.y);
        // Both slots are compared, including cached unused slots.
        for (i, p) in c.manifold.points.iter().enumerate() {
            h.float(p.point.x); h.float(p.point.y); h.float(p.separation); h.add(p.id as u64);
            h.float(c.normal_impulse[i]); h.float(c.tangent_impulse[i]);
        }
    }
    h.add(w.joints.len() as u64);
    for j in &w.joints { for f in j.lock.into_iter().chain([j.lower, j.upper, j.motor]) { h.float(f); } }
    for i in 0..11 { h.add(profile_public_count(i)); }
    h.0
}
