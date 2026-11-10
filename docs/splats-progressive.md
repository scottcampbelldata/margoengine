# Progressive splat cancellation

The optional splats/progressive entry accepts ReadableStream or AsyncIterable
byte sources. Aborting its signal rejects a pending consumer read with the
original abort reason, requests iterator cleanup once and stops before decoding
another buffered batch. Normal completion preserves existing format validation,
record ordering and attributes. No new public API is added.

The original async-iterable loop checked cancellation only after next() settled.
A source awaiting more bytes therefore kept the consumer pending after abort.
The decoder also continued emitting already-buffered batches between those
checks. Regression inputs are an independently controlled pending next(), both
immediate and pending return(), and two raw splat records in one chunk with
batchSize 1. Tests compare event ordering without wall-clock budgets, release
their pending source operations and preserve exact error identity. Existing
stream reader cancellation remains covered, including pending underlying cancel.

Iterator reads and cleanup promises are observed even if they settle after abort.
Abort listeners are removed on cancellation or settlement. Arbitrary producer
IO remains producer-owned: return() is requested, but the decoder cannot forcibly
terminate external work whose cleanup implementation never settles.

Sources compared before the clean-room correction:

- WHATWG contributors, *DOM Standard* (Living Standard, 2026),
  https://dom.spec.whatwg.org/#aborting-ongoing-activities: abort-aware APIs reject
  unsettled promises with the signal reason.
- WHATWG contributors, *Streams Standard* (Living Standard, 2026),
  https://streams.spec.whatwg.org/#rs-asynciterator: cancellation and iterator
  return coordinate stream ownership and pending reads.
- Ecma International, *ECMAScript Language Specification*, async iteration
  proposal (2018), https://tc39.es/proposal-async-iteration/#sec-asynciteratorclose:
  iterator return is asynchronous and can itself remain pending. Explicitly
  observing both operations lets cancellation finish independently of producer IO.

Evidence: packages/splats/test/progressive.test.js. Run it after build:packages
with node --test --test-timeout=120000 packages/splats/test/progressive.test.js.
The package's own GPU suites cover WebGPU and WebGL2 compatibility; dependent CPU
tests cover loaders and consumers. No speed or producer-termination claim.

The dependency CPU gate also caught sciviz's new fallback and table browser commands
bypassing its required browser-root bootstrap. Both use that existing bootstrap;
the browser-root regression and both suites cover package-directory launching.
The fallback fixture already selected the repository itself, so no renderer or
browser-lifecycle implementation changes are involved in that gate correction.
