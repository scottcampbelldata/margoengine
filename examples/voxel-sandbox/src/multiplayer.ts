// Multiplayer (?server=ws://host:port): the sandbox joins a @margoengine/voxel-net server (server.mjs) instead of
// streaming its own world. The server sends the chunks and everyone's edits; this module draws the other players as
// boxes and turns the sandbox's keys into the client's input bits.
import { box, type EngineKernel, type Mesh, PbrMaterial } from '@margoengine/core';
import type { VoxelWorld } from '@margoengine/voxel';
import { connectVoxelNet, Keys, type VoxelNetClient } from '@margoengine/voxel-net';

const COLORS = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#8e7dbe', '#d64550', '#3e8914'];

/** A joined server: the client, and the boxes of the other players. */
export interface Online {
  readonly client: VoxelNetClient;
  /** Moves each other player's box to where the client says to draw it; adds and removes boxes as players come and go. */
  drawPlayers(): void;
  dispose(): void;
}

/** Connects to `url` with `world` (which must be empty: the server fills it) and a view of `view` chunks. */
export function joinServer(engine: EngineKernel, world: VoxelWorld, url: string, view: number): Online {
  const client = connectVoxelNet(url, world, { name: 'sandbox', view }),
    meshes = new Map<number, Mesh>(),
    body = box(0.6, 1.8, 0.6);
  return {
    client,
    drawPlayers() {
      const players = client.samplePlayers();
      for (const [id, other] of players) {
        let mesh = meshes.get(id);
        if (!mesh) {
          mesh = engine
            .createMesh()
            .setGeometry(body)
            .setMaterial(new PbrMaterial({ color: COLORS[id % COLORS.length], roughness: 0.8 }));
          meshes.set(id, mesh);
        }
        const p = other.snapshot.position,
          q = other.snapshot.rotation;
        mesh.setPosition([p[0], p[1] + 0.9, p[2]]).setRotation([0, 2 * Math.atan2(q[1], q[3]), 0]);
      }
      for (const [id, mesh] of meshes)
        if (!players.has(id)) {
          mesh.dispose();
          meshes.delete(id);
        }
    },
    dispose() {
      client.close();
      for (const mesh of meshes.values()) mesh.dispose();
    },
  };
}

/** The client's input bits for the sandbox's keys (WASD or arrows, Space, Shift or C) and fly mode. */
export function keyBits(keys: ReadonlySet<string>, flying: boolean): number {
  const has = (...codes: string[]) => codes.some((code) => keys.has(code)),
    shift = has('ShiftLeft', 'ShiftRight');
  return (
    (has('KeyW', 'ArrowUp') ? Keys.forward : 0) |
    (has('KeyS', 'ArrowDown') ? Keys.back : 0) |
    (has('KeyA', 'ArrowLeft') ? Keys.left : 0) |
    (has('KeyD', 'ArrowRight') ? Keys.right : 0) |
    (has('Space') ? Keys.jump : 0) |
    (shift || has('KeyC') ? Keys.descend : 0) |
    (shift && !flying ? Keys.sprint : 0) |
    (flying ? Keys.fly : 0)
  );
}
