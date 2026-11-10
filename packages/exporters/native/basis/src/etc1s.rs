use crate::uastc::distortion;
use std::collections::{BTreeMap, BinaryHeap};

// ETC1S selector order and base-color expansion from KTX2 appendix D.
const DELTAS: [[i32; 4]; 8] = [
    [-8, -2, 2, 8],
    [-17, -5, 5, 17],
    [-29, -9, 9, 29],
    [-42, -13, 13, 42],
    [-60, -18, 18, 60],
    [-80, -24, 24, 80],
    [-106, -33, 33, 106],
    [-183, -47, 47, 183],
];
fn expand(v: u8) -> i32 {
    ((v << 3) | (v >> 2)) as i32
}
fn quantize(v: f64) -> u8 {
    (0..32u8)
        .min_by(|&a, &b| {
            (expand(a) as f64 - v)
                .abs()
                .total_cmp(&(expand(b) as f64 - v).abs())
        })
        .unwrap()
}

#[cfg(test)]
fn assign(pixels: &[[u8; 4]; 16], base: [u8; 3], table: usize) -> (u32, u64) {
    assign_metric(pixels, base, table, [1, 1, 1, 0])
}
fn assign_metric(
    pixels: &[[u8; 4]; 16],
    base: [u8; 3],
    table: usize,
    metric: [i32; 4],
) -> (u32, u64) {
    let palette: [[u8; 4]; 4] = std::array::from_fn(|s| {
        [
            (expand(base[0]) + DELTAS[table][s]).clamp(0, 255) as u8,
            (expand(base[1]) + DELTAS[table][s]).clamp(0, 255) as u8,
            (expand(base[2]) + DELTAS[table][s]).clamp(0, 255) as u8,
            255,
        ]
    });
    let mut selectors = 0;
    let mut error = 0;
    for (t, pixel) in pixels.iter().enumerate() {
        let (s, e) = palette
            .iter()
            .enumerate()
            .map(|(i, p)| (i, distortion(pixel, p, metric)))
            .min_by_key(|&(_, e)| e)
            .unwrap();
        selectors |= (s as u32) << (t * 2);
        error += e as u64;
    }
    (selectors, error)
}

#[derive(Clone)]
struct Cluster {
    indices: Vec<usize>,
    score: u64,
    axis: usize,
}
impl PartialEq for Cluster {
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score && self.indices[0] == other.indices[0]
    }
}
impl Eq for Cluster {}
impl PartialOrd for Cluster {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Cluster {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.score
            .cmp(&other.score)
            .then_with(|| other.indices[0].cmp(&self.indices[0]))
    }
}
fn cluster(indices: Vec<usize>, features: &[Vec<i32>], weights: &[u64]) -> Cluster {
    let weight = indices.iter().map(|&i| weights[i]).sum::<u64>();
    let mut axis = 0;
    let mut score = 0;
    for c in 0..features[0].len() {
        let sum = indices
            .iter()
            .map(|&i| features[i][c] as i64 * weights[i] as i64)
            .sum::<i64>();
        let variance = indices
            .iter()
            .map(|&i| {
                let d = features[i][c] as i64 - sum / weight as i64;
                (d * d) as u64 * weights[i]
            })
            .sum();
        if variance > score {
            score = variance;
            axis = c;
        }
    }
    Cluster {
        indices,
        score,
        axis,
    }
}
fn groups(features: &[Vec<i32>], weights: &[u64], budget: usize) -> Vec<Vec<usize>> {
    let mut heap = BinaryHeap::new();
    heap.push(cluster((0..features.len()).collect(), features, weights));
    while heap.len() < budget {
        let Some(mut group) = heap.pop() else { break };
        if group.indices.len() < 2 || group.score == 0 {
            heap.push(group);
            break;
        }
        group.indices.sort_by_key(|&i| (features[i][group.axis], i));
        let mid = group.indices.len() / 2;
        let right = group.indices.split_off(mid);
        heap.push(cluster(group.indices, features, weights));
        heap.push(cluster(right, features, weights));
    }
    heap.into_iter().map(|g| g.indices).collect()
}
fn budget(quality: u32, count: usize, selectors: bool) -> usize {
    // Endpoints are cheap, while a selector vector spends 32 bits plus a slice
    // reference. Give the two VQ spaces separate monotone rate budgets instead
    // of spending the same fraction of unrelated vector populations on each.
    let fraction = quality as f64 / 255.0;
    let fraction = if selectors {
        fraction.powi(3)
    } else {
        fraction.sqrt()
    };
    ((count as f64 * fraction).ceil() as usize)
        .max(((quality + 7) / 8) as usize)
        .min(count)
        .clamp(1, 16128)
}
#[cfg(test)]
fn palette_error(pixels: &[[u8; 4]; 16], endpoint: [u8; 4], selectors: u32) -> u64 {
    pixels
        .iter()
        .enumerate()
        .map(|(t, p)| {
            let s = ((selectors >> (t * 2)) & 3) as usize;
            (0..3)
                .map(|c| {
                    let d = (expand(endpoint[c]) + DELTAS[endpoint[3] as usize][s]).clamp(0, 255)
                        - p[c] as i32;
                    (d * d) as u64
                })
                .sum::<u64>()
        })
        .sum()
}

