// Coded errors of the rigid world (docs/physics-parity-bar.md Part 1, item 3): bodies, colliders, shapes, queries and the
// kernel's world on one help entry, mesh colliders, hulls, mesh mass and convex decomposition on another. Each message
// names the input and its fix and ends with its entry's help link.
import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

/**
 * @internal A body, collider, shape, query or world input that cannot be used: a MargoError (code `unsupported` unless
 * given) linking margoengine.com/errors#physics-bodies.
 */
export function bodyInput(message: string, code: MargoErrorCode = 'unsupported'): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#physics-bodies`);
}

/**
 * @internal A mesh, hull, mesh-mass or decomposition input that cannot be used: a MargoError (code `unsupported` unless
 * given) linking margoengine.com/errors#physics-meshes.
 */
export function meshInput(message: string, code: MargoErrorCode = 'unsupported'): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#physics-meshes`);
}
