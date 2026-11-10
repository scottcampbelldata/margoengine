use crate::cdf_tables::{MODELS, Table};
use crate::entropy::{Cdf, Entropy};
use crate::{Error, Result};

/// Independent, adaptively updated probability models for one tile.
pub struct Cdfs {
    tables: Vec<Vec<Cdf>>,
}
impl Cdfs {
    pub fn new(base_q: u32) -> Result<Self> {
        let quant = match base_q {
            0..=20 => 0,
            21..=60 => 1,
            61..=120 => 2,
            _ => 3,
        };
        let mut tables = Vec::with_capacity(MODELS.len());
        for model in &MODELS {
            let values = if model.quantized {
                let size = model.values.len() / 4;
                &model.values[quant * size..(quant + 1) * size]
            } else {
                model.values
            };
            tables.push(
                values
                    .chunks_exact(model.symbols)
                    .map(Cdf::new)
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        Ok(Self { tables })
    }
    pub fn model(&mut self, table: Table, indices: &[usize]) -> Result<&mut Cdf> {
        let model = &MODELS[table as usize];
        let shape = if model.quantized {
            &model.shape[1..]
        } else {
            model.shape
        };
        if shape.len() != indices.len() {
            return Err(Error::Invalid);
        }
        let mut offset = 0;
        for (index, size) in indices.iter().zip(shape) {
            if index >= size {
                return Err(Error::Invalid);
            }
            offset = offset * size + index;
        }
        self.tables[table as usize]
            .get_mut(offset)
            .ok_or(Error::Invalid)
    }
    pub fn read(&mut self, e: &mut Entropy<'_>, table: Table, indices: &[usize]) -> Result<usize> {
        e.read(self.model(table, indices)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quantizer_bands_and_tile_models_are_independent() {
        let mut low = Cdfs::new(20).unwrap();
        let mut high = Cdfs::new(21).unwrap();
        let original = low.model(Table::TxbSkip, &[0, 0]).unwrap().clone();
        assert_ne!(&original, high.model(Table::TxbSkip, &[0, 0]).unwrap());
        let mut second = Cdfs::new(20).unwrap();
        let bytes = [0; 32];
        let mut e = Entropy::new(&bytes, true).unwrap();
        low.read(&mut e, Table::TxbSkip, &[0, 0]).unwrap();
        assert_eq!(&original, second.model(Table::TxbSkip, &[0, 0]).unwrap());
        assert_ne!(&original, low.model(Table::TxbSkip, &[0, 0]).unwrap());
        assert!(low.model(Table::TxbSkip, &[99, 0]).is_err());
    }
}
