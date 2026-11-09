// Preloaded only in the isolated README child. Never changes the runner's fetch or a published package.
import { readmeNodeFetch } from './readme-assets.mjs';
globalThis.fetch = readmeNodeFetch();