struct SelectorNode {
    low: [u8; 16],
    high: [u8; 16],
    children: Option<(Box<SelectorNode>, Box<SelectorNode>)>,
    leaves: Vec<usize>,
    rate: u64,
}
impl SelectorNode {
    fn build(book: &[u32], rates: &[u64], mut indices: Vec<usize>) -> Self {
        let rate = indices.iter().map(|&i| rates[i]).min().unwrap();
        let low = std::array::from_fn(|t| {
            indices
                .iter()
                .map(|&i| ((book[i] >> (t * 2)) & 3) as u8)
                .min()
                .unwrap()
        });
        let high = std::array::from_fn(|t| {
            indices
                .iter()
                .map(|&i| ((book[i] >> (t * 2)) & 3) as u8)
                .max()
                .unwrap()
        });
        if indices.len() <= 4 {
            return Self {
                low,
                high,
                children: None,
                leaves: indices,
                rate,
            };
        }
        let axis = (0..16).max_by_key(|&t| high[t] - low[t]).unwrap();
        indices.sort_by_key(|&i| (((book[i] >> (axis * 2)) & 3), i));
        let right = indices.split_off(indices.len() / 2);
        Self {
            low,
            high,
            children: Some((
                Box::new(Self::build(book, rates, indices)),
                Box::new(Self::build(book, rates, right)),
            )),
            leaves: Vec::new(),
            rate,
        }
    }
    fn lower_bound(&self, cost: &[[u32; 4]; 16]) -> u64 {
        (0..16)
            .map(|t| {
                cost[t][self.low[t] as usize..=self.high[t] as usize]
                    .iter()
                    .copied()
                    .min()
                    .unwrap() as u64
            })
            .sum()
    }
    fn nearest(
        &self,
        book: &[u32],
        rates: &[u64],
        rate_weight: u64,
        cost: &[[u32; 4]; 16],
        best: &mut (usize, u64),
    ) {
        if let Some((left, right)) = &self.children {
            let l = left.lower_bound(cost) + left.rate * rate_weight / 4096;
            let r = right.lower_bound(cost) + right.rate * rate_weight / 4096;
            let (first, a, second, b) = if l <= r {
                (left, l, right, r)
            } else {
                (right, r, left, l)
            };
            if a < best.1 {
                first.nearest(book, rates, rate_weight, cost, best);
            }
            if b < best.1 {
                second.nearest(book, rates, rate_weight, cost, best);
            }
        } else {
            for &i in &self.leaves {
                let error = selector_cost(book[i], cost) + rates[i] * rate_weight / 4096;
                if error < best.1 {
                    *best = (i, error);
                }
            }
        }
    }
}
fn selector_cost(pattern: u32, cost: &[[u32; 4]; 16]) -> u64 {
    (0..16)
        .map(|t| cost[t][((pattern >> (t * 2)) & 3) as usize] as u64)
        .sum()
}
fn refine_selectors(
    pixels: &[[[u8; 4]; 16]],
    fitted: &mut [([u8; 4], u32)],
    effort: u32,
    metric: [i32; 4],
) {
    let costs: Vec<[[u32; 4]; 16]> = pixels
        .iter()
        .zip(fitted.iter())
        .map(|(pixels, (endpoint, _))| {
            std::array::from_fn(|t| {
                std::array::from_fn(|s| {
                    (0..3)
                        .map(|c| {
                            let d = (expand(endpoint[c]) + DELTAS[endpoint[3] as usize][s])
                                .clamp(0, 255)
                                - pixels[t][c] as i32;
                            (d * d * metric[c]) as u32
                        })
                        .sum()
                })
            })
        })
        .collect();
    let mut book: Vec<u32> = fitted
        .iter()
        .map(|p| p.1)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    // Never exceed the normative global selector limit.
    for flat in [0, 0x55555555, 0xaaaaaaaa, 0xffffffff] {
        if book.len() < 16128 && !book.contains(&flat) {
            book.push(flat);
        }
    }
    // SSIM's contrast normalization motivates a smaller rate penalty in
    // smooth blocks: a fixed absolute penalty otherwise erases low-contrast
    // data. Retain the global entropy scale in highly textured blocks.
    let rate_weights: Vec<u64> = pixels
        .iter()
        .map(|block| {
            let variance: u64 = (0..3)
                .map(|c| {
                    let sum = block.iter().map(|p| p[c] as u64).sum::<u64>();
                    let square = block.iter().map(|p| (p[c] as u64).pow(2)).sum::<u64>();
                    (16 * square - sum * sum) * metric[c] as u64
                })
                .sum();
            (variance * 4096 / (256 * 128 * metric[..3].iter().sum::<i32>() as u64)).min(4096)
        })
        .collect();
    let mut assignments = vec![0; pixels.len()];
    let lambda = metric[..3].iter().sum::<i32>() as f64 * 32.0;
    for pass in 0..=1 + effort / 2 {
        let lookup: BTreeMap<_, _> = book.iter().enumerate().map(|(i, &s)| (s, i)).collect();
        let mut counts = vec![1usize; book.len()];
        for &(_, selectors) in fitted.iter() {
            counts[lookup[&selectors]] += 1;
        }
        let total = (pixels.len() + book.len()) as f64;
        let rates: Vec<u64> = counts
            .iter()
            .map(|&n| (lambda * (total / n as f64).log2()).round() as u64)
            .collect();
        let tree = SelectorNode::build(&book, &rates, (0..book.len()).collect());
        for (i, p) in fitted.iter_mut().enumerate() {
            let initial = lookup.get(&p.1).copied().unwrap_or(0);
            let mut best = (
                initial,
                selector_cost(book[initial], &costs[i]) + rates[initial] * rate_weights[i] / 4096,
            );
            tree.nearest(&book, &rates, rate_weights[i], &costs[i], &mut best);
            assignments[i] = best.0;
            p.1 = book[best.0];
        }
        if pass == 1 + effort / 2 {
            break;
        }
        let mut total = vec![[[0u64; 4]; 16]; book.len()];
        let mut used = vec![false; book.len()];
        for (cost, &cluster) in costs.iter().zip(&assignments) {
            used[cluster] = true;
            for t in 0..16 {
                for s in 0..4 {
                    total[cluster][t][s] += cost[t][s] as u64;
                }
            }
        }
        for (i, pattern) in book.iter_mut().enumerate() {
            if !used[i] {
                continue;
            }
            let mut next = 0;
            for t in 0..16 {
                let s = (0..4).min_by_key(|&s| total[i][t][s]).unwrap();
                next |= (s as u32) << (t * 2);
            }
            *pattern = next;
        }
        // Keep each block in its updated cluster before the next exact nearest
        // search, so every Lloyd pass starts from a non-increasing candidate.
        for (p, &cluster) in fitted.iter_mut().zip(&assignments) {
            p.1 = book[cluster];
        }
    }
}

