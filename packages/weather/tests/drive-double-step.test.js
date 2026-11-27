// A WeatherDrive run by an engine and also stepped with advanceTime between its frames runs its weather faster than the
// engine clock (KB-LOOK-TV-SHIMMER2: the timber-valley shot page called scene.advanceTime each sub-frame, so the gale's
// gusts and the fire ran at twice the shot's speed). The drive refuses a doubled clock with a coded error, and still
// takes one burst of steps between frames (rolling a fire's past) and a seek after resetTime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherDrive } from '../dist/drive.js';
import { WeatherMachine } from '../dist/index.js';

const engineWith = () => {
  const plugins = [];
  const engine = {
    use: (p) => (plugins.push(p), p.setup(engine)),
    sceneOf: (p) => (plugins.includes(p) ? engine : undefined),
    removePlugin: (name) =>
      plugins.splice(
        plugins.findIndex((p) => p.name === name),
        1,
      ),
  };
  return { engine, plugins };
};

test('regression KB-LOOK-TV-SHIMMER2: an engine-run drive also stepped every frame throws a state error', () => {
  const { engine, plugins } = engineWith(),
    weather = new WeatherMachine('storm');
  WeatherDrive.attach(engine, { weather });
  const frame = () => {
    // The page's own step, then the engine's frame.
    drive.advanceTime(1 / 30);
    plugins[0].onPreUpdate(1 / 30);
  };
  const drive = plugins[0];
  frame();
  assert.throws(
    () => {
      frame();
      frame();
    },
    (error) => error.code === 'state' && /stepped with advanceTime between engine frames runs its weather too fast; .*advance: false/.test(error.message),
  );
});

test('one burst between frames, a seek after resetTime and a drive with advance false are allowed', () => {
  const { engine, plugins } = engineWith(),
    weather = new WeatherMachine('storm');
  const drive = WeatherDrive.attach(engine, { weather });
  plugins[0].onPreUpdate(1 / 30);
  for (let i = 0; i < 30; i++) drive.advanceTime(10); // a fire's past, rolled once
  for (let i = 0; i < 20; i++) plugins[0].onPreUpdate(1 / 30);
  // A seek each frame: back to 0, replay, then the engine's frame.
  for (let f = 0; f < 5; f++) {
    drive.resetTime();
    for (let i = 0; i < 4; i++) drive.advanceTime(0.25);
    plugins[0].onPreUpdate(1 / 30);
  }
  // A frame with no time (a pause) between steps neither counts nor clears the run.
  plugins[0].onPreUpdate(0);
  assert.ok(weather.time > 1);
  const other = engineWith(),
    held = new WeatherMachine('storm'),
    own = WeatherDrive.attach(other.engine, { weather: held, advance: false });
  for (let i = 0; i < 10; i++) {
    held.update(1 / 30);
    own.advanceTime(1 / 30);
    other.plugins[0].onPreUpdate(1 / 30);
  }
  // Without an engine nothing counts: a drive stepped by hand is the only clock.
  const alone = new WeatherDrive({ weather: new WeatherMachine('storm') });
  for (let i = 0; i < 10; i++) alone.advanceTime(1 / 30);
});
