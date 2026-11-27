// The error and hypot helpers that packages bundle from packages/shared, as one public entry: a package on
// scripts/support/math-external.mjs's SHARED_HELPERS imports this entry instead of a copy, so an app that holds several
// of them holds each helper once (KB-INL1). Not in the math root: math/pinned has a hypot(x, y, z?) of its own.
// Core and the stage keep their own copy (math depends on core, so core cannot import math).
export { fault, margoError, rangeError, typeError } from '../../shared/errors.js';
export type { MargoErrorCode } from '../../shared/errors.js';
export { hypot, hypotOf, hypotTerms } from '../../shared/hypot.js';