// Sufficient statistics for the exact clamped ETC palette with fixed selectors.
// Each reconstruction channel is constant inside a selector bin, so no pixel
// loop is needed for endpoint searches or shared endpoint updates.
#[derive(Clone, Default)]
struct Moments {
    count: [i64; 4],
    sum: [[i64; 3]; 4],
    square: [[i64; 3]; 4],
}
impl Moments {
    fn add(&mut self, pixels: &[[u8; 4]; 16], selectors: u32) {
        for (t, pixel) in pixels.iter().enumerate() {
            let s = ((selectors >> (t * 2)) & 3) as usize;
            self.count[s] += 1;
            for c in 0..3 {
                let v = pixel[c] as i64;
                self.sum[s][c] += v;
                self.square[s][c] += v * v;
            }
        }
    }
    fn channel_cost(&self, c: usize, base: u8, table: usize) -> u64 {
        (0..4)
            .map(|s| {
                let v = (expand(base) + DELTAS[table][s]).clamp(0, 255) as i64;
                (self.square[s][c] - 2 * v * self.sum[s][c] + v * v * self.count[s]) as u64
            })
            .sum()
    }
    fn cost(&self, endpoint: [u8; 4], metric: [i32; 4]) -> u64 {
        (0..3)
            .map(|c| self.channel_cost(c, endpoint[c], endpoint[3] as usize) * metric[c] as u64)
            .sum()
    }
    fn optimum(&self, incumbent: [u8; 4], metric: [i32; 4]) -> [u8; 4] {
        let mut best = (incumbent, self.cost(incumbent, metric));
        for table in 0..8 {
            let base: [u8; 3] = std::array::from_fn(|c| {
                (0..32u8)
                    .min_by_key(|&v| self.channel_cost(c, v, table))
                    .unwrap()
            });
            let endpoint = [base[0], base[1], base[2], table as u8];
            let error = self.cost(endpoint, metric);
            if error < best.1 {
                best = (endpoint, error);
            }
        }
        best.0
    }
}
fn palette(endpoint: [u8; 4]) -> [u8; 12] {
    std::array::from_fn(|i| {
        (expand(endpoint[i % 3]) + DELTAS[endpoint[3] as usize][i / 3]).clamp(0, 255) as u8
    })
}
struct EndpointNode {
    low: [u8; 12],
    high: [u8; 12],
    children: Option<(Box<EndpointNode>, Box<EndpointNode>)>,
    leaves: Vec<usize>,
}
impl EndpointNode {
    fn build(palettes: &[[u8; 12]], mut indices: Vec<usize>) -> Self {
        let low = std::array::from_fn(|c| indices.iter().map(|&i| palettes[i][c]).min().unwrap());
        let high = std::array::from_fn(|c| indices.iter().map(|&i| palettes[i][c]).max().unwrap());
        if indices.len() <= 4 {
            return Self {
                low,
                high,
                children: None,
                leaves: indices,
            };
        }
        let axis = (0..12).max_by_key(|&c| high[c] - low[c]).unwrap();
        indices.sort_by_key(|&i| (palettes[i][axis], i));
        let right = indices.split_off(indices.len() / 2);
        Self {
            low,
            high,
            children: Some((
                Box::new(Self::build(palettes, indices)),
                Box::new(Self::build(palettes, right)),
            )),
            leaves: Vec::new(),
        }
    }
    fn bound(&self, moments: &Moments, metric: [i32; 4]) -> u64 {
        let mut cost = 0;
        for s in 0..4 {
            let n = moments.count[s];
            if n == 0 {
                continue;
            }
            for c in 0..3 {
                let i = s * 3 + c;
                let v = ((moments.sum[s][c] + n / 2) / n)
                    .clamp(self.low[i] as i64, self.high[i] as i64);
                cost += (moments.square[s][c] - 2 * v * moments.sum[s][c] + n * v * v) as u64
                    * metric[c] as u64;
            }
        }
        cost
    }
    fn nearest(
        &self,
        book: &[[u8; 4]],
        moments: &Moments,
        metric: [i32; 4],
        best: &mut (usize, u64),
    ) {
        if let Some((left, right)) = &self.children {
            let l = left.bound(moments, metric);
            let r = right.bound(moments, metric);
            let (first, a, second, b) = if l <= r {
                (left, l, right, r)
            } else {
                (right, r, left, l)
            };
            if a < best.1 {
                first.nearest(book, moments, metric, best);
            }
            if b < best.1 {
                second.nearest(book, moments, metric, best);
            }
        } else {
            for &i in &self.leaves {
                let cost = moments.cost(book[i], metric);
                if cost < best.1 {
                    *best = (i, cost);
                }
            }
        }
    }
}
fn reassign_endpoints(pixels: &[[[u8; 4]; 16]], fitted: &mut [([u8; 4], u32)], metric: [i32; 4]) {
    let book: Vec<_> = fitted
        .iter()
        .map(|p| p.0)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let lookup: BTreeMap<_, _> = book.iter().enumerate().map(|(i, &e)| (e, i)).collect();
    let palettes: Vec<_> = book.iter().copied().map(palette).collect();
    let tree = EndpointNode::build(&palettes, (0..book.len()).collect());
    for (pixels, (endpoint, selectors)) in pixels.iter().zip(fitted.iter_mut()) {
        let mut moments = Moments::default();
        moments.add(pixels, *selectors);
        let mut best = (lookup[endpoint], moments.cost(*endpoint, metric));
        tree.nearest(&book, &moments, metric, &mut best);
        *endpoint = book[best.0];
    }
}
fn refine_endpoints(pixels: &[[[u8; 4]; 16]], fitted: &mut [([u8; 4], u32)], metric: [i32; 4]) {
    reassign_endpoints(pixels, fitted, metric);
    let mut groups = BTreeMap::<[u8; 4], Moments>::new();
    for (pixels, &(endpoint, selectors)) in pixels.iter().zip(fitted.iter()) {
        groups.entry(endpoint).or_default().add(pixels, selectors);
    }
    let updated: BTreeMap<_, _> = groups
        .iter()
        .map(|(&e, moments)| (e, moments.optimum(e, metric)))
        .collect();
    for (endpoint, _) in fitted.iter_mut() {
        *endpoint = updated[endpoint];
    }
}

