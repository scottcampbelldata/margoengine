// Private per-model Wasm ABI. Calls are synchronous; every returned byte view is
// copied by the TS boundary before another call can grow memory or reuse scratch.
use crate::{
    attrs::Attrs,
    conversion, element, indexing, linear, loss, misc, ml, ml_linear, ml_svm, ml_tree,
    normalization,
    proto::Parser,
    random, recurrent, resize, schema, shape, signal, spatial,
    store::Store,
    strings,
    tensor::{Result, Tensor},
    vision,
    wire::{text, Json},
};
#[cfg(test)]
use std::sync::Arc;

static mut STORE: Option<Store> = None;
static mut SCRATCH: Vec<u8> = Vec::new();
static mut MESSAGE: Vec<u8> = Vec::new();
static mut OUTPUTS: Vec<u32> = Vec::new();
unsafe fn store() -> &'static mut Store {
    STORE.get_or_insert_with(Store::new)
}
unsafe fn failure(e: String) -> i32 {
    MESSAGE = e.into_bytes();
    -1
}
unsafe fn message(json: Json) -> i32 {
    MESSAGE = json.encode().into_bytes();
    0
}
fn u32_at(bytes: &[u8], at: &mut usize) -> Result<u32> {
    let end = at
        .checked_add(4)
        .filter(|&n| n <= bytes.len())
        .ok_or("incomplete Wasm command; supply a complete input packet")?;
    let v = u32::from_le_bytes(bytes[*at..end].try_into().unwrap());
    *at = end;
    Ok(v)
}
unsafe fn ids(n: usize) -> Result<Vec<u32>> {
    if n > 1_000_000 || n.checked_mul(4).filter(|&v| v <= SCRATCH.len()).is_none() {
        return Err("Wasm handle packet has the wrong size; supply one handle per input".into());
    }
    let mut at = 0;
    (0..n).map(|_| u32_at(&SCRATCH, &mut at)).collect()
}

