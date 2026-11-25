// Deterministic sorting (K03 of docs/physics-solvers.md): a least significant digit radix sort over 64-bit entries of
// `key << 32 | id`, ordered by key and, for equal keys, by id. The order is total, so it never depends on the order the entries
// came in, on a hash, or on a thread count (docs/physics-framework.md, section 7, rule 4). Integer work only. The method is the
// counting sort of H. H. Seward (1954, "Information sorting in the application of electronic digital computers to business
// operations", MIT Report R-232) applied a byte at a time to the key, as described in T. Cormen, C. Leiserson, R. Rivest and
// C. Stein, "Introduction to Algorithms", chapter 8.
use alloc::vec::Vec;

/// The entry of key `key` and id `id`.
#[inline]
pub fn entry(key: u32, id: u32) -> u64 {
    (key as u64) << 32 | id as u64
}

/// The key and the id of an entry.
#[inline]
pub fn split(entry: u64) -> (u32, u32) {
    ((entry >> 32) as u32, entry as u32)
}

/// Sorts `key << 32 | id` entries by key and then id, which is their order as numbers (least significant digit first, a byte a
/// pass, over all eight bytes; a pass whose byte is the same in every entry is skipped). Give every entry a distinct id and the
/// order is total whatever order they arrive in.
pub fn radix_sort(items: &mut Vec<u64>, spare: &mut Vec<u64>) {
    spare.clear();
    spare.resize(items.len(), 0);
    for byte in 0..8 {
        let shift = byte * 8;
        let mut count = [0u32; 256];
        for &x in items.iter() {
            count[(x >> shift) as usize & 255] += 1;
        }
        if count.iter().any(|&n| n as usize == items.len()) {
            continue;
        }
        let mut at = 0u32;
        for n in count.iter_mut() {
            let here = *n;
            *n = at;
            at += here;
        }
        for &x in items.iter() {
            let d = (x >> shift) as usize & 255;
            spare[count[d] as usize] = x;
            count[d] += 1;
        }
        core::mem::swap(items, spare);
    }
}
