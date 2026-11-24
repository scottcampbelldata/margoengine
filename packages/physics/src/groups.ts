import {
  COLLIDER_GROUPS_OR,
  COLLIDER_GROUPS_WIDE,
  COLLIDER_SOLVER_OR,
  COLLIDER_SOLVER_WIDE,
  type KernelWorld,
} from './kernel.js';
import { type InteractionGroups, groupWords } from './shapes.js';

/**
 * Writes a collider's collision groups (`solver` false) or solver groups: a packed number as before, or 32 bits wide with a
 * test mode. A packed number has no upper halves: it meets other colliders by its 16 bits exactly as Rapier's JavaScript
 * build tests them, and a packed word of all ones is every one of the 32 groups, as a collider's default is.
 */
export function writeGroups(
  kernel: KernelWorld,
  row: number,
  groups: number | InteractionGroups,
  solver: boolean,
): void {
  const c = kernel.columns,
    { packed, hi, or, wide } = groupWords(groups),
    orBit = solver ? COLLIDER_SOLVER_OR : COLLIDER_GROUPS_OR,
    wideBit = solver ? COLLIDER_SOLVER_WIDE : COLLIDER_GROUPS_WIDE;
  (solver ? c.colliderSolverGroups : c.colliderGroups)[row] = packed;
  (solver ? c.colliderSolverGroupsHi : c.colliderGroupsHi)[row] = hi;
  let flags = c.colliderFlags[row] & ~(orBit | wideBit);
  if (or) flags |= orBit;
  if (wide) flags |= wideBit;
  c.colliderFlags[row] = flags;
}

/** The groups a collider holds, 32 bits wide. */
export function readGroups(kernel: KernelWorld, row: number, solver: boolean): InteractionGroups {
  const c = kernel.columns,
    packed = (solver ? c.colliderSolverGroups : c.colliderGroups)[row],
    hi = (solver ? c.colliderSolverGroupsHi : c.colliderGroupsHi)[row],
    flags = c.colliderFlags[row],
    testMode = flags & (solver ? COLLIDER_SOLVER_OR : COLLIDER_GROUPS_OR) ? 'or' : 'and';
  if (flags & (solver ? COLLIDER_SOLVER_WIDE : COLLIDER_GROUPS_WIDE))
    return Object.freeze({
      memberships: ((packed >>> 16) | (hi & 0xffff0000)) >>> 0,
      filter: ((packed & 0xffff) | ((hi & 0xffff) << 16)) >>> 0,
      testMode,
    });
  if (packed === 0xffffffff) return Object.freeze({ memberships: 0xffffffff, filter: 0xffffffff, testMode });
  return Object.freeze({ memberships: packed >>> 16, filter: packed & 0xffff, testMode });
}