fn palette_costs(pixels: &[[u8; 4]; 16], endpoint: [u8; 4], metric: [i32; 4]) -> [[u32; 4]; 16] {
    std::array::from_fn(|t| {
        std::array::from_fn(|s| {
            (0..3)
                .map(|c| {
                    let d = (expand(endpoint[c]) + DELTAS[endpoint[3] as usize][s]).clamp(0, 255)
                        - pixels[t][c] as i32;
                    (d * d * metric[c]) as u32
                })
                .sum()
        })
    })
}
// Independent-fit selector seeds can escape a coordinate-wise local minimum.
// Search only the existing books and retain each block's incumbent distortion.
fn polish_assignments(
    pixels: &[[[u8; 4]; 16]],
    fitted: &mut [([u8; 4], u32)],
    seeds: &[u32],
    metric: [i32; 4],
) {
    let endpoints: Vec<_> = fitted
        .iter()
        .map(|p| p.0)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let selectors: Vec<_> = fitted
        .iter()
        .map(|p| p.1)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let endpoint_lookup: BTreeMap<_, _> =
        endpoints.iter().enumerate().map(|(i, &e)| (e, i)).collect();
    let selector_lookup: BTreeMap<_, _> =
        selectors.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    let palettes: Vec<_> = endpoints.iter().copied().map(palette).collect();
    let endpoint_tree = EndpointNode::build(&palettes, (0..endpoints.len()).collect());
    let rates = vec![0; selectors.len()];
    let selector_tree = SelectorNode::build(&selectors, &rates, (0..selectors.len()).collect());
    for ((pixels, pair), &seed) in pixels.iter().zip(fitted.iter_mut()).zip(seeds) {
        let mut incumbent = *pair;
        let mut best_error =
            selector_cost(incumbent.1, &palette_costs(pixels, incumbent.0, metric));
        let mut candidate = (pair.0, seed);
        for _ in 0..3 {
            let mut moments = Moments::default();
            moments.add(pixels, candidate.1);
            let mut best_endpoint = (
                endpoint_lookup[&candidate.0],
                moments.cost(candidate.0, metric),
            );
            endpoint_tree.nearest(&endpoints, &moments, metric, &mut best_endpoint);
            candidate.0 = endpoints[best_endpoint.0];
            let costs = palette_costs(pixels, candidate.0, metric);
            let initial = selector_lookup[&incumbent.1];
            let mut best_selector = (initial, selector_cost(selectors[initial], &costs));
            selector_tree.nearest(&selectors, &rates, 0, &costs, &mut best_selector);
            candidate.1 = selectors[best_selector.0];
            if best_selector.1 < best_error {
                best_error = best_selector.1;
                incumbent = candidate;
            }
        }
        *pair = incumbent;
    }
}

// Wang et al. (2004), equation 13, on the local block support. This is
// a search surrogate; acceptance still uses the independent 11x11 image metric.
fn block_structure(pixels: &[[u8; 4]; 16], pair: ([u8; 4], u32)) -> f64 {
    let colors = palette(pair.0);
    (0..3).map(|c| {
        let mut x = 0.0; let mut y = 0.0;
        let mut xx = 0.0; let mut yy = 0.0; let mut xy = 0.0;
        for t in 0..16 {
            let a = pixels[t][c] as f64;
            let b = colors[((pair.1 >> (t * 2)) & 3) as usize * 3 + c] as f64;
            x += a; y += b; xx += a*a; yy += b*b; xy += a*b;
        }
        x /= 16.0; y /= 16.0;
        ((2.0*x*y+6.5025)*(2.0*(xy/16.0-x*y)+58.5225)) /
            ((x*x+y*y+6.5025)*(xx/16.0-x*x+yy/16.0-y*y+58.5225))
    }).sum::<f64>() / 3.0
}
fn contrast_metric(pixels: &[[u8; 4]; 16]) -> [i32; 4] {
    let mut metric = [0; 4];
    for c in 0..3 {
        let sum = pixels.iter().map(|p| p[c] as f64).sum::<f64>();
        let square = pixels.iter().map(|p| (p[c] as f64).powi(2)).sum::<f64>();
        let variance = square / 16.0 - (sum/16.0).powi(2);
        // Positive SSE term constrains large errors; the normalized term
        // prioritizes equally important low-contrast channels.
        metric[c] = (32.0 + 4096.0*58.5225/(2.0*variance+58.5225)).round() as i32;
    }
    metric
}
fn polish_structure(pixels: &[[[u8; 4]; 16]], fitted: &mut [([u8; 4], u32)], seeds: &[u32]) {
    let endpoints: Vec<_> = fitted.iter().map(|p| p.0)
        .collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let selectors: Vec<_> = fitted.iter().map(|p| p.1)
        .collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let el: BTreeMap<_,_> = endpoints.iter().enumerate().map(|(i,&e)| (e,i)).collect();
    let sl: BTreeMap<_,_> = selectors.iter().enumerate().map(|(i,&s)| (s,i)).collect();
    let palettes: Vec<_> = endpoints.iter().copied().map(palette).collect();
    let et = EndpointNode::build(&palettes, (0..endpoints.len()).collect());
    let rates = vec![0; selectors.len()];
    let st = SelectorNode::build(&selectors, &rates, (0..selectors.len()).collect());
    for ((block, pair), &seed) in pixels.iter().zip(fitted.iter_mut()).zip(seeds) {
        let metric = contrast_metric(block);
        let limit = selector_cost(pair.1, &palette_costs(block, pair.0, [1,1,1,0]));
        let mut best = *pair;
        let mut score = block_structure(block, best);
        let mut visited = Vec::new();
        for start in [pair.1, seed, 0, 0x55555555, 0xaaaaaaaa, 0xffffffff] {
            let mut candidate = (pair.0, start);
            for _ in 0..3 {
                if visited.contains(&candidate) { break; }
                visited.push(candidate);
                let mut moments = Moments::default(); moments.add(block, candidate.1);
                let mut e = (el[&candidate.0], moments.cost(candidate.0, metric));
                et.nearest(&endpoints, &moments, metric, &mut e);
                candidate.0 = endpoints[e.0];
                let costs = palette_costs(block, candidate.0, metric);
                let initial = sl[&pair.1];
                let mut sel = (initial, selector_cost(selectors[initial], &costs));
                st.nearest(&selectors, &rates, 0, &costs, &mut sel);
                candidate.1 = selectors[sel.0];
                let next = block_structure(block, candidate);
                let sse = selector_cost(candidate.1, &palette_costs(block, candidate.0, [1,1,1,0]));
                if next > score && sse <= limit { best = candidate; score = next; }
            }
        }
        *pair = best;
    }
}

