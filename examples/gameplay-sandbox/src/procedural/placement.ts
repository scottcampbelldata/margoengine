import {randomPlacements, radialPlacements, type GroundPlacement, type GroundBounds} from '@margoengine/scatter';

export const TREE_POSITIONS = [[-20,16],[-17,12],[-10,12],[-3,16],[-22,24],[-20,32],[-15,34],[-4,32],[1,26],[0,20]] as const;
export const ROCK_POSITIONS = [[-13.8,25.6],[-13.8,19],[-6.3,19.2],[-7,28.6],[-20.6,31.6],[-14.3,33.6]] as const;
// The stone supports extend beyond the walls; the second rectangle reserves porch access.
export const CABIN_EXCLUSIONS: readonly GroundBounds[] = [[-13.6,18.2,-6.4,27.8],[-10.7,27,-7.5,33]];

export const ROCK_CANDIDATES: readonly GroundPlacement[] = [[-13.8,25.6,0.45,0],[-13.8,19,0.57,1.73],[-6.3,19.2,0.69,3.46],[-7,28.6,0.45,5.19],[-20.6,31.6,0.57,6.92],[-14.3,33.6,0.69,8.65]];
export const SHRUB_CANDIDATES = [...randomPlacements(96,[-15.7,16.7,-4.3,31.5],[0.55,0.9],731),...radialPlacements(ROCK_POSITIONS,4,[1.6,2.3],[0.55,0.9],912)];
export const FERN_CANDIDATES = [...radialPlacements(TREE_POSITIONS,4,[0.9,1.1],[0.8,1.1],731),...randomPlacements(7,[-14,18,-6,30],[0.8,1.1],9)];
