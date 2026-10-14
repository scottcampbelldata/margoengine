/// <reference lib="esnext.disposable" preserve="true" />
import {init, NavMesh, NavMeshQuery, Raw} from 'recast-navigation';
import {generateSoloNavMesh, soloNavMeshGeneratorConfigDefaults} from 'recast-navigation/generators';
export interface Vector3 {x:number;y:number;z:number}
export interface NavigationOptions {
  cs?:number;ch?:number;borderSize?:number;walkableSlopeAngle?:number;walkableHeight?:number;walkableClimb?:number;walkableRadius?:number;
  maxEdgeLen?:number;maxSimplificationError?:number;minRegionArea?:number;mergeRegionArea?:number;maxVertsPerPoly?:number;
  detailSampleDist?:number;detailSampleMaxError?:number;buildBvTree?:boolean;
}

/** Owns a real Recast/Detour navmesh and query; the heavy Wasm remains optional. */
export class Navigation {
  private readonly query: NavMeshQuery;
  private disposed = false;
  private constructor(private readonly navMesh: NavMesh) {this.query = new NavMeshQuery(navMesh);}
  static async create(positions: ArrayLike<number>, indices: ArrayLike<number>, options: NavigationOptions = {}): Promise<Navigation> {
    if (positions.length < 9 || positions.length % 3 || positions.length > 3_000_000 || !indices.length || indices.length % 3 || indices.length > 6_000_000) throw new RangeError('Invalid navigation geometry');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      const value = positions[i]; if (!Number.isFinite(Math.fround(value))) throw new RangeError('Navigation positions must be finite');
      min[i % 3] = Math.min(min[i % 3], value); max[i % 3] = Math.max(max[i % 3], value);
    }
    for (let i = 0; i < indices.length; i++) if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= positions.length / 3) throw new RangeError('Invalid navigation indices');
    const config = {...soloNavMeshGeneratorConfigDefaults, ...options};
    for(const key of Object.keys(options))if(!Object.hasOwn(soloNavMeshGeneratorConfigDefaults,key)||key==='tileSize')throw new RangeError('Unsupported Recast config');
    for (const [key,value] of Object.entries(config)) if (key==='buildBvTree'?typeof value!=='boolean':typeof value!=='number'||!Number.isFinite(value)||value<0) throw new RangeError('Invalid Recast config');
    if (config.cs <= 0 || config.ch <= 0 || config.walkableSlopeAngle >= 90 || config.maxVertsPerPoly < 3 || config.maxVertsPerPoly > 6 ||
      Math.ceil((max[0] - min[0]) / config.cs) * Math.ceil((max[2] - min[2]) / config.cs) > 16_000_000) throw new RangeError('Recast voxel budget or config exceeded');
    await init();
    const result = generateSoloNavMesh(positions, indices, config);
    Raw.destroy(result.intermediates.buildContext.raw);
    if (!result.success) throw new Error('Navigation build failed: ' + result.error);
    try {return new Navigation(result.navMesh);} catch (error) {result.navMesh.destroy(); throw error;}
  }
  path(start: Vector3, end: Vector3): Vector3[] | null {
    if (this.disposed) throw new Error('Navigation is disposed');
    for (const point of [start, end]) if (![point.x, point.y, point.z].every(Number.isFinite)) throw new RangeError('Invalid path endpoint');
    const result = this.query.computePath(start, end); return result.success ? result.path : null;
  }
  dispose(): void {if (this.disposed) return; this.disposed = true; this.query.destroy(); this.navMesh.destroy();}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