fn window_score(m: [f64;5]) -> f64 {
    let [x,y,xx,yy,xy]=m;
    ((2.0*x*y+6.5025)*(2.0*(xy-x*y)+58.5225)) /
        ((x*x+y*y+6.5025)*(xx-x*x+yy-y*y+58.5225))
}
// Recompute only the Gaussian windows touched by one candidate block. The
// image-domain objective matches the independent quality protocol; no padding
// participates in a window or in the count of valid centers.
fn image_structure_gain(pixels: &[[[u8;4];16]], fitted: &[([u8;4],u32)], width:usize,height:usize,index:usize,candidate:([u8;4],u32)) -> f64 {
    if width < 11 || height < 11 { return block_structure(&pixels[index],candidate)-block_structure(&pixels[index],fitted[index]); }
    let bx=width.div_ceil(4); let x=(index%bx)*4; let y=(index/bx)*4;
    let lo_x=x.saturating_sub(5).max(5); let hi_x=(x+8).min(width-6);
    let lo_y=y.saturating_sub(5).max(5); let hi_y=(y+8).min(height-6);
    if lo_x>hi_x || lo_y>hi_y { return 0.0; }
    let mut weights: [f64;11]=std::array::from_fn(|i|(-((i as f64-5.0).powi(2))/(2.0*1.5*1.5)).exp());
    let sum: f64=weights.iter().sum(); for w in &mut weights { *w/=sum; }
    let palettes: Vec<_>=fitted.iter().copied().map(|p|palette(p.0)).collect();
    let next=palette(candidate.0); let mut gain=0.0;
    for cy in lo_y..=hi_y { for cx in lo_x..=hi_x { for c in 0..3 {
        let mut before=[0.0;5]; let mut after=[0.0;5];
        for dy in 0..11 { for dx in 0..11 {
            let px=cx+dx-5; let py=cy+dy-5;
            let block=(py/4)*bx+px/4; let t=(py%4)*4+px%4;
            let a=pixels[block][t][c] as f64;
            let b=palettes[block][((fitted[block].1>>(t*2))&3) as usize*3+c] as f64;
            let d=if block==index { next[((candidate.1>>(t*2))&3) as usize*3+c] as f64 } else { b };
            let w=weights[dy]*weights[dx];
            let old=[a,b,a*a,b*b,a*b]; let new=[a,d,a*a,d*d,a*d];
            for k in 0..5 { before[k]+=w*old[k]; after[k]+=w*new[k]; }
        }}
        gain+=window_score(after)-window_score(before);
    }}}
    gain / (3*(width-10)*(height-10)) as f64
}
// Per-slice distortion allocation: retain one independent reproduction with
// positive image SSIM gain and non-increasing RGB SSE. The largest slice must
// not crowd every coarse slice out of the shared books. Format caps still hold.
fn reserve_mips(pixels: &[[[u8;4];16]], fitted:&mut [([u8;4],u32)], independent:&[([u8;4],u32)], dimensions:&[[usize;2]]) {
    let mut endpoints: std::collections::BTreeSet<_>=fitted.iter().map(|p|p.0).collect();
    let mut selectors: std::collections::BTreeSet<_>=fitted.iter().map(|p|p.1).collect();
    let mut start=0;
    for &[width,height] in dimensions {
        let end=start+width.div_ceil(4)*height.div_ceil(4);
        let mut candidates=Vec::new();
        for i in start..end {
            let pair=independent[i];
            if (!endpoints.contains(&pair.0) && endpoints.len()==16128) || (!selectors.contains(&pair.1) && selectors.len()==16128) { continue; }
            let before=selector_cost(fitted[i].1,&palette_costs(&pixels[i],fitted[i].0,[1,1,1,0]));
            let after=selector_cost(pair.1,&palette_costs(&pixels[i],pair.0,[1,1,1,0]));
            let gain=block_structure(&pixels[i],pair)-block_structure(&pixels[i],fitted[i]);
            if after < before && gain > 0.0 { candidates.push((i,gain)); }
        }
        candidates.sort_by(|a,b|b.1.total_cmp(&a.1).then_with(||a.0.cmp(&b.0)));
        let mut best=None; let mut gain=0.0;
        for &(i,_) in candidates.iter().take(8) {
            let delta=image_structure_gain(&pixels[start..end],&fitted[start..end],width,height,i-start,independent[i]);
            if delta>gain { best=Some(i); gain=delta; }
        }
        if let Some(i)=best { fitted[i]=independent[i]; endpoints.insert(fitted[i].0); selectors.insert(fitted[i].1); }
        start=end;
    }
}

