// Catalogue data of the fauld-tunnels scene, shared by the catalogue root and the scene entry (no imports: listing the
// catalogue loads no package).
import type { SceneInfo } from './index.js';

/** The lighting states of the store, each one rig and one metered exposure (the scene's `state` setting). */
export const FAULD_TUNNEL_STATES = [
  'working',
  'blast',
  'fire',
  'after',
  'flooded',
  'sealed',
  'yard_day',
  'yard_night',
  'yard_fire',
  'yard_sealed',
] as const;

/** The catalogue entry of this scene. */
export const fauldTunnelsInfo: SceneInfo = {
  name: 'fauld-tunnels',
  title: 'The Fauld bomb store (RAF Fauld, 21 MU, Staffordshire, November 1944)',
  about:
    'The underground bomb store in the old gypsum mine at Fauld: a main drift 240 m into the hill under steel arch ribs and corrugated sheet on whitewashed piers, side bays of 1,000 lb bombs stacked on timber baulks behind brick blast walls, 2 ft narrow gauge rails with trolleys, a work bay with bench and fuzing cradle, an SAA box bay, and the old pillar-and-stall gypsum roadway beside it; lit by caged bulkhead lamps on the mains, by hand lamps after the explosion, or by fire. The portal yard outside by day or night. Every model is a library glTF with its PBR maps (the asset library, never in the repository).',
  entry: '@margoengine/scenes/fauld-tunnels',
  settings: {
    state: {
      default: 'working',
      options: FAULD_TUNNEL_STATES,
      about:
        'working (mains lamps, 27 November 1944 before 11:11), blast (the flash), fire, after (hand lamps, smoke clearing), flooded, sealed (the 1944 walls), and the portal yard by day, night, in the fire, sealed',
    },
    time: { default: 0, range: [0, 600], unit: 's', about: 'seconds of the state (smoke, fire and dust move with it)' },
    quality: { default: 'film', options: ['film', 'preview'], about: 'shadow map size and fog grid' },
    library: { default: '/asset-library/', about: 'URL root of the asset library (fauld-1944 and big-burn-1910 subjects)' },
  },
  presets: {
    working: { state: 'working' },
    rescue: { state: 'fire' },
    today: { state: 'sealed' },
  },
  anchors: ['portal', 'racks', 'stacks', 'stacks2', 'bays', 'vault', 'junction', 'roadway', 'bench', 'cradle', 'desk', 'water'],
  views: ['portal', 'drift', 'bays', 'vault', 'roadway', 'workbay'],
  looks: ['natural'],
};