#[no_mangle]
pub unsafe extern "C" fn reserve(n: usize) -> u32 {
    if n > 536_870_912 {
        failure("Wasm packet exceeds 512 MiB; use external weights or smaller input chunks".into());
        return u32::MAX;
    }
    SCRATCH.resize(n, 0);
    SCRATCH.as_mut_ptr() as usize as u32
}
#[no_mangle]
pub unsafe extern "C" fn message_ptr() -> u32 {
    MESSAGE.as_ptr() as usize as u32
}
#[no_mangle]
pub unsafe extern "C" fn message_len() -> usize {
    MESSAGE.len()
}
#[no_mangle]
pub unsafe extern "C" fn memory_limit(bytes: usize) -> i32 {
    let s = store();
    if bytes < 65536 || bytes > 1_073_741_824 || bytes < s.live_bytes {
        return failure("memoryLimit must be 64 KiB..1 GiB and at least current live storage; choose a valid budget".into());
    }
    s.limit = bytes;
    0
}
#[no_mangle]
pub unsafe extern "C" fn load_model(n: usize) -> i32 {
    if n > SCRATCH.len() {
        return failure("model packet is incomplete; supply the complete ONNX file".into());
    }
    let limit = store().limit;
    let mut state = Store::new();
    state.limit = limit;
    let result = Parser::new(&mut state).model(&SCRATCH[..n]);
    let status = match result {
        Ok(json) => {
            STORE = Some(state);
            message(json)
        }
        Err(e) => failure(e),
    };
    SCRATCH = Vec::new();
    status
}
#[no_mangle]
pub unsafe extern "C" fn create_tensor(kind: u32, rank: usize, n: usize) -> i32 {
    let run = || -> Result<u32> {
        if n > SCRATCH.len() || rank > 1_000_000 {
            return Err("tensor packet is incomplete or rank exceeds its limit; supply valid tensor dimensions".into());
        }
        let data = &SCRATCH[..n];
        let mut at = 0;
        let dims = (0..rank)
            .map(|_| u32_at(data, &mut at).map(|v| v as usize))
            .collect::<Result<Vec<_>>>()?;
        let t = if kind == 8 {
            let count = u32_at(data, &mut at)? as usize;
            if count > crate::tensor::MAX_ELEMENTS {
                return Err("string tensor has too many elements; use smaller chunks".into());
            }
            let mut strings = Vec::with_capacity(count);
            for _ in 0..count {
                let len = u32_at(data, &mut at)? as usize;
                let end = at
                    .checked_add(len)
                    .filter(|&e| e <= data.len())
                    .ok_or("string tensor packet is truncated; supply complete UTF-8 strings")?;
                text(&data[at..end])?;
                strings.push(data[at..end].to_vec());
                at = end;
            }
            if at != data.len() {
                return Err(
                    "string tensor packet has trailing bytes; supply exactly the declared strings"
                        .into(),
                );
            }
            Tensor::text(dims, strings)?
        } else {
            Tensor::raw(kind, dims, data[at..].to_vec())?
        };
        store().insert(t)
    };
    match run() {
        Ok(id) => id as i32,
        Err(e) => failure(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn fill_external(id: u32, n: usize) -> i32 {
    let run = || -> Result<()> {
        if n > SCRATCH.len() {
            return Err(
                "external tensor packet is incomplete; load its complete byte range".into(),
            );
        }
        let original = store().raw(id)?;
        let kind = original.kind;
        let shape = original.shape.clone();
        let tensor = Tensor::raw(kind, shape, SCRATCH[..n].to_vec())?;
        store().replace(id, tensor)
    };
    match run() {
        Ok(()) => 0,
        Err(e) => failure(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn fill_sparse(id: u32, values_id: u32, indices_id: u32) -> i32 {
    let run = || -> Result<()> {
        let original = store().raw(id)?;
        let shape = original.shape.clone();
        let kind = original.kind;
        let values = store().get(values_id)?.clone();
        let indices = store().get(indices_id)?.clone();
        if values.kind != kind || values.shape.len() != 1 || indices.kind != 7 {
            return Err("sparse data needs matching one-dimensional values and int64 indices; repair the sparse initializer".into());
        }
        let nnz = values.size();
        let rank = shape.len();
        if !(indices.shape == [nnz] || indices.shape == [nnz, rank]) {
            return Err(
                "sparse indices must be [nnz] or [nnz,rank]; provide sorted sparse coordinates"
                    .into(),
            );
        }
        let mut output = Tensor::zeros(kind, shape.clone())?;
        let mut previous = None;
        for row in 0..nnz {
            let flat = if indices.shape.len() == 1 {
                let n = indices.get(row).i();
                if n < 0 || n as u64 >= output.size() as u64 {
                    return Err(
                        "sparse linear index is outside its tensor; supply valid indices".into(),
                    );
                }
                n as usize
            } else {
                let mut at = 0;
                for (k, &dim) in shape.iter().enumerate() {
                    let n = indices.get(row * rank + k).i();
                    if n < 0 || n as u64 >= dim as u64 {
                        return Err(
                            "sparse coordinate is outside its tensor; supply valid coordinates"
                                .into(),
                        );
                    }
                    at = at * dim + n as usize;
                }
                at
            };
            if previous.is_some_and(|p| flat <= p) {
                return Err("sparse indices must be unique and sorted in row-major order; sort and combine duplicates".into());
            }
            previous = Some(flat);
            output.copy_element(flat, &values, row);
        }
        store().replace(id, output)
    };
    match run() {
        Ok(()) => 0,
        Err(e) => failure(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn resolve_attributes(id: usize, n: usize) -> i32 {
    let run = || -> Result<usize> {
        let scopes = ids(n)?
            .into_iter()
            .map(|id| id as usize)
            .collect::<Vec<_>>();
        store().resolve_attributes(id, &scopes)
    };
    match run() {
        Ok(id) => {
            message(Json::Array(store().attribute_sets[id].clone()));
            id as i32
        }
        Err(e) => failure(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn supported(node_id: usize, version: u32) -> i32 {
    let Some(node) = store().nodes.get(node_id) else {
        return failure("node handle is invalid; load and compile a model node".into());
    };
    if node.domain == "ai.onnx.ml" {
        return ((1..=5).contains(&version)
            && (ml::supports(&node.op)
                || ml_linear::supports(&node.op)
                || ml_tree::supports(&node.op, version)
                || ml_svm::supports(&node.op))) as i32;
    }
    if version < schema::minimum(&node.op) || version > 28 {
        return 0;
    }
    ((node.domain.is_empty() || node.domain == "ai.onnx")
        && (element::supports(&node.op)
            || shape::supports(&node.op)
            || indexing::supports(&node.op)
            || linear::supports(&node.op)
            || spatial::supports(&node.op)
            || normalization::supports(&node.op)
            || conversion::supports(&node.op)
            || recurrent::supports(&node.op)
            || resize::supports(&node.op)
            || random::supports(&node.op)
            || misc::supports(&node.op)
            || vision::supports(&node.op)
            || loss::supports(&node.op)
            || signal::supports(&node.op)
            || strings::supports(&node.op))) as i32
}
#[no_mangle]
pub unsafe extern "C" fn random_seed(lo: u32, hi: u32) {
    store().random_seed = lo as u64 | (hi as u64) << 32;
}
#[no_mangle]
pub unsafe extern "C" fn random_stream(id: u32) {
    store().random_stream = id;
}
#[no_mangle]
pub unsafe extern "C" fn execute(
    node_id: usize,
    attribute_id: usize,
    version: u32,
    n: usize,
    nout: usize,
) -> i32 {
    OUTPUTS.clear();
    let run = || -> Result<Vec<Tensor>> {
        let node = store()
            .nodes
            .get(node_id)
            .ok_or("node handle is invalid; load a valid model node")?
            .clone();
        if !node.domain.is_empty() && node.domain != "ai.onnx" && node.domain != "ai.onnx.ml" {
            return Err(format!("unsupported operator {}:{}; register the domain or expand its model-local function",node.domain,node.op));
        }
        if version == 0 || version > 28 {
            return Err("operator opset is outside 1..28; export a supported ONNX opset".into());
        }
        let inputs = ids(n)?
            .iter()
            .map(|&id| {
                if id == 0 {
                    Ok(None)
                } else {
                    Ok(Some(store().get(id)?.clone()))
                }
            })
            .collect::<Result<Vec<_>>>()?;
        let entries = store()
            .attribute_sets
            .get(attribute_id)
            .ok_or("node attributes are invalid; resolve the parsed attribute set")?
            .clone();
        let attrs = Attrs {
            entries: &entries,
            store: store(),
        };
        if node.domain == "ai.onnx.ml" {
            if !(1..=5).contains(&version) {
                return Err("ai.onnx.ml opset must be 1..5; repair model imports".into());
            }
            if ml_linear::supports(&node.op) {
                ml_linear::validate(&node.op, inputs.len(), nout, &attrs)?;
                return ml_linear::execute(&node.op, &inputs, &attrs);
            }
            if ml_tree::supports(&node.op, version) {
                ml_tree::validate(&node.op, version, inputs.len(), nout, &attrs)?;
                return ml_tree::execute(&node.op, &inputs, &attrs);
            }
            if ml_svm::supports(&node.op) {
                ml_svm::validate(&node.op, inputs.len(), nout, &attrs)?;
                return ml_svm::execute(&node.op, &inputs, &attrs);
            }
            ml::validate(&node.op, version, inputs.len(), nout, &attrs)?;
            return ml::execute(&node.op, &inputs, &attrs, version);
        }
        schema::validate(&node.op, version, inputs.len(), nout, &attrs)?;
        if random::supports(&node.op) {
            let stream = store().random_stream;
            let seed = random::seed(&node.op, &attrs, store().random_seed)?;
            let mut rng = store().random.get(&stream).cloned().unwrap_or_else(|| {
                random::Random::new(seed, if attrs.has("seed") { 0 } else { stream })
            });
            let result = random::execute(&node.op, &inputs, &attrs, version, nout, &mut rng)?;
            store().random.insert(stream, rng);
            Ok(result)
        } else if element::supports(&node.op) {
            element::execute(&node.op, &inputs, &attrs, version)
        } else if shape::supports(&node.op) {
            shape::execute(&node.op, &inputs, &attrs)
        } else if indexing::supports(&node.op) {
            indexing::execute(&node.op, &inputs, &attrs, nout)
        } else if linear::supports(&node.op) {
            linear::execute(&node.op, &inputs, &attrs, version)
        } else if spatial::supports(&node.op) {
            spatial::execute(&node.op, &inputs, &attrs, nout)
        } else if normalization::supports(&node.op) {
            normalization::execute(&node.op, &inputs, &attrs, version, nout)
        } else if conversion::supports(&node.op) {
            conversion::execute(&node.op, &inputs, &attrs)
        } else if recurrent::supports(&node.op) {
            recurrent::execute(&node.op, &inputs, &attrs)
        } else if strings::supports(&node.op) {
            strings::execute(&node.op, &inputs, &attrs)
        } else if signal::supports(&node.op) {
            signal::execute(&node.op, &inputs, &attrs, version)
        } else if loss::supports(&node.op) {
            loss::execute(&node.op, &inputs, &attrs, nout)
        } else if vision::supports(&node.op) {
            vision::execute(&node.op, &inputs, &attrs, version)
        } else if misc::supports(&node.op) {
            misc::execute(&node.op, &inputs, &attrs, nout)
        } else if resize::supports(&node.op) {
            resize::execute(&node.op, &inputs, &attrs, version)
        } else {
            Err(format!(
                "unsupported ONNX operator {}; use an implemented kernel or model-local function",
                node.op
            ))
        }
    };
    match run() {
        Err(e) => failure(e),
        Ok(tensors) => {
            let mut inserted = Vec::new();
            for tensor in tensors {
                match store().insert(tensor) {
                    Ok(id) => inserted.push(id),
                    Err(e) => {
                        for id in inserted {
                            let _ = store().drop_tensor(id);
                        }
                        return failure(e);
                    }
                }
            }
            OUTPUTS = inserted;
            OUTPUTS.len() as i32
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn output(i: usize) -> u32 {
    OUTPUTS.get(i).copied().unwrap_or(0)
}
#[no_mangle]
pub unsafe extern "C" fn describe(id: u32) -> i32 {
    let run = || -> Result<Json> {
        let t = store().get(id)?;
        let strings = match &t.strings {
            None => Json::Null,
            Some(s) => Json::Array(
                s.iter()
                    .map(|s| Ok(Json::s(text(s)?)))
                    .collect::<Result<Vec<_>>>()?,
            ),
        };
        Ok(Json::object([
            ("kind", Json::n(t.kind as usize)),
            (
                "shape",
                Json::Array(t.shape.iter().map(|&d| Json::n(d)).collect()),
            ),
            ("strings", strings),
        ]))
    };
    match run() {
        Ok(json) => message(json),
        Err(e) => failure(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn data_ptr(id: u32) -> u32 {
    match store().get(id) {
        Ok(t) => t.data.as_ptr() as usize as u32,
        Err(e) => {
            failure(e);
            u32::MAX
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn data_len(id: u32) -> usize {
    match store().get(id) {
        Ok(t) => t.data.len(),
        Err(e) => {
            failure(e);
            usize::MAX
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn scalar_bool(id: u32) -> i32 {
    match store().get(id) {
        Ok(t) if t.kind == 9 && t.size() == 1 => t.get(0).nonzero() as i32,
        _ => failure(
            "control-flow condition needs one bool value; supply a scalar bool tensor".into(),
        ),
    }
}
#[no_mangle]
pub unsafe extern "C" fn drop_tensor(id: u32) -> i32 {
    match store().drop_tensor(id) {
        Ok(()) => 0,
        Err(e) => failure(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn live_bytes() -> usize {
    store().live_bytes
}
#[no_mangle]
pub unsafe extern "C" fn slice_tensor(id: u32, axis: i32, index: i32, keep: i32) -> i32 {
    let run = || -> Result<u32> {
        let x = store().get(id)?.clone();
        let d = crate::tensor::axis(axis as i64, x.shape.len())?;
        let size = x.shape[d];
        let at = if index < 0 {
            index as i64 + size as i64
        } else {
            index as i64
        };
        if at < 0 || at >= size as i64 {
            return Err("slice index is outside its axis; supply an in-range index".into());
        }
        let inner = crate::tensor::product(&x.shape[d + 1..])?;
        let outer = crate::tensor::product(&x.shape[..d])?;
        let mut dims = x.shape.clone();
        if keep != 0 {
            dims[d] = 1;
        } else {
            dims.remove(d);
        }
        let mut y = Tensor::zeros(x.kind, dims)?;
        if y.size() > 0 {
            for p in 0..outer {
                for q in 0..inner {
                    y.copy_element(p * inner + q, &x, (p * size + at as usize) * inner + q);
                }
            }
        }
        store().insert(y)
    };
    match run() {
        Ok(id) => id as i32,
        Err(e) => failure(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn concat_tensors(axis: i32, new_axis: i32, n: usize) -> i32 {
    let run = || -> Result<u32> {
        let tensors = ids(n)?
            .iter()
            .map(|&id| store().get(id).cloned())
            .collect::<Result<Vec<_>>>()?;
        let first = tensors
            .first()
            .ok_or("cannot concatenate an empty sequence; provide tensor elements")?;
        let rank = first.shape.len();
        let d = crate::tensor::axis(axis as i64, rank + if new_axis != 0 { 1 } else { 0 })?;
        let mut dims = first.shape.clone();
        for t in &tensors {
            crate::attrs::same_type(first, t)?;
            if t.shape.len() != rank {
                return Err(
                    "concatenated tensors must have equal rank; supply compatible shapes".into(),
                );
            }
            for j in 0..rank {
                if (new_axis != 0 || j != d) && t.shape[j] != first.shape[j] {
                    return Err("concatenated tensor dimensions differ outside the axis; supply compatible shapes".into());
                }
            }
        }
        if new_axis != 0 {
            dims.insert(d, n);
        } else {
            dims[d] = tensors.iter().try_fold(0usize, |s, t| {
                s.checked_add(t.shape[d])
                    .ok_or("concatenated axis overflow; use smaller inputs")
            })?;
        }
        let mut y = Tensor::zeros(first.kind, dims.clone())?;
        if y.size() > 0 {
            let inner = crate::tensor::product(&dims[d + 1..])?;
            let outer = crate::tensor::product(&dims[..d])?;
            for p in 0..outer {
                let mut start = 0;
                for t in &tensors {
                    let width = if new_axis != 0 { 1 } else { t.shape[d] };
                    for q in 0..width * inner {
                        y.copy_element((p * dims[d] + start) * inner + q, t, p * width * inner + q);
                    }
                    start += width;
                }
            }
        }
        store().insert(y)
    };
    match run() {
        Ok(id) => id as i32,
        Err(e) => failure(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn simd_groups() -> u64 {
    element::SIMD_GROUPS
}
#[no_mangle]
pub unsafe extern "C" fn release() {
    STORE = None;
    SCRATCH = Vec::new();
    MESSAGE = Vec::new();
    OUTPUTS = Vec::new();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_initializer_and_sparse_replacement_are_atomic() {
        let mut s = Store::new();
        let pending = Tensor {
            kind: 7,
            shape: vec![3],
            data: Arc::new(vec![]),
            strings: None,
        };
        let id = s.insert(pending).unwrap();
        assert!(s.get(id).is_err());
        s.replace(id, Tensor::vector_i64(&[9007199254740993, -1, 4]).unwrap())
            .unwrap();
        assert_eq!(s.get(id).unwrap().get(0).i(), 9007199254740993);
        assert_eq!(s.live_bytes, 24);
        s.drop_tensor(id).unwrap();
        assert_eq!(s.live_bytes, 0);
    }
}
