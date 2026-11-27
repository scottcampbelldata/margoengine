//! Metadata syntax from the specification, with E19's observed varint value sizes.
//! A flat arena keeps parsing and dropping independent of metadata nesting depth.
use crate::{Budget, Error, Result, cursor::Cursor};

#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct MetadataEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
}
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MetadataNode {
    pub entries: Vec<MetadataEntry>,
    pub children: Vec<(Vec<u8>, usize)>,
}
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Metadata {
    pub nodes: Vec<MetadataNode>,
    /// Attribute unique ID and root node index, in bitstream order.
    pub attributes: Vec<(u32, usize)>,
    pub file: usize,
}

fn push<T>(values: &mut Vec<T>, value: T, budget: &mut Budget) -> Result<()> {
    if values.len() == values.capacity() {
        let capacity = if values.capacity() == 0 {
            4
        } else {
            values.capacity().checked_mul(2).ok_or(Error::Overflow)?
        };
        let extra = capacity - values.capacity();
        budget.charge(extra, std::mem::size_of::<T>())?;
        values.try_reserve_exact(extra).map_err(|_| Error::Limit)?;
    }
    values.push(value);
    Ok(())
}
fn bytes(c: &mut Cursor, count: usize, budget: &mut Budget) -> Result<Vec<u8>> {
    let source = c.take(count)?;
    let mut out = budget.vector(count, 0_u8)?;
    out.copy_from_slice(source);
    Ok(out)
}
/// E49: one node's children have distinct names; entry keys and attribute ids
/// may repeat.
fn distinct_names(children: &[(Vec<u8>, usize)], budget: &mut Budget) -> Result<()> {
    let count = children.len();
    if count < 2 {
        return Ok(());
    }
    budget.steps(count.saturating_mul(count.ilog2() as usize + 1))?;
    let mut names = budget.vector(count, &[][..])?;
    for (name, child) in names.iter_mut().zip(children) {
        *name = child.0.as_slice();
    }
    heap_sort(&mut names);
    if names.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(Error::Invalid);
    }
    Ok(())
}
/// In place and O(n log n) on any input; the standard sort over byte slices
/// adds 11 KB to the module.
fn heap_sort(names: &mut [&[u8]]) {
    fn sift(names: &mut [&[u8]], mut at: usize) {
        loop {
            let mut child = 2 * at + 1;
            if child >= names.len() {
                return;
            }
            if child + 1 < names.len() && names[child] < names[child + 1] {
                child += 1;
            }
            if names[at] >= names[child] {
                return;
            }
            names.swap(at, child);
            at = child;
        }
    }
    for at in (0..names.len() / 2).rev() {
        sift(names, at);
    }
    for end in (1..names.len()).rev() {
        names.swap(0, end);
        sift(&mut names[..end], 0);
    }
}
impl Metadata {
    fn node(&mut self, c: &mut Cursor, budget: &mut Budget) -> Result<usize> {
        let count = c.count()?;
        if count > (c.data.len() - c.at) / 2 {
            return Err(Error::Truncated);
        }
        budget.steps(count)?;
        let mut entries = budget.vector(count, MetadataEntry::default())?;
        for entry in &mut entries {
            let key = usize::from(c.byte()?);
            entry.key = bytes(c, key, budget)?;
            // E19: 127/128/255/256/1024/16384-byte values distinguish this
            // varUI32 field from the specification's UI8 typo.
            let value = c.count()?;
            if value == 0 {
                return Err(Error::Invalid);
            }
            entry.value = bytes(c, value, budget)?;
        }
        let count = c.count()?;
        if count > (c.data.len() - c.at) / 3 {
            return Err(Error::Truncated);
        }
        budget.steps(count)?;
        let children = budget.vector(count, (Vec::<u8>::new(), 0_usize))?;
        let id = self.nodes.len();
        push(&mut self.nodes, MetadataNode { entries, children }, budget)?;
        Ok(id)
    }
    fn tree(&mut self, c: &mut Cursor, budget: &mut Budget) -> Result<usize> {
        let root = self.node(c, budget)?;
        let mut stack = Vec::new();
        push(&mut stack, (root, 0_usize), budget)?;
        while let Some(&(parent, next)) = stack.last() {
            budget.steps(1)?;
            if next == self.nodes[parent].children.len() {
                distinct_names(&self.nodes[parent].children, budget)?;
                stack.pop();
                continue;
            }
            let count = usize::from(c.byte()?);
            let name = bytes(c, count, budget)?;
            let child = self.node(c, budget)?;
            self.nodes[parent].children[next] = (name, child);
            stack.last_mut().ok_or(Error::Invalid)?.1 += 1;
            push(&mut stack, (child, 0), budget)?;
        }
        Ok(root)
    }
    pub(crate) fn read(c: &mut Cursor, budget: &mut Budget) -> Result<Self> {
        let count = c.count()?;
        if count > (c.data.len() - c.at) / 3 {
            return Err(Error::Truncated);
        }
        let mut out = Self {
            attributes: budget.vector(count, (0_u32, 0_usize))?,
            ..Self::default()
        };
        for i in 0..count {
            let id = c.count()? as u32;
            let root = out.tree(c, budget)?;
            out.attributes[i] = (id, root);
        }
        out.file = out.tree(c, budget)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::heap_sort;

    #[test]
    fn heap_sort_orders_every_short_sequence() {
        // Every sequence of up to six names drawn from four.
        let pool: [&[u8]; 4] = [b"", b"a", b"ab", b"b"];
        for length in 0..=6_u32 {
            for code in 0..4_usize.pow(length) {
                let mut names: Vec<&[u8]> = (0..length)
                    .map(|i| pool[code / 4_usize.pow(i) % 4])
                    .collect();
                let mut expected = names.clone();
                expected.sort();
                heap_sort(&mut names);
                assert_eq!(names, expected);
            }
        }
    }
}