/// Shared, quality-controlled vector quantization across all supplied slices.
/// Endpoints and selector vectors have separate global codebooks as required by
/// BasisLZ; no per-image reset or truncation is used to meet the 16128-entry cap.
#[cfg(test)]
pub fn train(pixels: &[[[u8; 4]; 16]], quality: u32, effort: u32) -> Vec<([u8; 4], u32)> {
    train_metric(pixels, quality, effort, [1, 1, 1, 0])
}
pub fn train_metric(pixels: &[[[u8;4];16]], quality: u32, effort: u32, metric:[i32;4]) -> Vec<([u8;4],u32)> {
    train_dimensions(pixels, quality, effort, metric, &[])
}
pub fn train_dimensions(
    pixels: &[[[u8; 4]; 16]],
    quality: u32,
    effort: u32,
    metric: [i32; 4],
    dimensions: &[[usize;2]],
) -> Vec<([u8; 4], u32)> {
    let mut fitted: Vec<_> = pixels
        .iter()
        .map(|p| {
            let (e, s, _) = fit_metric(p, effort, metric);
            (e, s)
        })
        .collect();
    if pixels.is_empty() {
        return fitted;
    }
    let independent = fitted.clone();
    let seeds: Vec<u32> = fitted.iter().map(|p| p.1).collect();
    let mut unique = BTreeMap::<[u8; 4], Vec<usize>>::new();
    for (i, (e, _)) in fitted.iter().enumerate() {
        unique.entry(*e).or_default().push(i);
    }
    let entries: Vec<_> = unique.into_iter().collect();
    let features: Vec<Vec<i32>> = entries
        .iter()
        .map(|(e, _)| {
            vec![
                (expand(e[0]) as f64 * (metric[0] as f64).sqrt()).round() as i32,
                (expand(e[1]) as f64 * (metric[1] as f64).sqrt()).round() as i32,
                (expand(e[2]) as f64 * (metric[2] as f64).sqrt()).round() as i32,
                (e[3] as f64 * 24.0 * (metric[..3].iter().sum::<i32>() as f64 / 3.0).sqrt()).round()
                    as i32,
            ]
        })
        .collect();
    let weights: Vec<u64> = entries.iter().map(|(_, m)| m.len() as u64).collect();
    for group in groups(&features, &weights, budget(quality, entries.len(), false)) {
        let members: Vec<usize> = group
            .iter()
            .flat_map(|&i| entries[i].1.iter().copied())
            .collect();
        let mut endpoint = entries[*group.iter().max_by_key(|&&i| weights[i]).unwrap()].0;
        // Optimize shared endpoint under the actual clamped ETC1S palette,
        // retaining the best vector and recomputing each block's selectors.
        let mut best_error = u64::MAX;
        let mut best_endpoint = endpoint;
        for _ in 0..2 + effort {
            let assignments: Vec<_> = members
                .iter()
                .map(|&i| {
                    assign_metric(
                        &pixels[i],
                        endpoint[..3].try_into().unwrap(),
                        endpoint[3] as usize,
                        metric,
                    )
                })
                .collect();
            let error = assignments.iter().map(|(_, e)| *e).sum();
            if error < best_error {
                best_error = error;
                best_endpoint = endpoint;
            }
            let mut next = endpoint;
            for c in 0..3 {
                next[c] = (0..32u8)
                    .min_by_key(|&v| {
                        members
                            .iter()
                            .zip(&assignments)
                            .map(|(&i, (s, _))| {
                                pixels[i]
                                    .iter()
                                    .enumerate()
                                    .map(|(t, p)| {
                                        let selector = ((s >> (t * 2)) & 3) as usize;
                                        let d = (expand(v)
                                            + DELTAS[endpoint[3] as usize][selector])
                                            .clamp(0, 255)
                                            - p[c] as i32;
                                        (d * d) as u64
                                    })
                                    .sum::<u64>()
                            })
                            .sum::<u64>()
                    })
                    .unwrap();
            }
            if next == endpoint {
                break;
            }
            endpoint = next;
        }
        for i in members {
            let (s, _) = assign_metric(
                &pixels[i],
                best_endpoint[..3].try_into().unwrap(),
                best_endpoint[3] as usize,
                metric,
            );
            fitted[i] = (best_endpoint, s);
        }
    }
    let mut unique = BTreeMap::<u32, Vec<usize>>::new();
    for (i, (_, s)) in fitted.iter().enumerate() {
        unique.entry(*s).or_default().push(i);
    }
    let entries: Vec<_> = unique.into_iter().collect();
    let features: Vec<Vec<i32>> = entries
        .iter()
        .map(|(s, _)| (0..16).map(|t| ((s >> (t * 2)) & 3) as i32).collect())
        .collect();
    let weights: Vec<u64> = entries.iter().map(|(_, m)| m.len() as u64).collect();
    for group in groups(&features, &weights, budget(quality, entries.len(), true)) {
        let members: Vec<usize> = group
            .iter()
            .flat_map(|&i| entries[i].1.iter().copied())
            .collect();
        // Shared selectors minimize reconstructed error per texel for all blocks
        // in the cluster, weighted by each endpoint palette, rather than using
        // selector-index distance as the final distortion measure.
        let mut selectors = 0u32;
        for t in 0..16 {
            let best = (0..4usize)
                .min_by_key(|&s| {
                    members
                        .iter()
                        .map(|&i| {
                            (0..3)
                                .map(|c| {
                                    let endpoint = fitted[i].0;
                                    let d = (expand(endpoint[c]) + DELTAS[endpoint[3] as usize][s])
                                        .clamp(0, 255)
                                        - pixels[i][t][c] as i32;
                                    (d * d * metric[c]) as u64
                                })
                                .sum::<u64>()
                        })
                        .sum::<u64>()
                })
                .unwrap();
            selectors |= (best as u32) << (t * 2);
        }
        for i in members {
            fitted[i].1 = selectors;
        }
    }
    refine_selectors(pixels, &mut fitted, effort, metric);
    for _ in 0..2 + effort {
        refine_endpoints(pixels, &mut fitted, metric);
        refine_selectors(pixels, &mut fitted, effort, metric);
    }
    // End on an exact assignment against the final shared endpoint book.
    reassign_endpoints(pixels, &mut fitted, metric);
    polish_assignments(pixels, &mut fitted, &seeds, metric);
    polish_structure(pixels, &mut fitted, &seeds);
    reserve_mips(pixels, &mut fitted, &independent, dimensions);
    fitted
}

