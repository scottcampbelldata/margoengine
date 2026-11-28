// The way onto a flat roof of a rules building: whether the style's code asks for a stair to it, the stair house over
// the well with its door, and the guard round the roof's edge. Internal to @margoengine/procedural; our own code, clean
// room from:
// - International Building Code 1011.12, "Stairway to roof": in buildings of four or more storeys above grade plane one
//   stairway extends to the roof unless the roof is steeper than 4 in 12 (a roof nobody occupies may take a ladder or a
//   hatch instead), and 1011.12.2: the stair reaches the roof through a penthouse. The 2018 text as quoted at
//   https://www.lapeyrestair.com/blog/unoccupied-roof-egress-requirements/.
// - Japan, Building Standard Law Enforcement Order art. 126 para. 1
//   (https://laws.e-gov.go.jp/api/1/articles;lawId=325CO0000000338;article=126): a roof terrace has a parapet, fence or
//   mesh at least 1.1 m high round it. IBC 1015.3 asks 42 in (1.067 m), which 1.1 m meets.
import type { BuildingDoorway, BuildingStyle } from './building-rules.js';
import type { MeshBuilder, V3 } from './mesh-builder.js';

/** The way onto a building's roof. */
export interface BuildingRoofAccess {
  /** Whether the style's code asks for a stair to this roof (IBC 1011.12). */
  readonly required: boolean;
  /** The roof's walking surface above the ground, metres. */
  readonly level: number;
  /**
   * The stair house on the roof: its outer plan (local metres), its height over the roof and its doorway out. Absent
   * where no stair reaches the roof.
   */
  readonly house?: {
    readonly min: readonly [number, number];
    readonly max: readonly [number, number];
    readonly height: number;
    readonly door: BuildingDoorway;
  };
  /**
   * Why there is no stair: `stair-off`, `roofStair` or `stairs` is false, or the interior has no rooms; `pitched`, the
   * roof is not flat; `no-room`, no framed or winder stair with its house fits every floor and the roof.
   */
  readonly unmet?: 'stair-off' | 'pitched' | 'no-room';
}

/** The stair house's wall, inside height and roof, and its door, metres (IBC 1011.3: 80 in of headroom at least). */
export const ROOF_HOUSE = {
  wall: 0.12,
  height: 2.4,
  slab: 0.12,
  door: 0.9,
  doorHeight: 2.1,
} as const;
/** The least guard round a roof people walk on (Order art. 126). */
const GUARD = 1.1;

/** Whether the code asks for a stair to the roof: IBC's styles, four storeys up, no steeper than 4 in 12. */
export function roofStairRequired(style: BuildingStyle, storeys: number, flat: boolean, pitch: number): boolean {
  if (style.startsWith('japan') || style === 'western-1910-house') return false;
  return storeys >= 4 && (flat || pitch <= (Math.atan(4 / 12) * 180) / Math.PI);
}

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * The stair house round `whole`, the stair and its approach, on the roof at `level`: four walls with a door in the one
 * the top flight arrives beside (`head`), a door leaf in it and a slab over all. Returns what `roofAccess` reports.
 */
export function buildStairHouse(
  walls: MeshBuilder,
  roof: MeshBuilder,
  doors: MeshBuilder,
  whole: Rect,
  head: readonly [number, number],
  along: 'x' | 'z',
  level: number,
  storey: number,
): NonNullable<BuildingRoofAccess['house']> {
  const { wall: t, height, slab, door, doorHeight } = ROOF_HOUSE,
    top = level + height,
    out: Rect = {
      x0: whole.x0 - t,
      x1: whole.x1 + t,
      z0: whole.z0 - t,
      z1: whole.z1 + t,
    },
    box = (b: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
      if (x1 - x0 > 1e-6 && y1 - y0 > 1e-6 && z1 - z0 > 1e-6)
        b.box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2]);
    };
  // The door's wall: across the stair's run (`along`), at the end the head is nearer.
  const [u0, u1, v0, v1, hu, hv] =
      along === 'x'
        ? [whole.x0, whole.x1, whole.z0, whole.z1, head[0], head[1]]
        : [whole.z0, whole.z1, whole.x0, whole.x1, head[1], head[0]],
    low = hu - u0 < u1 - hu,
    d0 = Math.min(v1 - door - 0.05, Math.max(v0 + 0.05, hv - door / 2)),
    d1 = d0 + door,
    // A box given along the run (u) and across it (v).
    uv = (b: MeshBuilder, a: number, c: number, y0: number, y1: number, e: number, f: number) =>
      along === 'x' ? box(b, a, c, y0, y1, e, f) : box(b, e, f, y0, y1, a, c),
    face = low ? [u0 - t, u0] : [u1, u1 + t],
    back = low ? [u1, u1 + t] : [u0 - t, u0];
  for (const [e, f] of [
    [v0 - t, v0],
    [v1, v1 + t],
  ])
    uv(walls, u0 - t, u1 + t, level, top, e, f);
  uv(walls, back[0], back[1], level, top, v0, v1);
  uv(walls, face[0], face[1], level, top, v0, d0);
  uv(walls, face[0], face[1], level, top, d1, v1);
  uv(walls, face[0], face[1], level + doorHeight, top, d0, d1);
  const mid = (face[0] + face[1]) / 2;
  uv(doors, mid - 0.02, mid + 0.02, level, level + doorHeight, d0, d1);
  box(roof, out.x0 - 0.05, out.x1 + 0.05, top, top + slab, out.z0 - 0.05, out.z1 + 0.05);
  const c: V3 =
    along === 'x' ? [mid, level + doorHeight / 2, (d0 + d1) / 2] : [(d0 + d1) / 2, level + doorHeight / 2, mid];
  return {
    min: [out.x0, out.z0],
    max: [out.x1, out.z1],
    height: height + slab,
    door: {
      floor: storey,
      centre: c,
      width: door,
      height: doorHeight,
      normal: along,
    },
  };
}

/**
 * Rails on top of a parapet lower than the guard a walked roof needs, round the middle of the walls (`half` their
 * half width and depth); `base` is the coping's top, or the roof where there is no parapet.
 */
export function roofGuard(
  railing: (a: V3, b: V3, height: number) => void,
  half: readonly [number, number],
  base: number,
  level: number,
): void {
  const height = level + GUARD - base;
  if (height <= 0.02) return;
  const [x, z] = half,
    at: V3[] = [
      [-x, base, z],
      [x, base, z],
      [x, base, -z],
      [-x, base, -z],
    ];
  at.forEach((a, i) => railing(a, at[(i + 1) % 4], height));
}
