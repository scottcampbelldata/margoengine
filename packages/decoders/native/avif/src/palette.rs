//! Screen-content palettes, cache merging and diagonal tokens, AV1 5.11.30/33/34.
use crate::cdf_tables::Table;
use crate::cdfs::Cdfs;
use crate::entropy::Entropy;
use crate::{Error, Result};

#[derive(Clone, Debug, Default)]
pub struct Palette {
    pub colors: [Vec<u16>; 3],
    pub maps: [Vec<u8>; 2],
}

pub fn cache(above: &[u16], left: &[u16]) -> Vec<u16> {
    let mut values = [above, left].concat();
    values.sort_unstable();
    values.dedup();
    values
}

pub fn colors(
    e: &mut Entropy<'_>,
    cache: &[u16],
    count: usize,
    depth: u32,
    luma: bool,
) -> Result<Vec<u16>> {
    let maximum = (1 << depth) - 1;
    let mut values = Vec::with_capacity(count);
    for &value in cache {
        if values.len() == count {
            break;
        }
        if e.flag()? {
            values.push(value);
        }
    }
    if values.len() < count {
        values.push(e.literal(depth)? as u16);
    }
    let mut bits = if values.len() < count {
        depth - 3 + e.literal(2)?
    } else {
        0
    };
    while values.len() < count {
        let value =
            (u32::from(*values.last().ok_or(Error::Invalid)?) + e.literal(bits)? + u32::from(luma))
                .min(maximum);
        values.push(value as u16);
        let range = (1 << depth) - value - u32::from(luma);
        bits = bits.min(if range <= 1 {
            0
        } else {
            32 - (range - 1).leading_zeros()
        });
    }
    values.sort_unstable();
    Ok(values)
}

pub fn v_colors(e: &mut Entropy<'_>, count: usize, depth: u32) -> Result<Vec<u16>> {
    if !e.flag()? {
        return (0..count).map(|_| Ok(e.literal(depth)? as u16)).collect();
    }
    let bits = depth - 4 + e.literal(2)?;
    let mut values = vec![e.literal(depth)? as u16];
    while values.len() < count {
        let mut delta = e.literal(bits)? as i32;
        if delta != 0 && e.flag()? {
            delta = -delta;
        }
        values.push(
            ((*values.last().ok_or(Error::Invalid)? as i32 + delta) & ((1 << depth) - 1)) as u16,
        );
    }
    Ok(values)
}

/// Stable score ordering is normative: equal scores retain their original color order.
pub fn context(
    map: &[u8],
    width: usize,
    r: usize,
    c: usize,
    count: usize,
) -> Result<(usize, [usize; 8])> {
    let mut scores = [0; 8];
    let mut order = std::array::from_fn(|i| i);
    if c > 0 {
        scores[map[r * width + c - 1] as usize] += 2;
    }
    if r > 0 && c > 0 {
        scores[map[(r - 1) * width + c - 1] as usize] += 1;
    }
    if r > 0 {
        scores[map[(r - 1) * width + c] as usize] += 2;
    }
    for i in 0..3 {
        let mut best = i;
        for j in i + 1..count {
            if scores[j] > scores[best] {
                best = j;
            }
        }
        let score = scores[best];
        let color = order[best];
        for j in (i + 1..=best).rev() {
            scores[j] = scores[j - 1];
            order[j] = order[j - 1];
        }
        scores[i] = score;
        order[i] = color;
    }
    let hash = scores[0] + 2 * scores[1] + 2 * scores[2];
    let ctx = [-1, -1, 0, -1, -1, 4, 3, 2, 1]
        .get(hash)
        .copied()
        .ok_or(Error::Invalid)?;
    if ctx < 0 {
        return Err(Error::Invalid);
    }
    Ok((ctx as usize, order))
}

pub fn tokens(
    e: &mut Entropy<'_>,
    cdfs: &mut Cdfs,
    count: usize,
    chroma: bool,
    width: usize,
    height: usize,
    visible_w: usize,
    visible_h: usize,
) -> Result<Vec<u8>> {
    let tables = if chroma {
        [
            Table::PaletteSize2UvColor,
            Table::PaletteSize3UvColor,
            Table::PaletteSize4UvColor,
            Table::PaletteSize5UvColor,
            Table::PaletteSize6UvColor,
            Table::PaletteSize7UvColor,
            Table::PaletteSize8UvColor,
        ]
    } else {
        [
            Table::PaletteSize2YColor,
            Table::PaletteSize3YColor,
            Table::PaletteSize4YColor,
            Table::PaletteSize5YColor,
            Table::PaletteSize6YColor,
            Table::PaletteSize7YColor,
            Table::PaletteSize8YColor,
        ]
    };
    if !(2..=8).contains(&count)
        || visible_w == 0
        || visible_h == 0
        || visible_w > width
        || visible_h > height
    {
        return Err(Error::Invalid);
    }
    let mut map = vec![0; width * height];
    map[0] = e.ns(count as u32)? as u8;
    for diagonal in 1..visible_w + visible_h - 1 {
        for col in (diagonal.saturating_sub(visible_h - 1)..=diagonal.min(visible_w - 1)).rev() {
            let row = diagonal - col;
            let (ctx, order) = context(&map, width, row, col, count)?;
            map[row * width + col] = order[cdfs.read(e, tables[count - 2], &[ctx])?] as u8;
        }
    }
    for row in 0..height {
        for col in 0..width {
            if row >= visible_h || col >= visible_w {
                map[row * width + col] =
                    map[row.min(visible_h - 1) * width + col.min(visible_w - 1)];
            }
        }
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn caches_deduplicate_and_contexts_keep_ties_stable() {
        assert_eq!(cache(&[3, 7, 8], &[1, 3, 7]), [1, 3, 7, 8]);
        let (ctx, order) = context(&[2, 1, 0, 0], 2, 1, 1, 3).unwrap();
        assert_eq!(ctx, 1); // left and above each score two, diagonal scores one.
        assert_eq!(&order[..3], &[0, 1, 2]);
        let (ctx, order) = context(&[2, 2, 2, 0], 2, 1, 1, 3).unwrap();
        assert_eq!(ctx, 4);
        assert_eq!(order[0], 2);
    }
}
