use crate::cdf_tables::Table;
use crate::cdfs::Cdfs;
use crate::entropy::Entropy;
use crate::frame::Frame;
use crate::sequence::Sequence;
use crate::tables::SGR_PARAMS;
use crate::{Error, Result};

#[derive(Clone, Debug, Default)]
pub struct Unit {
    pub mode: usize,
    pub wiener: [[i32; 3]; 2],
    pub sgr_set: usize,
    pub xqd: [i32; 2],
}
pub struct Plane {
    pub columns: usize,
    pub rows: usize,
    pub units: Vec<Unit>,
}
pub struct Restoration {
    pub planes: Vec<Plane>,
}
/// Predictors are reset per tile; the frame's restoration map spans all tiles.
pub struct Predictors {
    wiener: [[[i32; 3]; 2]; 3],
    sgr: [[i32; 2]; 3],
}
impl Default for Predictors {
    fn default() -> Self {
        Self {
            wiener: [[[3, -7, 15]; 2]; 3],
            sgr: [[-32, 31]; 3],
        }
    }
}
impl Restoration {
    pub fn new(frame: &Frame, seq: &Sequence) -> Self {
        let mut planes = Vec::new();
        for plane in 0..if seq.color.monochrome { 1 } else { 3 } {
            let sx = u32::from(plane > 0 && seq.color.sub_x);
            let sy = u32::from(plane > 0 && seq.color.sub_y);
            let width = (frame.upscaled_width + ((1 << sx) - 1)) >> sx;
            let height = (frame.height + ((1 << sy) - 1)) >> sy;
            let unit_size = frame.restoration_size[plane];
            let columns = ((width + unit_size / 2) / unit_size).max(1) as usize;
            let rows = ((height + unit_size / 2) / unit_size).max(1) as usize;
            planes.push(Plane {
                columns,
                rows,
                units: vec![Unit::default(); columns * rows],
            });
        }
        Self { planes }
    }
    pub fn read_superblock(
        &mut self,
        e: &mut Entropy<'_>,
        cdfs: &mut Cdfs,
        predictors: &mut Predictors,
        seq: &Sequence,
        frame: &Frame,
        row: u32,
        col: u32,
    ) -> Result<()> {
        if frame.intrabc {
            return Ok(());
        }
        let sb = if seq.superblock_128 { 32 } else { 16 };
        for (plane, data) in self.planes.iter_mut().enumerate() {
            if frame.restoration[plane] == 0 {
                continue;
            }
            let sx = u32::from(plane > 0 && seq.color.sub_x);
            let sy = u32::from(plane > 0 && seq.color.sub_y);
            let size = frame.restoration_size[plane];
            let top = (row * (4 >> sy)).div_ceil(size) as usize;
            let bottom = (((row + sb) * (4 >> sy)).div_ceil(size) as usize).min(data.rows);
            let numerator = (4 >> sx) * frame.superres_denom;
            let denominator = size * 8;
            let left = (col * numerator).div_ceil(denominator) as usize;
            let right = (((col + sb) * numerator).div_ceil(denominator) as usize).min(data.columns);
            for y in top..bottom {
                for x in left..right {
                    let unit = &mut data.units[y * data.columns + x];
                    unit.mode = match frame.restoration[plane] {
                        1 => cdfs.read(e, Table::UseWiener, &[])?,
                        2 => cdfs.read(e, Table::UseSgrproj, &[])? * 2,
                        3 => cdfs.read(e, Table::RestorationType, &[])?,
                        _ => return Err(Error::Invalid),
                    };
                    if unit.mode == 1 {
                        for pass in 0..2 {
                            for tap in usize::from(plane > 0)..3 {
                                let low = [-5, -23, -17][tap];
                                let high = [11, 9, 47][tap];
                                let value = e.signed_subexp(
                                    low,
                                    high,
                                    tap as u32 + 1,
                                    predictors.wiener[plane][pass][tap],
                                )?;
                                predictors.wiener[plane][pass][tap] = value;
                                unit.wiener[pass][tap] = value;
                            }
                        }
                    } else if unit.mode == 2 {
                        unit.sgr_set = e.literal(4)? as usize;
                        for i in 0..2 {
                            let low = [-96, -32][i];
                            let high = [32, 96][i];
                            let value = if SGR_PARAMS[unit.sgr_set][i * 2] != 0 {
                                e.signed_subexp(low, high, 4, predictors.sgr[plane][i])?
                            } else if i == 1 {
                                (128 - predictors.sgr[plane][0]).clamp(low, high - 1)
                            } else {
                                0
                            };
                            predictors.sgr[plane][i] = value;
                            unit.xqd[i] = value;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
