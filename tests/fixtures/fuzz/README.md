# Fuzz regression fixtures

Inputs the parser fuzzers (`npm run fuzz`) found, kept so `tests/fuzz-regressions.test.js`,
`tests/fuzz-formats-regressions.test.js` and the decoders tests replay them. All are Margo-made: mutated or truncated
copies of the repository's own fixtures (`ifc-arity-hang.ifc` comes from `packages/ifc/tests/fixtures/wall.ifc`) or
bytes the fuzzer generated. None contains third-party data.
