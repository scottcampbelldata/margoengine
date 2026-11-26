use crate::vector::{Vec3, floor};
use crate::{item, item_mut};

const END: u32 = 0;

#[repr(C)]
pub struct Bucket {
    cell: [i32; 3],
    head: u32,
}

pub struct Grid<'a> {
    buckets: &'a mut [Bucket],
    next: &'a mut [u32],
    used: &'a mut [u32],
    occupied: usize,
    inverse_h: f64,
}

impl<'a> Grid<'a> {
    pub fn new(
        buckets: &'a mut [Bucket],
        next: &'a mut [u32],
        used: &'a mut [u32],
        inverse_h: f64,
    ) -> Self {
        Self {
            buckets,
            next,
            used,
            occupied: 0,
            inverse_h,
        }
    }

    pub fn clear(&mut self) {
        for index in 0..self.occupied {
            item_mut(self.buckets, *item(self.used, index) as usize).head = END;
        }
        self.occupied = 0;
    }

    fn cell(&self, p: Vec3) -> [i32; 3] {
        p.map(|x| floor(x * self.inverse_h) as i32)
    }

    fn slot(&self, cell: [i32; 3]) -> usize {
        let mask = self.buckets.len() - 1;
        let [x, y, z] = cell.map(|v| v as u32);
        // Teschner et al. 2003, section 4.1. Probing compares the full signed cell key.
        let key =
            x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663) ^ z.wrapping_mul(83_492_791);
        let mut index = (key as usize) & mask;
        while item(self.buckets, index).head != END && item(self.buckets, index).cell != cell {
            index = (index + 1) & mask;
        }
        index
    }

    pub fn insert(&mut self, p: Vec3, id: usize) {
        let cell = self.cell(p);
        let index = self.slot(cell);
        let bucket = item_mut(self.buckets, index);
        if bucket.head == END {
            *item_mut(self.used, self.occupied) = index as u32;
            self.occupied += 1;
        }
        *item_mut(self.next, id) = bucket.head;
        bucket.cell = cell;
        bucket.head = id as u32 + 1;
    }

    pub fn nearby(&self, p: Vec3, mut visit: impl FnMut(usize)) {
        let cell = self.cell(p);
        for z in -1..=1 {
            for y in -1..=1 {
                for x in -1..=1 {
                    let Some(ix) = cell[0].checked_add(x) else {
                        continue;
                    };
                    let Some(iy) = cell[1].checked_add(y) else {
                        continue;
                    };
                    let Some(iz) = cell[2].checked_add(z) else {
                        continue;
                    };
                    let mut id = item(self.buckets, self.slot([ix, iy, iz])).head;
                    while id != END {
                        let point = (id - 1) as usize;
                        visit(point);
                        id = *item(self.next, point);
                    }
                }
            }
        }
    }
}