pub fn fit(pixels: &[[u8; 4]; 16], effort: u32) -> ([u8; 4], u32, u64) {
    fit_metric(pixels, effort, [1, 1, 1, 0])
}
fn fit_metric(pixels: &[[u8; 4]; 16], effort: u32, metric: [i32; 4]) -> ([u8; 4], u32, u64) {
    let mean: [f64; 3] =
        std::array::from_fn(|c| pixels.iter().map(|p| p[c] as f64).sum::<f64>() / 16.0);
    let mut best = ([0; 4], 0, u64::MAX);
    for table in 0..8 {
        // Offset restarts preserve opportunities at clamped black/white and
        // avoid a fixed point that starts between the two small modifiers.
        for offset in 0..if effort >= 2 { 5 } else { 1 } {
            let shift = if offset == 0 {
                0
            } else {
                DELTAS[table][offset - 1]
            };
            let mut base = mean.map(|v| quantize(v - shift as f64));
            for _ in 0..(2 + effort * 2) {
                let (selectors, error) = assign_metric(pixels, base, table, metric);
                if error < best.2 {
                    best = ([base[0], base[1], base[2], table as u8], selectors, error);
                }
                if error == 0 {
                    break;
                }
                // Fixed-selector minimization is separable, including endpoint
                // clamping. Exhaust all 32 possible values per channel.
                let next = std::array::from_fn(|c| {
                    (0..32u8)
                        .min_by_key(|&v| {
                            pixels
                                .iter()
                                .enumerate()
                                .map(|(t, p)| {
                                    let s = ((selectors >> (t * 2)) & 3) as usize;
                                    let decoded = (expand(v) + DELTAS[table][s]).clamp(0, 255);
                                    (decoded - p[c] as i32).pow(2) as u32
                                })
                                .sum::<u32>()
                        })
                        .unwrap()
                });
                if base == next {
                    break;
                }
                base = next;
            }
        }
    }
    if effort >= 1 {
        let table = best.0[3] as usize;
        for _ in 0..effort {
            let before = best.2;
            for c in 0..3 {
                let was = best.0[c];
                for delta in [-1i32, 1] {
                    if !(0..32).contains(&(was as i32 + delta)) {
                        continue;
                    }
                    let mut base = [best.0[0], best.0[1], best.0[2]];
                    base[c] = (was as i32 + delta) as u8;
                    let (selectors, error) = assign_metric(pixels, base, table, metric);
                    if error < best.2 {
                        best = ([base[0], base[1], base[2], table as u8], selectors, error);
                    }
                }
            }
            if best.2 == before {
                break;
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_flat_channel_stays_within_etc1_color_grid() {
        for value in 0..=255u8 {
            let color = [value, value.wrapping_mul(31), 255 - value, 255];
            let (endpoint, selectors, error) = fit(&[color; 16], 2);
            assert_eq!(
                assign(
                    &[color; 16],
                    endpoint[..3].try_into().unwrap(),
                    endpoint[3] as usize
                ),
                (selectors, error)
            );
            assert!(error <= 16 * 3 * 25, "{value}: {error}");
        }
    }
    #[test]
    fn extra_effort_retains_previous_candidate_set() {
        for seed in 0..16 {
            let pixels = std::array::from_fn(|t| {
                [
                    (t * 17 + seed) as u8,
                    (t * 31 + seed * 7) as u8,
                    (t * 13 + seed * 11) as u8,
                    255,
                ]
            });
            assert!(fit(&pixels, 2).2 <= fit(&pixels, 0).2);
        }
    }
    #[test]
    fn quality_controls_shared_codebooks_without_truncating_slices() {
        let pixels: Vec<_> = (0..80)
            .map(|i| {
                std::array::from_fn(|t| {
                    [
                        ((i * 19 + t * 7) % 256) as u8,
                        ((i * 23 + t * 11) % 256) as u8,
                        ((i * 37 + t * 13) % 256) as u8,
                        255,
                    ]
                })
            })
            .collect();
        let low = train(&pixels, 1, 0);
        let high = train(&pixels, 255, 0);
        assert_eq!(low.len(), pixels.len());
        let count = |v: &Vec<([u8; 4], u32)>| {
            v.iter()
                .map(|p| p.0)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
        };
        assert!(count(&low) < count(&high));
        assert!(
            high.iter()
                .zip(&pixels)
                .all(|((e, s), p)| palette_error(p, *e, *s) < 16 * 3 * 255 * 255)
        );
    }
    #[test]
    fn pooled_coarse_mips_reassign_shared_endpoints_and_tables() {
        // Independent varied blocks represent finer slices in a shared pool.
        let mut pixels: Vec<_> = (0..256)
            .map(|i| {
                std::array::from_fn(|t| {
                    [
                        ((i * 19 + t * 7) % 256) as u8,
                        ((i * 23 + t * 11) % 256) as u8,
                        ((i * 37 + t * 13) % 256) as u8,
                        255,
                    ]
                })
            })
            .collect();
        pixels.extend([[[116, 98, 64, 255]; 16], [[42, 116, 210, 255]; 16]]);
        let fitted = train(&pixels, 59, 2);
        for i in pixels.len() - 2..pixels.len() {
            let error = palette_error(&pixels[i], fitted[i].0, fitted[i].1);
            assert!(error <= 16 * 3 * 25, "pooled coarse block {i}: {error}");
        }
    }
    #[test]
    fn endpoint_bounds_and_moments_match_exhaustive_reconstruction() {
        let book: Vec<_> = (0..173)
            .map(|i| {
                [
                    (i % 32) as u8,
                    ((i * 7) % 32) as u8,
                    ((i * 13) % 32) as u8,
                    (i % 8) as u8,
                ]
            })
            .collect();
        let palettes: Vec<_> = book.iter().copied().map(palette).collect();
        let tree = EndpointNode::build(&palettes, (0..book.len()).collect());
        for seed in 0..32 {
            let pixels = std::array::from_fn(|t| {
                [
                    (t * 31 + seed * 17) as u8,
                    (t * 11 + seed * 13) as u8,
                    (t * 47 + seed * 7) as u8,
                    255,
                ]
            });
            let selectors = (seed as u32).wrapping_mul(0x97a4ed13);
            let mut moments = Moments::default();
            moments.add(&pixels, selectors);
            for &endpoint in &book {
                assert_eq!(
                    moments.cost(endpoint, [1, 1, 1, 0]),
                    palette_error(&pixels, endpoint, selectors)
                );
            }
            for metric in [[1, 1, 1, 0], [54, 183, 19, 0]] {
                let mut best = (0, moments.cost(book[0], metric));
                tree.nearest(&book, &moments, metric, &mut best);
                assert_eq!(
                    best.1,
                    book.iter().map(|&e| moments.cost(e, metric)).min().unwrap()
                );
                let optimum = moments.optimum(book[0], metric);
                assert!(moments.cost(optimum, metric) <= best.1);
                for table in 0..8 {
                    for c in 0..3 {
                        for v in 0..32 {
                            let mut endpoint = optimum;
                            endpoint[3] = table;
                            endpoint[c] = v;
                            assert!(
                                moments.cost(optimum, metric) <= moments.cost(endpoint, metric)
                            );
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn entropy_biased_selector_tree_matches_exhaustive_objective() {
        let book: Vec<u32> = (0..129u32).map(|i| i.wrapping_mul(0x96af3de1)).collect();
        let rates: Vec<u64> = (0..book.len()).map(|i| ((i * 47) % 311) as u64).collect();
        let tree = SelectorNode::build(&book, &rates, (0..book.len()).collect());
        for seed in 0..32 {
            let cost: [[u32; 4]; 16] = std::array::from_fn(|t| {
                std::array::from_fn(|s| ((t * 31 + s * 71 + seed * (s + t)) % 403) as u32)
            });
            for rate_weight in [0, 17, 512, 2048, 4096] {
                let mut best = (
                    0,
                    selector_cost(book[0], &cost) + rates[0] * rate_weight / 4096,
                );
                tree.nearest(&book, &rates, rate_weight, &cost, &mut best);
                assert_eq!(
                    best.1,
                    book.iter()
                        .zip(&rates)
                        .map(|(&s, &r)| selector_cost(s, &cost) + r * rate_weight / 4096)
                        .min()
                        .unwrap()
                );
            }
        }
    }
    #[test]
    fn joint_seed_polish_retains_each_blocks_distortion_and_shared_books() {
        let pixels: Vec<_> = (0..64)
            .map(|i| {
                std::array::from_fn(|t| {
                    [
                        (i * 19 + t * 7) as u8,
                        (i * 23 + t * 11) as u8,
                        (i * 37 + t * 13) as u8,
                        255,
                    ]
                })
            })
            .collect();
        let mut fitted = train(&pixels, 48, 0);
        let original = fitted.clone();
        let seeds: Vec<_> = pixels.iter().map(|p| fit(p, 0).1).collect();
        polish_assignments(&pixels, &mut fitted, &seeds, [1, 1, 1, 0]);
        for (i, &(e, s)) in fitted.iter().enumerate() {
            assert!(
                palette_error(&pixels[i], e, s)
                    <= palette_error(&pixels[i], original[i].0, original[i].1)
            );
            assert!(original.iter().any(|p| p.0 == e));
            assert!(original.iter().any(|p| p.1 == s));
        }
    }
    #[test]
    fn structural_polish_preserves_sse_and_books_while_improving_structure() {
        let pixels: Vec<_> = (0..64).map(|i| std::array::from_fn(|t| [
            (i*19+t*7) as u8, (i*23+t*11) as u8, (i*37+t*13) as u8, 255
        ])).collect();
        let seeds: Vec<_> = pixels.iter().map(|p| fit(p, 0).1).collect();
        let mut fitted = train(&pixels, 48, 0);
        // Disturb valid assignments to exercise a strict structural gain.
        fitted.rotate_left(3);
        let old = fitted.clone();
        polish_structure(&pixels, &mut fitted, &seeds);
        let mut gains = 0;
        for (i, &(e,s)) in fitted.iter().enumerate() {
            assert!(palette_error(&pixels[i], e,s) <= palette_error(&pixels[i], old[i].0,old[i].1));
            assert!(block_structure(&pixels[i], (e,s)) >= block_structure(&pixels[i], old[i]));
            assert!(old.iter().any(|p| p.0 == e));
            assert!(old.iter().any(|p| p.1 == s));
            gains += usize::from(block_structure(&pixels[i], (e,s)) > block_structure(&pixels[i],old[i]));
        }
        assert!(gains > 0);
        assert!(contrast_metric(&[[128,128,128,255];16])[..3].iter().all(|&w| w == 4128));
    }

    #[test]
    fn mip_allocation_recovers_coarse_slice_with_nonincreasing_sse() {
        let pixels: Vec<_>=(0..4).map(|i|[[40+i*31,90+i*17,150-i*19,255];16]).collect();
        let independent: Vec<_>=pixels.iter().map(|p|{let(e,s,_)=fit(p,2);(e,s)}).collect();
        let mut fitted=vec![independent[0];4]; let before=fitted.clone();
        reserve_mips(&pixels,&mut fitted,&independent,&[[12,4],[4,4]]);
        assert_eq!(fitted[3],independent[3]);
        for i in 0..4 { assert!(palette_error(&pixels[i],fitted[i].0,fitted[i].1) <= palette_error(&pixels[i],before[i].0,before[i].1)); }
    }
    #[test]
    fn gaussian_window_gain_rejects_changes_outside_valid_support() {
        let pixels=vec![[[100,110,120,255];16];16];
        let(e,s,_)=fit(&pixels[0],2); let fitted=vec![(e,s);16];
        assert_eq!(image_structure_gain(&pixels,&fitted,16,16,0,(e,s)),0.0);
        assert!(image_structure_gain(&pixels,&fitted,16,16,0,([0,0,0,0],0)) < 0.0);
        assert_eq!(window_score([100.0,100.0,10000.0,10000.0,10000.0]),1.0);
    }

}
