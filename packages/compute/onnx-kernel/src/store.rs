use crate::tensor::{Result, Tensor};
use crate::wire::Json;
use std::collections::HashMap;

#[derive(Clone)]
pub struct Node {
    pub op: String,
    pub domain: String,
}

pub struct Store {
    slots: Vec<Option<Tensor>>,
    free: Vec<u32>,
    storage: HashMap<usize, (usize, usize)>,
    pub live_bytes: usize,
    pub limit: usize,
    pub attribute_sets: Vec<Vec<Json>>,
    pub nodes: Vec<Node>,
    pub random: HashMap<u32, crate::random::Random>,
    pub random_seed: u64,
    pub random_stream: u32,
}
impl Store {
    pub fn new() -> Self {
        Self {
            slots: vec![None],
            free: vec![],
            storage: HashMap::new(),
            live_bytes: 0,
            limit: 256 * 1024 * 1024,
            attribute_sets: Vec::new(),
            nodes: Vec::new(),
            random: HashMap::new(),
            random_seed: 0,
            random_stream: 0,
        }
    }
    fn key(t: &Tensor) -> usize {
        if let Some(s) = &t.strings {
            std::sync::Arc::as_ptr(s) as usize
        } else {
            std::sync::Arc::as_ptr(&t.data) as usize
        }
    }
    pub fn insert(&mut self, t: Tensor) -> Result<u32> {
        let key = Self::key(&t);
        let bytes = t.bytes();
        if let Some(entry) = self.storage.get_mut(&key) {
            entry.0 += 1;
        } else {
            let next = self
                .live_bytes
                .checked_add(bytes)
                .ok_or("model storage overflow; reduce the model size")?;
            if next > self.limit {
                return Err(format!("model live tensor storage {next} exceeds {} bytes; release outputs or raise memoryLimit",self.limit));
            }
            self.storage.insert(key, (1, bytes));
            self.live_bytes = next;
        }
        if let Some(id) = self.free.pop() {
            self.slots[id as usize] = Some(t);
            Ok(id)
        } else {
            if self.slots.len() >= 1_000_001 {
                self.uncharge(&t);
                return Err(
                    "model exceeds one million live tensor handles; release intermediate tensors"
                        .into(),
                );
            }
            let id = self.slots.len() as u32;
            self.slots.push(Some(t));
            Ok(id)
        }
    }
    pub fn get(&self, id: u32) -> Result<&Tensor> {
        let t = self.raw(id)?;
        if t.kind == 8 {
            if t.strings.as_ref().map(|s| s.len()) != Some(t.size()) {
                return Err(
                    "string initializer has not been loaded; finish resolving model data".into(),
                );
            }
        } else if t.data.len() != crate::tensor::byte_len(t.kind, t.size())? {
            return Err(
                "external/sparse initializer has not been loaded; finish resolving model data"
                    .into(),
            );
        }
        Ok(t)
    }
    pub fn raw(&self, id: u32) -> Result<&Tensor> {
        self.slots
            .get(id as usize)
            .and_then(Option::as_ref)
            .ok_or_else(|| {
                format!("tensor handle {id} is not live; retain it until its consumers finish")
            })
    }
    pub fn replace(&mut self, id: u32, t: Tensor) -> Result<()> {
        self.raw(id)?;
        let new_id = self.insert(t)?;
        let replacement = self.slots[new_id as usize].take().unwrap();
        self.free.push(new_id);
        let old = self.slots[id as usize].replace(replacement).unwrap();
        self.uncharge(&old);
        Ok(())
    }
    pub fn attributes(&mut self, attrs: Vec<Json>) -> usize {
        let id = self.attribute_sets.len();
        self.attribute_sets.push(attrs);
        id
    }
    pub fn node(&mut self, op: String, domain: String) -> usize {
        let id = self.nodes.len();
        self.nodes.push(Node { op, domain });
        id
    }
    pub fn resolve_attributes(&mut self, id: usize, scopes: &[usize]) -> Result<usize> {
        let source = self
            .attribute_sets
            .get(id)
            .ok_or("attribute set is invalid; compile a parsed model node")?;
        let mut resolved = Vec::new();
        for attr in source {
            let reference = attr
                .field("reference")
                .ok_or("attribute reference metadata is missing; recompile the model")?
                .string()?;
            if reference.is_empty() {
                resolved.push(attr.clone());
                continue;
            }
            let mut bound = None;
            for &scope in scopes {
                let values = self
                    .attribute_sets
                    .get(scope)
                    .ok_or("function scope is invalid; resolve its caller attributes")?;
                if let Some(value) = values
                    .iter()
                    .find(|v| v.field("name").and_then(|s| s.string().ok()) == Some(reference))
                {
                    bound = Some(value);
                    break;
                }
            }
            if let Some(bound) = bound {
                if attr.field("kind").and_then(|v| v.integer().ok())
                    != bound.field("kind").and_then(|v| v.integer().ok())
                {
                    return Err(format!("function attribute {reference} has the wrong type; supply the declared attribute type"));
                }
                if !bound
                    .field("reference")
                    .ok_or("function attribute metadata is missing; recompile it")?
                    .string()?
                    .is_empty()
                {
                    return Err("function caller attributes are unresolved; resolve outer function scopes first".into());
                }
                resolved.push(Json::object([
                    ("name", attr.field("name").unwrap().clone()),
                    ("kind", bound.field("kind").unwrap().clone()),
                    ("reference", Json::s("")),
                    ("value", bound.field("value").unwrap().clone()),
                ]));
            }
            // An omitted function attribute leaves the operator's own default in force (ONNX IR).
        }
        Ok(self.attributes(resolved))
    }
    fn uncharge(&mut self, t: &Tensor) {
        let key = Self::key(t);
        if let Some(e) = self.storage.get_mut(&key) {
            e.0 -= 1;
            if e.0 == 0 {
                self.live_bytes -= e.1;
                self.storage.remove(&key);
            }
        }
    }
    pub fn drop_tensor(&mut self, id: u32) -> Result<()> {
        let slot = self
            .slots
            .get_mut(id as usize)
            .ok_or("tensor handle is invalid; release only owned tensors")?;
        let t = slot
            .take()
            .ok_or("tensor handle was already released; release it once")?;
        self.uncharge(&t);
        self.free.push(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_share_budget_and_release_exactly_once() {
        let mut s = Store::new();
        s.limit = 16;
        let t = Tensor::zeros(11, vec![2]).unwrap();
        let a = s.insert(t.clone()).unwrap();
        let b = s.insert(t.reshape(vec![1, 2]).unwrap()).unwrap();
        assert_eq!(s.live_bytes, 16);
        assert!(s.insert(Tensor::zeros(1, vec![1]).unwrap()).is_err());
        s.drop_tensor(a).unwrap();
        assert_eq!(s.live_bytes, 16);
        s.drop_tensor(b).unwrap();
        assert_eq!(s.live_bytes, 0);
        assert!(s.drop_tensor(b).is_err());
    }
}
