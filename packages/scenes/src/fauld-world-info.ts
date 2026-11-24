// Catalogue data of the fauld-countryside and fauld-crater scenes, shared by the catalogue root and the scene entries
// (no imports: listing the catalogue loads no package). The settings are FauldWorldSettings of fauld-world.ts.
import type { SceneInfo } from './index.js';

const settings: SceneInfo['settings'] = {
  era: {
    default: 'before',
    options: ['before', '1944', 'today'],
    about: 'the farm before, the fresh 1944 crater, or the wooded crater today',
  },
  sky: {
    default: 'lowSun',
    options: ['dawn', 'lowSun', 'overcast', 'grey', 'dusk', 'night', 'snow', 'rain', 'mist'],
    about: 'sky and weather of a late-November day at Fauld',
  },
  hour: { default: 11.5, range: [0, 24], unit: 'h', about: 'local solar time on 27 November (default by sky)' },
  radius: { default: 2500, range: [200, 3000], unit: 'm', about: 'how far round the camera the view grows plants' },
  buildings: { default: true, about: 'draws the Tripo buildings, vehicles and cattle of FAULD_SLOTS for the era' },
  library: { default: '/asset-library/', about: 'URL root of the asset library (margo-library/fauld and dem)' },
};
const anchors = ['crater', 'farm', 'hanbury', 'church', 'inn', 'works', 'reservoir', 'dove', 'tutbury'];

/** The catalogue entry of the countryside round Hanbury and Fauld. */
export const fauldCountrysideInfo: SceneInfo = {
  name: 'fauld-countryside',
  title: 'The countryside round Fauld and Hanbury (Staffordshire, November 1944)',
  about:
    'The real hills round Hanbury and Fauld from Ordnance Survey OS Terrain 50, the hedged field quilt of the English lowland farm world, hedgerows and woods from library trees, Hanbury church, the Cock Inn, cottages, the kiln works and a grazing herd, under a late-November sky.',
  entry: '@margoengine/scenes/fauld-countryside',
  settings,
  presets: { morning: { sky: 'dawn' }, day: { sky: 'lowSun' }, after: { era: '1944', sky: 'grey' } },
  anchors,
  views: ['aerial', 'lane', 'pasture'],
};

/** The catalogue entry of the crater: the fresh 1944 crater or the wooded hollow today. */
export const fauldCraterInfo: SceneInfo = {
  name: 'fauld-crater',
  title: 'The Fauld crater (Staffordshire, 1944 and today)',
  about:
    'The crater the explosion of 27 November 1944 left where Upper Castle Hayes Farm stood, stamped into the real ground from its model: bare marl and gypsum in 1944, the wooded hollow today, with the farm quilt round it.',
  entry: '@margoengine/scenes/fauld-crater',
  settings: { ...settings, era: { ...settings.era, default: '1944' } },
  presets: { fresh: { era: '1944', sky: 'grey' }, snow: { era: '1944', sky: 'snow' }, today: { era: 'today' } },
  anchors,
  views: ['rim', 'aerial', 'floor'],
};
