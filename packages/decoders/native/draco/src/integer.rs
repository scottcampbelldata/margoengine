//! Portable integer values and predictor side data, read before parent resolution.
use crate::{
    Budget, Error, Result, cursor::Cursor, edgebreaker::Binary, entropy, prediction::Mesh,
};

pub(crate) enum Transform {
    None,
    Wrap(i32, i32),
    Normal(i32),
    LegacyNormal(i32),
}
pub(crate) struct Integer {
    pub values: Vec<i32>,
    method: i8,
    transform: Transform,
    crease: [Vec<bool>; 4],
    orientations: Vec<bool>,
    flips: Vec<bool>,
}
impl Integer {
    pub fn read(
        c: &mut Cursor,
        n: usize,
        components: usize,
        budget: &mut Budget,
        gltf_compat: bool,
        legacy: impl FnOnce(&mut Cursor) -> Result<()>,
    ) -> Result<Self> {
        let method = c.byte()? as i8;
        // E20: the shipped glTF build accepts multi-parallelogram framing but
        // reconstructs it with difference prediction. Its full build uses the
        // actual multi predictor. Keep this entry-specific behavior explicit.
        let method = if gltf_compat && method == 2 {
            0
        } else {
            method
        };
        let transform = if method != -2 { c.byte()? } else { 0 };
        if ![-2, 0, 1, 2, 4, 5, 6].contains(&method) {
            return Err(Error::Unsupported);
        }
        if method != -2 && transform != 1 && transform != 2 && transform != 3 {
            return Err(Error::Unsupported);
        }
        if (transform == 2 || transform == 3 || method == 5 || method == 6) && components != 2 {
            return Err(Error::Invalid);
        }
        if (method == 1 || method == 2 || method == 4 || method == 5) && transform != 1 {
            return Err(Error::Unsupported);
        }
        if method == 6 && transform != 3 {
            return Err(Error::Unsupported);
        }
        if c.version < 0x200 {
            legacy(c)?;
        }
        let symbols = match c.byte()? {
            0 => {
                let width = usize::from(c.byte()?);
                if !(1..=4).contains(&width) {
                    return Err(Error::Invalid);
                }
                let payload = c.take(n.checked_mul(width).ok_or(Error::Overflow)?)?;
                let mut source = Cursor::new(payload);
                let mut symbols = budget.vector(n, 0_u32)?;
                budget.steps(n)?;
                for value in &mut symbols {
                    *value = source.le(width)?;
                }
                symbols
            }
            1 => entropy::symbols(c, n, components, budget)?,
            _ => return Err(Error::Invalid),
        };
        let mut values = budget.vector(n, 0_i32)?;
        for (dst, value) in values.iter_mut().zip(symbols) {
            *dst = if transform == 2 || transform == 3 {
                i32::try_from(value).map_err(|_| Error::Invalid)?
            } else {
                ((value >> 1) as i32) ^ -((value & 1) as i32)
            };
        }
        let mut out = Self {
            values,
            method,
            transform: Transform::None,
            crease: [Vec::new(), Vec::new(), Vec::new(), Vec::new()],
            orientations: Vec::new(),
            flips: Vec::new(),
        };
        if method == -2 {
            return Ok(out);
        }
        if method == 4 {
            for flags in &mut out.crease {
                let count = c.count()?;
                if count > n.saturating_mul(4) {
                    return Err(Error::Invalid);
                }
                *flags = budget.vector(count, false)?;
                if count != 0 {
                    let mut binary = Binary::read(c)?;
                    budget.steps(count)?;
                    for flag in flags {
                        *flag = binary.bit()?;
                    }
                }
            }
        } else if method == 5 {
            let count = c.le(4)? as usize;
            if count > n / components {
                return Err(Error::Invalid);
            }
            out.orientations = budget.vector(count, false)?;
            let mut binary = Binary::read(c)?;
            let mut previous = true;
            budget.steps(count)?;
            for orientation in &mut out.orientations {
                if !binary.bit()? {
                    previous = !previous;
                }
                *orientation = previous;
            }
        }
        out.transform = match transform {
            1 => {
                let min = c.le(4)? as i32;
                let max = c.le(4)? as i32;
                if min > max {
                    return Err(Error::Invalid);
                }
                Transform::Wrap(min, max)
            }
            2 | 3 => {
                let max = c.le(4)? as i32;
                if transform == 3 || c.version < 0x202 {
                    c.le(4)?;
                }
                if transform == 3 {
                    Transform::Normal(max)
                } else {
                    Transform::LegacyNormal(max)
                }
            }
            _ => return Err(Error::Unsupported),
        };
        if method == 6 {
            let mut binary = Binary::read(c)?;
            out.flips = budget.vector(n / components, false)?;
            budget.steps(out.flips.len())?;
            for flip in &mut out.flips {
                *flip = binary.bit()?;
            }
        }
        Ok(out)
    }
    pub fn reconstruct(
        &mut self,
        components: usize,
        mesh: Option<&Mesh>,
        parent: Option<&[i32]>,
        budget: &mut Budget,
    ) -> Result<()> {
        if self.method == -2 {
            return Ok(());
        }
        if self.method > 0 && mesh.is_none() {
            return Err(Error::Unsupported);
        }
        let mut positions = [0_usize; 4];
        for row in 0..self.values.len() / components {
            budget.steps(1)?;
            let mut prediction = [0_i32; 16];
            if self.method == 5 {
                let value = mesh.ok_or(Error::Invalid)?.tex_coords(
                    row,
                    &self.values,
                    parent.ok_or(Error::Invalid)?,
                    &mut self.orientations,
                )?;
                prediction[..2].copy_from_slice(&value);
            } else if self.method == 6 {
                let max = match self.transform {
                    Transform::Normal(max) => max,
                    _ => return Err(Error::Invalid),
                };
                let value = mesh.ok_or(Error::Invalid)?.normal(
                    row,
                    parent.ok_or(Error::Invalid)?,
                    self.flips[row],
                    max,
                    budget,
                )?;
                prediction[..2].copy_from_slice(&value);
            } else if row > 0 {
                let mut predicted_mesh = false;
                if let Some(mesh) = mesh {
                    if self.method == 1 {
                        predicted_mesh =
                            mesh.parallelogram(row, components, &self.values, &mut prediction);
                    } else if self.method == 2 {
                        if let Some(value) = mesh.multi(row, components, &self.values, budget)? {
                            prediction = value;
                            predicted_mesh = true;
                        }
                    } else if self.method == 4
                        && let Some(value) = mesh.constrained(
                            row,
                            components,
                            &self.values,
                            &self.crease,
                            &mut positions,
                            budget,
                        )?
                    {
                        prediction = value;
                        predicted_mesh = true;
                    }
                }
                if !predicted_mesh {
                    prediction[..components]
                        .copy_from_slice(&self.values[(row - 1) * components..row * components]);
                }
            }
            let offset = row * components;
            match self.transform {
                Transform::None => return Err(Error::Invalid),
                Transform::Wrap(min, max) => {
                    let span = 1_i64 + i64::from(max) - i64::from(min);
                    for (component, predicted) in prediction[..components].iter().enumerate() {
                        let i = offset + component;
                        let mut value =
                            i64::from((*predicted).clamp(min, max)) + i64::from(self.values[i]);
                        if value > i64::from(max) {
                            value -= span;
                        } else if value < i64::from(min) {
                            value += span;
                        }
                        self.values[i] = i32::try_from(value).map_err(|_| Error::Invalid)?;
                    }
                }
                Transform::Normal(max) => {
                    let value = crate::normal::correction(
                        [prediction[0], prediction[1]],
                        [self.values[offset], self.values[offset + 1]],
                        max,
                    )?;
                    self.values[offset..offset + 2].copy_from_slice(&value);
                }
                Transform::LegacyNormal(max) => {
                    let value = crate::normal::legacy_correction(
                        [prediction[0], prediction[1]],
                        [self.values[offset], self.values[offset + 1]],
                        max,
                    )?;
                    self.values[offset..offset + 2].copy_from_slice(&value);
                }
            }
        }
        Ok(())
    }
}
