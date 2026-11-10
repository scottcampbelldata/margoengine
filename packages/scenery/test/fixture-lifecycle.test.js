import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
for(const name of ['stars','aurora','scenes','presets'])test(`${name} fixture releases its engine before browser navigation`,()=>{
 const html=readFileSync(new URL(`./${name}-check.html`,import.meta.url),'utf8');
 const release=html.match(/dispose:\(\)=>engine\.dispose\(\)/)?.[0];assert.ok(release);
 let calls=0;const check=new Function('engine',`return {${release}}`)({dispose(){calls++;}});
 check.dispose();assert.equal(calls,1);
 const runner=readFileSync(new URL('./scenery-check.mjs',import.meta.url),'utf8');
 assert.match(runner,/finally\s*\{\s*await page\.evaluate\(\(\) => window\.check\.dispose\(\)\)/);
});
