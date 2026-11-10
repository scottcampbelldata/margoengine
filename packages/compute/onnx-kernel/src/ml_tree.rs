// Original implementation of the ONNX ai.onnx.ml tree schemas, not a training library.
use crate::attrs::{input, Attrs};
use crate::ml_linear::post;
use crate::tensor::{Number, Result, Tensor, MAX_ELEMENTS};
use std::collections::{BTreeMap, VecDeque};

pub fn supports(op: &str, version: u32) -> bool {
    matches!(op, "TreeEnsembleClassifier" | "TreeEnsembleRegressor")
        || op == "TreeEnsemble" && version >= 5
}
pub fn validate(op: &str, version: u32, n: usize, nout: usize, a: &Attrs) -> Result<()> {
    if n != 1 || nout != if op == "TreeEnsembleClassifier" { 2 } else { 1 } {
        return Err(
            "tree ensemble needs one input and its declared outputs; repair node arity".into(),
        );
    }
    if op == "TreeEnsemble" {
        return a.known(&[
            "aggregate_function",
            "leaf_targetids",
            "leaf_weights",
            "membership_values",
            "n_targets",
            "nodes_falseleafs",
            "nodes_falsenodeids",
            "nodes_featureids",
            "nodes_hitrates",
            "nodes_missing_value_tracks_true",
            "nodes_modes",
            "nodes_splits",
            "nodes_trueleafs",
            "nodes_truenodeids",
            "post_transform",
            "tree_roots",
        ]);
    }
    let mut names = vec![
        "nodes_treeids",
        "nodes_nodeids",
        "nodes_featureids",
        "nodes_modes",
        "nodes_values",
        "nodes_truenodeids",
        "nodes_falsenodeids",
        "nodes_missing_value_tracks_true",
        "nodes_hitrates",
        "base_values",
        "post_transform",
    ];
    if op == "TreeEnsembleClassifier" {
        names.extend([
            "class_ids",
            "class_nodeids",
            "class_treeids",
            "class_weights",
            "classlabels_int64s",
            "classlabels_strings",
        ]);
        if version >= 3 {
            names.push("class_weights_as_tensor");
        }
    } else {
        names.extend([
            "aggregate_function",
            "n_targets",
            "target_ids",
            "target_nodeids",
            "target_treeids",
            "target_weights",
        ]);
        if version >= 3 {
            names.push("target_weights_as_tensor");
        }
    }
    if version >= 3 {
        names.extend([
            "base_values_as_tensor",
            "nodes_values_as_tensor",
            "nodes_hitrates_as_tensor",
        ]);
    }
    a.known(&names)
}
fn ints(a: &Attrs, name: &str) -> Result<Vec<i64>> {
    a.ints(name)?
        .ok_or_else(|| format!("tree attribute {name} is required; provide its node tuples"))
}
fn index(n: i64, bound: usize, name: &str) -> Result<usize> {
    if n < 0 || n as u64 >= bound as u64 {
        Err(format!(
            "tree {name} index {n} is outside {bound}; repair the tree encoding"
        ))
    } else {
        Ok(n as usize)
    }
}
fn same(n: usize, lengths: &[usize]) -> Result<()> {
    if lengths.iter().any(|&m| m != n) {
        Err("tree tuple lengths differ; provide one value per node or leaf".into())
    } else {
        Ok(())
    }
}
fn values(a: &Attrs, name: &str) -> Result<Vec<f64>> {
    let tensor_name = format!("{name}_as_tensor");
    if a.has(name) && a.has(&tensor_name) {
        return Err(format!(
            "tree has both {name} and {tensor_name}; use only one encoding"
        ));
    }
    if let Some(t) = a.tensor(&tensor_name)? {
        if !matches!(t.kind, 1 | 11) || t.shape.len() != 1 {
            return Err(format!(
                "tree {tensor_name} must be a float or double vector; repair its type"
            ));
        }
        Ok((0..t.size()).map(|i| t.get(i).f()).collect())
    } else {
        Ok(a.floats(name)?.unwrap_or_default())
    }
}
fn tensor_values(a: &Attrs, name: &str, kind: u32) -> Result<Vec<f64>> {
    let t = a
        .tensor(name)?
        .ok_or_else(|| format!("tree tensor {name} is required; supply it"))?;
    if t.kind != kind || t.shape.len() != 1 {
        return Err(format!(
            "tree {name} must be a type {kind} vector matching its input; repair its type"
        ));
    }
    Ok((0..t.size()).map(|i| t.get(i).f()).collect())
}
#[derive(Clone)]
enum Node {
    Branch {
        feature: usize,
        mode: u8,
        split: f64,
        yes: usize,
        no: usize,
        missing: bool,
        members: Vec<f64>,
    },
    Leaf(Vec<(usize, f64)>),
}
struct Forest {
    nodes: Vec<Node>,
    roots: Vec<usize>,
    targets: usize,
    base: Vec<f64>,
    aggregate: u8,
    transform: String,
    single_class: bool,
    positive_weights: bool,
}
fn mode(name: &str) -> Result<u8> {
    match name {
        "BRANCH_LEQ" => Ok(0),
        "BRANCH_LT" => Ok(1),
        "BRANCH_GTE" => Ok(2),
        "BRANCH_GT" => Ok(3),
        "BRANCH_EQ" => Ok(4),
        "BRANCH_NEQ" => Ok(5),
        _ => Err(format!(
            "unknown tree mode {name}; choose an ONNX branch comparison"
        )),
    }
}
fn aggregate(name: &str) -> Result<u8> {
    match name {
        "AVERAGE" => Ok(0),
        "SUM" => Ok(1),
        "MIN" => Ok(2),
        "MAX" => Ok(3),
        _ => Err("tree aggregation must be AVERAGE, SUM, MIN or MAX; repair attribute".into()),
    }
}
fn transform(n: i64) -> Result<&'static str> {
    match n {
        0 => Ok("NONE"),
        1 => Ok("SOFTMAX"),
        2 => Ok("LOGISTIC"),
        3 => Ok("SOFTMAX_ZERO"),
        4 => Ok("PROBIT"),
        _ => Err("tree post_transform must be 0..4; repair attribute".into()),
    }
}
fn flags(a: &Attrs, name: &str, n: usize) -> Result<Vec<i64>> {
    let v = a.ints(name)?.unwrap_or_else(|| vec![0; n]);
    same(n, &[v.len()])?;
    if v.iter().any(|&x| x != 0 && x != 1) {
        return Err(format!(
            "tree {name} must contain boolean flags; use 0 or 1"
        ));
    }
    Ok(v)
}
fn compile(op: &str, a: &Attrs, features: usize, kind: u32) -> Result<Forest> {
    let modern = op == "TreeEnsemble";
    let classifier = op == "TreeEnsembleClassifier";
    let label_i = a.ints("classlabels_int64s")?;
    let label_s = a.strings("classlabels_strings")?;
    let targets = if classifier {
        if label_i.is_some() == label_s.is_some() {
            return Err(
                "tree classifier needs exactly one label list; supply integer or string labels"
                    .into(),
            );
        }
        label_i
            .as_ref()
            .map_or_else(|| label_s.as_ref().unwrap().len(), Vec::len)
    } else {
        let n = a.int("n_targets", 1)?;
        if n < 1 || n as u64 > MAX_ELEMENTS as u64 {
            return Err(
                "tree n_targets is outside 1..16777216; use a supported target count".into(),
            );
        }
        n as usize
    };
    if targets == 0 || targets > MAX_ELEMENTS {
        return Err("tree requires 1..16777216 labels; supply class labels".into());
    }
    let mut nodes = Vec::new();
    let roots;
    let base;
    let agg;
    let post_mode;
    let single_class;
    let positive_weights;
    if modern {
        let feature = ints(a, "nodes_featureids")?;
        let n = feature.len();
        let yes = ints(a, "nodes_truenodeids")?;
        let no = ints(a, "nodes_falsenodeids")?;
        let yl = ints(a, "nodes_trueleafs")?;
        let nl = ints(a, "nodes_falseleafs")?;
        let modes = tensor_values(a, "nodes_modes", 2)?;
        let splits = tensor_values(a, "nodes_splits", kind)?;
        let weights = tensor_values(a, "leaf_weights", kind)?;
        let target = ints(a, "leaf_targetids")?;
        same(
            n,
            &[
                yes.len(),
                no.len(),
                yl.len(),
                nl.len(),
                modes.len(),
                splits.len(),
            ],
        )?;
        same(weights.len(), &[target.len()])?;
        if n.checked_add(weights.len())
            .is_none_or(|v| v > MAX_ELEMENTS)
        {
            return Err("tree node and leaf count exceeds 16777216; split the forest".into());
        }
        let missing = flags(a, "nodes_missing_value_tracks_true", n)?;
        if let Some(t) = a.tensor("nodes_hitrates")? {
            same(n, &[t.size()])?;
        }
        let member = if a.has("membership_values") {
            tensor_values(a, "membership_values", kind)?
        } else {
            vec![]
        };
        let mut at = 0;
        for i in 0..n {
            let m = modes[i] as u8;
            if m > 6 {
                return Err("tree nodes_modes must contain 0..6; repair comparison modes".into());
            }
            let mut members = Vec::new();
            if m == 6 {
                while at < member.len() && !member[at].is_nan() {
                    members.push(member[at]);
                    at += 1;
                }
                if at == member.len() {
                    return Err(
                        "tree membership sets require NaN delimiters; terminate every set".into(),
                    );
                }
                at += 1;
            }
            let child = |id: i64, leaf: i64| -> Result<usize> {
                match leaf {
                    0 => index(id, n, "branch"),
                    1 => Ok(n + index(id, weights.len(), "leaf")?),
                    _ => Err("tree leaf flags must be 0 or 1; repair child flags".into()),
                }
            };
            nodes.push(Node::Branch {
                feature: index(feature[i], features, "feature")?,
                mode: m,
                split: splits[i],
                yes: child(yes[i], yl[i])?,
                no: child(no[i], nl[i])?,
                missing: missing[i] != 0,
                members,
            });
        }
        if at != member.len() {
            return Err("tree membership_values has unused sets; provide exactly one delimited set per membership node".into());
        }
        for i in 0..weights.len() {
            nodes.push(Node::Leaf(vec![(
                index(target[i], targets, "target")?,
                weights[i],
            )]));
        }
        roots = ints(a, "tree_roots")?
            .into_iter()
            .map(|r| index(r, n, "root"))
            .collect::<Result<Vec<_>>>()?;
        let ag = a.int("aggregate_function", 1)?;
        if !(0..=3).contains(&ag) {
            return Err("tree aggregate_function must be 0..3; repair attribute".into());
        }
        agg = ag as u8;
        post_mode = transform(a.int("post_transform", 0)?)?.to_owned();
        base = vec![];
        single_class = false;
        positive_weights = false;
    } else {
        let trees = ints(a, "nodes_treeids")?;
        let ids = ints(a, "nodes_nodeids")?;
        let feature = ints(a, "nodes_featureids")?;
        let modes = a
            .strings("nodes_modes")?
            .ok_or("tree nodes_modes is required; supply branch and leaf modes")?;
        let splits = values(a, "nodes_values")?;
        let yes = ints(a, "nodes_truenodeids")?;
        let no = ints(a, "nodes_falsenodeids")?;
        let n = ids.len();
        if n > MAX_ELEMENTS {
            return Err("tree node count exceeds 16777216; split the forest".into());
        }
        same(
            n,
            &[
                trees.len(),
                feature.len(),
                modes.len(),
                splits.len(),
                yes.len(),
                no.len(),
            ],
        )?;
        let missing = flags(a, "nodes_missing_value_tracks_true", n)?;
        let hitrates = values(a, "nodes_hitrates")?;
        if !hitrates.is_empty() {
            same(n, &[hitrates.len()])?;
        }
        let mut lookup = BTreeMap::new();
        for i in 0..n {
            if trees[i] < 0 || ids[i] < 0 || lookup.insert((trees[i], ids[i]), i).is_some() {
                return Err("tree node identifiers must be nonnegative and unique within each tree; repair node tuples".into());
            }
        }
        let mut degree = vec![0usize; n];
        for i in 0..n {
            if modes[i] == "LEAF" {
                nodes.push(Node::Leaf(vec![]));
                continue;
            }
            let child = |id: i64| {
                lookup
                    .get(&(trees[i], id))
                    .copied()
                    .ok_or("tree child does not exist in its tree; repair child IDs".to_owned())
            };
            let y = child(yes[i])?;
            let z = child(no[i])?;
            degree[y] += 1;
            degree[z] += 1;
            nodes.push(Node::Branch {
                feature: index(feature[i], features, "feature")?,
                mode: mode(modes[i])?,
                split: splits[i],
                yes: y,
                no: z,
                missing: missing[i] != 0,
                members: vec![],
            });
        }
        let mut tree_roots = BTreeMap::new();
        for i in 0..n {
            if degree[i] == 0 && tree_roots.insert(trees[i], i).is_some() {
                return Err("tree has multiple disconnected roots; repair its topology".into());
            }
        }
        let distinct = trees
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if tree_roots.len() != distinct.len() {
            return Err("tree has no root or contains a cycle; repair its topology".into());
        }
        roots = tree_roots.into_values().collect();
        let prefix = if classifier { "class" } else { "target" };
        let tids = ints(a, &format!("{prefix}_treeids"))?;
        let nids = ints(a, &format!("{prefix}_nodeids"))?;
        let target = ints(a, &format!("{prefix}_ids"))?;
        let weights = values(a, &format!("{prefix}_weights"))?;
        same(weights.len(), &[tids.len(), nids.len(), target.len()])?;
        single_class = classifier && targets == 2 && target.iter().all(|&v| v == 0);
        positive_weights = weights.iter().all(|&w| w >= 0.);
        for i in 0..weights.len() {
            let id = lookup
                .get(&(tids[i], nids[i]))
                .ok_or("tree weight refers to an unknown node; repair weight IDs")?;
            let t = index(target[i], targets, "target")?;
            if let Node::Leaf(v) = &mut nodes[*id] {
                v.push((t, weights[i]));
            } else {
                return Err("tree weights must refer to leaves; repair weight node IDs".into());
            }
        }
        base = values(a, "base_values")?;
        if !base.is_empty()
            && base.len() != targets
            && !(classifier && targets == 2 && base.len() == 1)
        {
            return Err(
                "tree base_values must match targets or one binary margin; repair base values"
                    .into(),
            );
        }
        agg = if classifier {
            1
        } else {
            aggregate(a.string("aggregate_function", "SUM")?)?
        };
        post_mode = a.string("post_transform", "NONE")?.to_owned();
    }
    if roots.is_empty() {
        return Err("tree ensemble needs at least one tree root; supply a nonempty forest".into());
    }
    // Kahn's algorithm checks every branch, including unreachable malicious cycles, without recursion.
    let mut indegree = vec![0usize; nodes.len()];
    for node in &nodes {
        if let Node::Branch { yes, no, .. } = node {
            indegree[*yes] += 1;
            indegree[*no] += 1;
        }
    }
    let mut queue: VecDeque<_> = indegree
        .iter()
        .enumerate()
        .filter_map(|(i, &n)| (n == 0).then_some(i))
        .collect();
    let mut count = 0;
    while let Some(i) = queue.pop_front() {
        count += 1;
        if let Node::Branch { yes, no, .. } = nodes[i] {
            for j in [yes, no] {
                indegree[j] -= 1;
                if indegree[j] == 0 {
                    queue.push_back(j);
                }
            }
        }
    }
    if count != nodes.len() {
        return Err("tree contains a cycle; provide acyclic branch references".into());
    }
    post(&mut [], &post_mode)?;
    Ok(Forest {
        nodes,
        roots,
        targets,
        base,
        aggregate: agg,
        transform: post_mode,
        single_class,
        positive_weights,
    })
}
fn test_branch(v: Number, split: f64, mode: u8, missing: bool, members: &[f64]) -> bool {
    if v.f().is_nan() {
        return missing;
    }
    let ordering = match v {
        Number::I(n) if !split.is_nan() => {
            use std::cmp::Ordering::*;
            Some(if split < i64::MIN as f64 {
                Greater
            } else if split >= 9223372036854775808. {
                Less
            } else {
                let c = n.cmp(&(split as i64));
                if c != Equal {
                    c
                } else if split.fract() > 0. {
                    Less
                } else if split.fract() < 0. {
                    Greater
                } else {
                    Equal
                }
            })
        }
        _ => v.f().partial_cmp(&split),
    };
    use std::cmp::Ordering::*;
    match mode {
        0 => matches!(ordering, Some(Less | Equal)),
        1 => ordering == Some(Less),
        2 => matches!(ordering, Some(Greater | Equal)),
        3 => ordering == Some(Greater),
        4 => ordering == Some(Equal),
        5 => ordering != Some(Equal),
        6 => members.contains(&v.f()),
        _ => unreachable!(),
    }
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let modern = op == "TreeEnsemble";
    let classifier = op == "TreeEnsembleClassifier";
    if x.shape.len() != 2
        || if modern {
            !matches!(x.kind, 1 | 10 | 11)
        } else {
            !matches!(x.kind, 1 | 6 | 7 | 11)
        }
    {
        return Err(
            "tree input must be a supported numeric [N,F] tensor; repair its type/shape".into(),
        );
    }
    let (rows, features) = (x.shape[0], x.shape[1]);
    let f = compile(op, a, features, x.kind)?;
    let mut out = Tensor::zeros(if modern { x.kind } else { 1 }, vec![rows, f.targets])?;
    let mut chosen = Vec::with_capacity(rows);
    for row in 0..rows {
        let mut scores = vec![0.; f.targets];
        let mut seen = vec![false; f.targets];
        for &root in &f.roots {
            let mut id = root;
            loop {
                match &f.nodes[id] {
                    Node::Branch {
                        feature,
                        mode,
                        split,
                        yes,
                        no,
                        missing,
                        members,
                    } => {
                        id = if test_branch(
                            x.get(row * features + feature),
                            *split,
                            *mode,
                            *missing,
                            members,
                        ) {
                            *yes
                        } else {
                            *no
                        };
                    }
                    Node::Leaf(v) => {
                        let mut leaf = BTreeMap::new();
                        for &(target, weight) in v {
                            *leaf.entry(target).or_insert(0.) += weight;
                        }
                        for (t, w) in leaf {
                            scores[t] = if !seen[t] {
                                w
                            } else {
                                match f.aggregate {
                                    0 | 1 => scores[t] + w,
                                    2 => scores[t].min(w),
                                    3 => scores[t].max(w),
                                    _ => unreachable!(),
                                }
                            };
                            seen[t] = true;
                        }
                        break;
                    }
                }
            }
        }
        if f.aggregate == 0 {
            for s in &mut scores {
                *s /= f.roots.len() as f64;
            }
        }
        if f.single_class {
            let margin = scores[0] + if f.base.len() == 1 { f.base[0] } else { 0. };
            chosen.push(usize::from(
                margin > if f.positive_weights { 0.5 } else { 0. },
            ));
            scores = if f.transform == "LOGISTIC" {
                vec![-margin, margin]
            } else if f.positive_weights {
                vec![1. - margin, margin]
            } else {
                vec![-margin, margin]
            };
            if f.base.len() == 2 {
                // Two explicit base scores apply to their classes after reconstructing a binary pair.
                let raw = scores[0] + f.base[0];
                scores[0] = raw;
                scores[1] += f.base[1];
                *chosen.last_mut().unwrap() = usize::from(scores[1] > scores[0]);
            }
        } else {
            for (t, s) in scores.iter_mut().enumerate() {
                *s += f.base.get(t).copied().unwrap_or(0.);
            }
            let mut best = 0;
            for t in 1..f.targets {
                if scores[t] > scores[best] {
                    best = t;
                }
            }
            chosen.push(best);
        }
        if !f.single_class || !matches!(f.transform.as_str(), "SOFTMAX" | "SOFTMAX_ZERO") {
            post(&mut scores, &f.transform)?;
        }
        for (j, s) in scores.into_iter().enumerate() {
            out.set(row * f.targets + j, Number::F(s));
        }
    }
    if !classifier {
        return Ok(vec![out]);
    }
    let labels = if let Some(v) = a.ints("classlabels_int64s")? {
        let mut t = Tensor::zeros(7, vec![rows])?;
        for (i, c) in chosen.into_iter().enumerate() {
            t.set(i, Number::I(v[c]));
        }
        t
    } else {
        let v = a.strings("classlabels_strings")?.unwrap();
        Tensor::text(
            vec![rows],
            chosen
                .into_iter()
                .map(|c| v[c].as_bytes().to_vec())
                .collect(),
        )?
    };
    Ok(vec![labels, out])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn branch_modes_nan_and_membership() {
        assert!(test_branch(
            Number::I(9007199254740993),
            9007199254740992.,
            3,
            false,
            &[]
        ));
        assert!(!test_branch(
            Number::I(i64::MAX),
            9223372036854775808.,
            4,
            false,
            &[]
        ));
        assert!(test_branch(Number::I(-1), -1.5, 3, false, &[]));
        for (m, at, low, high) in [
            (0, true, true, false),
            (1, false, true, false),
            (2, true, false, true),
            (3, false, false, true),
            (4, true, false, false),
            (5, false, true, true),
        ] {
            assert_eq!(test_branch(Number::F(2.), 2., m, false, &[]), at);
            assert_eq!(test_branch(Number::F(1.), 2., m, false, &[]), low);
            assert_eq!(test_branch(Number::F(3.), 2., m, false, &[]), high);
            assert!(!test_branch(Number::F(f64::NAN), 2., m, false, &[]));
            assert!(test_branch(Number::F(f64::NAN), 2., m, true, &[]));
        }
        assert!(test_branch(Number::F(-0.), 0., 6, false, &[0., 3.]));
        assert!(!test_branch(Number::F(2.), 0., 6, false, &[0., 3.]));
    }
}
