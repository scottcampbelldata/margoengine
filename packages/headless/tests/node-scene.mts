// The stage scene of browser-check.js, drawn in Node on the real binding. browser-check.mjs compares it with the page.
import { writeFile } from 'node:fs/promises';
import { createHeadlessStage } from '@margoengine/headless/stage';
import { addSky } from '@margoengine/stage/sky';
import { create } from 'webgpu';

const errors: string[] = [];
using stage = await createHeadlessStage({ gpu: create([]), width: 320, height: 180 });
stage.engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
stage.box({ color: '#84d6bd', size: [2, 1, 1] });
stage.sphere({ color: '#d68484', radius: 0.5, position: [1.5, 0, 0] });
await addSky(stage);
stage.fit();
await writeFile(process.argv[2]!, await stage.toPNG());
if (errors.length) throw new Error(errors.join('\n'));
