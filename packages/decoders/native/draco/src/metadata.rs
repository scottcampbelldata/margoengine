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
