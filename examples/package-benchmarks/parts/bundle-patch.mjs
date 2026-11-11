// Patches a served build for a benchmark arm. A pattern is counted over every chunk of one page load, because the
// bundler moves code between chunks: a pattern must match exactly once in the whole load, not once in a named chunk.
import assert from 'node:assert/strict';

/** Applies the arm's [pattern, replacement] pairs to one chunk and adds each pattern's match count to `matched`. */
export function patchChunk(body, pairs, matched) {
  for (const [pattern, replacement] of pairs) {
    matched.set(pattern, (matched.get(pattern) ?? 0) + (body.match(pattern)?.length ?? 0));
    body = body.replace(pattern, replacement);
  }
  return body;
}

/** Throws unless every pattern of the arm matched exactly once over the page load. */
export function assertPatchedOnce(label, pairs, matched) {
  for (const [pattern] of pairs)
    assert.equal(matched.get(pattern) ?? 0, 1, `${label}: ${pattern} must match the build once`);
}
