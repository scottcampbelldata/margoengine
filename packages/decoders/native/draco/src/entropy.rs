use crate::{
    Budget, Error, Result,
    cursor::{Bits, Cursor},
};

pub(crate) struct Ans<'a> {
    data: &'a [u8],
    at: usize,
    state: u32,
    base: u32,
}
impl<'a> Ans<'a> {
    pub fn new(data: &'a [u8], base: u32) -> Result<Self> {
        let last = *data.last().ok_or(Error::Truncated)?;
        let width = usize::from(last >> 6) + 1;
        let at = data.len().checked_sub(width).ok_or(Error::Truncated)?;
        let mut tail = Cursor::new(&data[at..]);
        let state = (tail.le(width)? & (u32::MAX >> (34 - width * 8)))
            .checked_add(base)
            .ok_or(Error::Overflow)?;
        Ok(Self {
            data,
            at,
            state,
            base,
        })
    }
    fn refill(&mut self) -> Result<()> {
        while self.state < self.base {
            self.at = self.at.checked_sub(1).ok_or(Error::Truncated)?;
            self.state = self
                .state
                .checked_mul(256)
                .and_then(|v| v.checked_add(u32::from(self.data[self.at])))
                .ok_or(Error::Overflow)?;
        }
        Ok(())
    }
    pub fn binary(&mut self, p0: u8) -> Result<bool> {
        self.refill()?;
        let p = 256 - u32::from(p0);
        let q = self.state / 256;
        let r = self.state % 256;
        let value = r < p;
        self.state = if value {
            q * p + r
        } else {
            self.state - q * p - p
        };
        Ok(value)
    }
    fn symbol(&mut self, table: &Table) -> Result<u32> {
        self.refill()?;
        let rem = (self.state % table.precision) as usize;
        let sym = table.lookup[rem] as usize;
        self.state = (self.state / table.precision) * table.prob[sym] + rem as u32 - table.cum[sym];
        Ok(sym as u32)
    }
}

struct Table {
    precision: u32,
    prob: Vec<u32>,
    cum: Vec<u32>,
    lookup: Vec<u32>,
}
impl Table {
    fn read(c: &mut Cursor, precision: u32, budget: &mut Budget) -> Result<Self> {
        let n = if c.version < 0x200 {
            c.le(4)? as usize
        } else {
            c.count()?
        };
        if n == 0 {
            return Err(Error::Invalid);
        }
        if n > 16_777_216 {
            return Err(Error::Limit);
        }
        // Even a zero run describes at most 64 symbols per input byte.
        if n.div_ceil(64) > c.data.len() - c.at {
            return Err(Error::Truncated);
        }
        let mut prob = budget.vector(n, 0_u32)?;
        let mut i = 0;
        while i < n {
            budget.steps(1)?;
            let first = c.byte()?;
            let token = first & 3;
            if token == 3 {
                i = i
                    .checked_add(usize::from(first >> 2) + 1)
                    .ok_or(Error::Overflow)?;
                if i > n {
                    return Err(Error::Invalid);
                }
            } else {
                let mut p = u32::from(first >> 2);
                for b in 0..token {
                    p |= u32::from(c.byte()?) << (6 + u32::from(b) * 8);
                }
                if p > precision {
                    return Err(Error::Invalid);
                }
                prob[i] = p;
                i += 1;
            }
        }
        let mut cum = budget.vector(n, 0_u32)?;
        let mut lookup = budget.vector(precision as usize, 0_u32)?;
        let mut total = 0_u32;
        for i in 0..n {
            cum[i] = total;
            let end = total.checked_add(prob[i]).ok_or(Error::Overflow)?;
            if end > precision {
                return Err(Error::Invalid);
            }
            lookup[total as usize..end as usize].fill(i as u32);
            total = end;
        }
        if total != precision {
            return Err(Error::Invalid);
        }
        Ok(Self {
            precision,
            prob,
            cum,
            lookup,
        })
    }
}

pub(crate) fn symbols(
    c: &mut Cursor,
    count: usize,
    components: usize,
    budget: &mut Budget,
) -> Result<Vec<u32>> {
    let mut out = budget.vector(count, 0_u32)?;
    if count == 0 {
        return Ok(out);
    }
    if components == 0 || !count.is_multiple_of(components) {
        return Err(Error::Invalid);
    }
    budget.steps(count)?;
    match c.byte()? {
        0 => {
            let table = Table::read(c, 4096, budget)?;
            let mut ans = Ans::new(
                if c.version < 0x200 {
                    c.fixed_blob(64)?
                } else {
                    c.blob(64)?
                },
                16384,
            )?;
            let start = c.at;
            let mut bits = Bits::new(&c.data[start..]);
            for row in out.chunks_exact_mut(components) {
                let width = ans.symbol(&table)?;
                if width > 32 {
                    return Err(Error::Invalid);
                }
                for v in row {
                    *v = bits.read(width)?;
                }
            }
            c.take(bits.used_bytes())?;
        }
        1 => {
            let max_bits = c.byte()?;
            if max_bits == 0 || max_bits > 32 {
                return Err(Error::Invalid);
            }
            let precision_bits = (u32::from(max_bits) * 3 / 2).clamp(12, 20);
            let precision = 1 << precision_bits;
            let table = Table::read(c, precision, budget)?;
            let mut ans = Ans::new(
                if c.version < 0x200 {
                    c.fixed_blob(64)?
                } else {
                    c.blob(64)?
                },
                precision * 4,
            )?;
            for value in &mut out {
                *value = ans.symbol(&table)?;
            }
        }
        _ => return Err(Error::Invalid),
    }
    Ok(out)
}
