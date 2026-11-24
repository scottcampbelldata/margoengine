// Changes to shapes and joints that already exist: material, filtering and mass of a shape; limits and motor of a joint.
use crate::error::PhysicsError;
use crate::joint::{JointKind, Motor};
use crate::world::{ACTIVE_ALL, ShapeDef, World};

impl World {
    /// Replaces a shape's density, material, filtering, sensor flag and event flags with `def`'s, works the body's mass
    /// out again and wakes it. A refused change leaves the shape as it was.
    pub fn set_shape_params(&mut self, id: u32, def: &ShapeDef) -> Result<(), PhysicsError> {
        let shape = self.shapes.get(id as usize).ok_or(PhysicsError::InvalidHandle)?;
        if shape.dead {
            return Err(PhysicsError::InvalidHandle);
        }
        if [def.density, def.friction, def.restitution, def.force_threshold].into_iter().any(|v| !v.is_finite()) {
            return Err(PhysicsError::NotFinite);
        }
        if def.density < 0.0 || def.friction < 0.0 || def.restitution < 0.0 || def.force_threshold < 0.0 || def.events > 3 || def.active_types > ACTIVE_ALL {
            return Err(PhysicsError::InvalidParameter);
        }
        let (before, body) = (shape.clone(), shape.body);
        let s = &mut self.shapes[id as usize];
        s.hooks = def.hooks;
        (s.density, s.friction, s.restitution, s.groups, s.solver_groups, s.sensor, s.events, s.active_types, s.force_threshold) =
            (def.density, def.friction, def.restitution, def.groups, def.solver_groups, def.sensor, def.events, def.active_types, def.force_threshold);
        if let Err(error) = self.update_mass(body) {
            self.shapes[id as usize] = before;
            return Err(error);
        }
        self.wake(body)
    }

    /// Sets or clears a revolute or prismatic joint's limits; the angle or distance range is `lo..=hi`.
    pub fn set_joint_limits(&mut self, id: u32, limits: Option<(f32, f32)>) -> Result<(), PhysicsError> {
        if let Some((lo, hi)) = limits {
            if !lo.is_finite() || !hi.is_finite() {
                return Err(PhysicsError::NotFinite);
            }
            if lo > hi {
                return Err(PhysicsError::InvalidParameter);
            }
        }
        let index = self.joint_index(id).ok_or(PhysicsError::InvalidHandle)?;
        let (a, b) = (self.joints[index].def.a, self.joints[index].def.b);
        match &mut self.joints[index].def.kind {
            JointKind::Revolute { limits: slot, .. } | JointKind::Prismatic { limits: slot, .. } => *slot = limits,
            _ => return Err(PhysicsError::InvalidParameter),
        }
        self.wake(a)?;
        self.wake(b)
    }

    /// Sets or clears a revolute or prismatic joint's motor.
    pub fn set_joint_motor(&mut self, id: u32, motor: Option<Motor>) -> Result<(), PhysicsError> {
        if let Some(m) = motor {
            if !m.target_position.is_finite() || !m.target_velocity.is_finite() || m.max_force.is_nan() || m.max_force == f32::NEG_INFINITY {
                return Err(PhysicsError::NotFinite);
            }
            if !m.stiffness.is_finite() || !m.damping.is_finite() {
                return Err(PhysicsError::NotFinite);
            }
            if m.stiffness < 0.0 || m.damping < 0.0 || m.max_force < 0.0 {
                return Err(PhysicsError::InvalidParameter);
            }
        }
        let index = self.joint_index(id).ok_or(PhysicsError::InvalidHandle)?;
        let (a, b) = (self.joints[index].def.a, self.joints[index].def.b);
        match &mut self.joints[index].def.kind {
            JointKind::Revolute { motor: slot, .. } | JointKind::Prismatic { motor: slot, .. } => *slot = motor,
            _ => return Err(PhysicsError::InvalidParameter),
        }
        self.wake(a)?;
        self.wake(b)
    }

    /// Puts a body to sleep now (a static body has none); its velocity is dropped, as when it falls asleep alone.
    pub fn sleep_body(&mut self, body: u32) -> Result<(), PhysicsError> {
        let b = self.bodies.get_mut(body as usize).ok_or(PhysicsError::InvalidHandle)?;
        if b.dead {
            return Err(PhysicsError::InvalidHandle);
        }
        if b.kind != crate::world::Kind::Static {
            b.awake = false;
            b.linear_velocity = crate::math::V2::ZERO;
            b.angular_velocity = 0.0;
        }
        Ok(())
    }
}
