# Scientific analysis filters, batch 172

## Filter pipeline

The optional `@margoengine/sciviz/pipeline` entry exports `FilterPipeline`. It imports
no renderer and starts no work on construction. A registry maps stable operator
names to source, filter and layer implementations. Register lazy implementations
that import their owning optional filter entry inside `execute`. The graph can
therefore describe all analysis filters without importing their code up front.

Add nodes in dependency order with `add({id,type,inputs,params})`. Sources have no
inputs; filters and layers have at least one. Request a node with
`await graph.run(id,{time,signal})`. Time defaults to zero; operators opt into time
dependence with `timeDependent: true`, inherited by their descendants. The graph
executes only the requested ancestors, once each, and caches successful outputs.
Concurrent requests are serialized and reuse cache entries. Independent temporal
branches keep independent requested times. A diamond shares its upstream output.

`setParams(id,params)` replaces the complete parameter value and dirties that node
and its descendants. `invalidate(id)` notifies the graph of an external source
change. Neither executes anything until the next demand. Mutating an ancestor
cancels active or queued demands involving it; callers request the new result
explicitly. Failures are propagated unchanged and do not poison future requests.

Parameters are snapshotted, deeply frozen finite JSON. Typed arrays, non-finite
numbers, cycles, sparse arrays, functions and class instances reject. Large data
belongs in a source, with a URL or other persistent identifier in its params.
`toJSON()` emits version 1, node order, operator names, connections and params;
`FilterPipeline.fromJSON(description,registry)` restores it without execution.
The restoring application supplies trusted operators: JSON never contains code.

Inputs and returned outputs are borrowed until invalidation or disposal. Operators
must not mutate or dispose borrowed inputs, and must observe `signal` during
asynchronous work. JavaScript cannot preempt an operator that ignores cancellation;
requests await its settlement, reject with the exact abort reason, and release
its late result instead of caching it. Cancellation preserves successful upstream
outputs. `release(output)` frees only resources that operator owns. Consumers are
released before their dependencies on invalidation, time replacement and disposal.
`dispose()` and `Symbol.dispose` abort pending work and release cached resources;
the graph never disposes an external figure or device itself. Operator release
functions must be synchronous and nonthrowing.

The topology is append-only. To rewire or remove nodes, restore an edited JSON
description into a new graph and dispose the old one. No automatic animation clock,
unbounded history cache, persistence backend or speculative execution is implied.

## Evidence and data

`packages/sciviz/tests/pipeline.test.js` covers diamonds, downstream invalidation,
concurrent requests, separate temporal branches, JSON round trips and validation,
exact-reason cancellation, mutation during execution, resource ordering, failure
propagation and the real FUN3D samples. The browser test renders the NASA solution
on native WebGPU and WebGL2 compatibility, changes the subset, counts source/filter/
layer executions, checks coloured pixels and verifies removal of owned layers.

`examples/sciviz-pipeline.html` uses the published NASA TMR SA flat-plate solution
`cf_plate.dat`, FUN3D rev 32421 on the finest 545 by 385 grid. The original download
contains 447 CFL3D and 447 FUN3D surface samples; only the FUN3D zone is shown.
The cutoff selects published samples without interpolation. The full volume mesh
is not present and no temporal measurements are invented. The fixed chart limits
exclude the leading-edge skin-friction singularity from the visible range; the
source and pipeline retain it. Data source, hash and licence are recorded in
`examples/assets/sciviz/pipeline/source.json` and `THIRD-PARTY-NOTICES.md`.

Behavioural reference: Schroeder, Martin and Lorensen's published VTK pipeline
description separates sources, filters and sinks, uses demand-driven execution,
and reuses unchanged upstream results. These behaviors are demonstrated directly
by deterministic call counts, with time and cancellation additionally tested.
No runtime rival comparison or speed claim is made. Core and stage are unchanged.
