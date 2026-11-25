import test from "node:test";
import assert from "node:assert/strict";
import { World, Schedule } from "../dist/index.js";
import { Scripts, defineScript } from "../dist/scripts.js";

const setup = (options) => {
  const world = new World(64);
  return { world, scripts: new Scripts(world, options), log: [] };
};
const logger = (log, id) =>
  Object.fromEntries(
    [
      "onEnable",
      "initialize",
      "postInitialize",
      "update",
      "postUpdate",
      "fixedUpdate",
      "onDisable",
      "destroy",
    ].map((h) => [
      h,
      function () {
        log.push(`${id}.${h}`);
      },
    ]),
  );

test("hooks run in order: enable, initialize, postInitialize once, then update, postUpdate, destroy", () => {
  const { world, scripts, log } = setup();
  const a = defineScript({ name: "a", ...logger(log, "a") }),
    b = defineScript({ name: "b", ...logger(log, "b") });
  scripts.register(a).register(b);
  const e = world.create();
  scripts.add(e, a);
  scripts.add(e, "b");
  assert.deepEqual(log, []);
  scripts.update(0.1);
  assert.deepEqual(log, [
    "a.onEnable",
    "a.initialize",
    "b.onEnable",
    "b.initialize",
    "a.postInitialize",
    "b.postInitialize",
    "a.update",
    "b.update",
    "a.postUpdate",
    "b.postUpdate",
  ]);
  log.length = 0;
  scripts.update(0.1);
  assert.deepEqual(log, [
    "a.update",
    "b.update",
    "a.postUpdate",
    "b.postUpdate",
  ]);
  log.length = 0;
  scripts.fixedUpdate(1 / 60);
  assert.deepEqual(log, ["a.fixedUpdate", "b.fixedUpdate"]);
  log.length = 0;
  world.destroy(e);
  assert.deepEqual(log, [
    "a.onDisable",
    "a.destroy",
    "b.onDisable",
    "b.destroy",
  ]);
  assert.equal(scripts.on(e).length, 0);
});

test("priority orders instances across entities", () => {
  const { world, scripts, log } = setup();
  const late = defineScript({
    name: "late",
    priority: 5,
    update() {
      log.push("late");
    },
  });
  const early = defineScript({
    name: "early",
    priority: -5,
    update() {
      log.push("early");
    },
  });
  scripts.register(late).register(early);
  scripts.add(world.create(), late);
  scripts.add(world.create(), early);
  scripts.update(0);
  assert.deepEqual(log, ["early", "late"]);
});

test("attributes: defaults, validation with coded errors, schema export, onAttributeChange", () => {
  const { world, scripts } = setup();
  const changes = [];
  const t = defineScript({
    name: "mover",
    attributes: {
      speed: { type: "number", default: 2, min: 0, max: 10 },
      on: { type: "boolean" },
      label: { type: "string", default: "x" },
      mode: { type: "enum", options: ["walk", "run"] },
      dir: { type: "vec3" },
      tint: { type: "color" },
      target: { type: "entity" },
      mesh: { type: "asset", assetKind: "model" },
    },
    onAttributeChange(name, value, previous) {
      changes.push([name, value, previous]);
    },
  });
  scripts.register(t);
  const s = scripts.add(world.create(), t, {
    values: { tint: "#ff0000", dir: [1, 2, 3] },
  });
  assert.deepEqual(
    { ...s.attributes },
    {
      speed: 2,
      on: false,
      label: "x",
      mode: "walk",
      dir: [1, 2, 3],
      tint: [1, 0, 0, 1],
      target: null,
      mesh: null,
    },
  );
  scripts.flush();
  s.attributes.speed = 5;
  s.attributes.speed = 5; // unchanged: no notification
  s.attributes.dir = [1, 2, 4];
  assert.deepEqual(changes, [
    ["speed", 5, 2],
    ["dir", [1, 2, 4], [1, 2, 3]],
  ]);
  assert.throws(() => (s.attributes.speed = 11), RangeError);
  assert.throws(() => (s.attributes.speed = NaN), /finite number/);
  assert.throws(() => (s.attributes.mode = "fly"), /one of walk, run/);
  assert.throws(() => (s.attributes.dir = [1, 2]), /3 numbers/);
  assert.throws(() => (s.attributes.tint = [2, 0, 0, 1]), RangeError);
  assert.equal(s.attributes.speed, 5);
  assert.throws(
    () => scripts.add(world.create(), t, { values: { nope: 1 } }),
    /Unknown attribute nope/,
  );
  assert.throws(
    () =>
      defineScript({
        name: "z",
        attributes: { a: { type: "number", default: 5, max: 1 } },
      }),
    RangeError,
  );
  assert.throws(
    () => defineScript({ name: "z", attributes: { a: { type: "blob" } } }),
    TypeError,
  );
  assert.throws(() => defineScript({ name: "z", update: 3 }), TypeError);
  const schema = JSON.parse(JSON.stringify(scripts.schema()));
  assert.equal(schema[0].name, "mover");
  assert.equal(schema[0].attributes.length, 8);
  assert.deepEqual(
    schema[0].attributes.find((a) => a.name === "speed"),
    {
      name: "speed",
      type: "number",
      default: 2,
      min: 0,
      max: 10,
      title: "speed",
    },
  );
});

test("enable and disable per instance", () => {
  const { world, scripts, log } = setup();
  const t = defineScript({ name: "t", ...logger(log, "t") });
  scripts.register(t);
  const inst = scripts.add(world.create(), t, { enabled: false });
  scripts.update(0);
  assert.deepEqual(log, [], "a disabled instance is not initialised");
  inst.enabled = true;
  scripts.update(0);
  assert.deepEqual(log, [
    "t.onEnable",
    "t.initialize",
    "t.postInitialize",
    "t.update",
    "t.postUpdate",
  ]);
  log.length = 0;
  inst.enabled = false;
  scripts.update(0);
  assert.deepEqual(log, ["t.onDisable"]);
  log.length = 0;
  inst.enabled = true;
  scripts.update(0);
  assert.deepEqual(
    log,
    ["t.onEnable", "t.update", "t.postUpdate"],
    "initialize does not run twice",
  );
  log.length = 0;
  assert.equal(scripts.remove(inst), 1);
  assert.deepEqual(log, ["t.onDisable", "t.destroy"]);
});

test("an error in one script is reported and the others still run", () => {
  const seen = [];
  const { world, scripts, log } = setup({
    onError: (e, { hook, script }) =>
      seen.push([e.message, hook, script.type.name]),
  });
  scripts.register(
    defineScript({
      name: "bad",
      update() {
        throw new Error("boom");
      },
    }),
  );
  scripts.register(
    defineScript({
      name: "good",
      update() {
        log.push("good");
      },
    }),
  );
  const e = world.create();
  scripts.add(e, "bad");
  scripts.add(e, "good");
  scripts.update(0);
  assert.deepEqual(seen, [["boom", "update", "bad"]]);
  assert.deepEqual(log, ["good"]);
});

test("without onError the error is rethrown after the pass as a coded MargoError with the cause", () => {
  const { world, scripts, log } = setup();
  scripts.register(
    defineScript({
      name: "bad",
      update() {
        throw new Error("boom");
      },
    }),
  );
  scripts.register(
    defineScript({
      name: "good",
      update() {
        log.push("good");
      },
    }),
  );
  scripts.add(world.create(), "bad");
  scripts.add(world.create(), "good");
  assert.throws(
    () => scripts.update(0),
    (e) => e.code === "failed" && e.cause.message === "boom",
  );
  assert.deepEqual(log, ["good"]);
});

test("hot reload keeps instances, attributes, state and enabled flag, and does not re-initialize", () => {
  const { world, scripts, log } = setup();
  const v1 = defineScript({
    name: "spin",
    attributes: {
      speed: { type: "number", default: 1 },
      gone: { type: "string", default: "g" },
    },
    initialize() {
      log.push("init1");
      this.state.angle = 0;
    },
    update(dt) {
      this.state.angle += this.attributes.speed * dt;
    },
  });
  scripts.register(v1);
  const e = world.create();
  const s = scripts.add(e, v1, { values: { speed: 3 } });
  const off = scripts.add(e, v1, { enabled: false });
  scripts.update(1);
  assert.equal(s.state.angle, 3);
  const v2 = defineScript({
    name: "spin",
    attributes: {
      speed: { type: "number", default: 1, max: 2 },
      extra: { type: "number", default: 7 },
    },
    initialize() {
      log.push("init2");
    },
    swap(previous) {
      log.push(`swap from ${previous === v1}`);
      if (this.state.angle !== undefined) this.state.angle *= 10;
    },
    update(dt) {
      this.state.angle += this.attributes.extra * dt;
    },
  });
  assert.equal(scripts.reload(v2), 2);
  assert.equal(scripts.on(e)[0], s, "the same instance object");
  assert.equal(s.type, v2);
  assert.equal(
    s.attributes.speed,
    1,
    "a value now invalid falls back to the new default",
  );
  assert.equal(s.attributes.extra, 7);
  assert.equal("gone" in s.attributes, false);
  assert.equal(off.enabled, false);
  scripts.update(1);
  assert.equal(s.state.angle, 37);
  assert.deepEqual(log, ["init1", "swap from true", "swap from true"]);
});

test("hot reload keeps a valid attribute value, and reinitialize re-runs destroy then initialize", () => {
  const { world, scripts, log } = setup();
  const make = (id) =>
    defineScript({
      name: "x",
      attributes: { n: { type: "number", default: 1 } },
      initialize() {
        log.push(`init${id}`);
      },
      destroy() {
        log.push(`destroy${id}`);
      },
    });
  scripts.register(make(1));
  const s = scripts.add(world.create(), "x", { values: { n: 9 } });
  scripts.update(0);
  scripts.reload(make(2));
  assert.equal(s.attributes.n, 9);
  scripts.reload(make(3), { reinitialize: true });
  scripts.update(0);
  assert.deepEqual(log, ["init1", "destroy2", "init3"]);
  assert.equal(s.attributes.n, 9);
});

test("dispose destroys every instance, and the registry then refuses use", () => {
  const { world, log } = setup();
  const scripts = new Scripts(world);
  scripts.register(defineScript({ name: "t", ...logger(log, "t") }));
  scripts.add(world.create(), "t");
  scripts.flush();
  log.length = 0;
  scripts[Symbol.dispose]();
  assert.deepEqual(log, ["t.onDisable", "t.destroy"]);
  assert.throws(
    () => scripts.update(0),
    (e) => e.code === "disposed",
  );
  scripts[Symbol.dispose]();
});

test("install adds a frame system and a fixed system to a Schedule", () => {
  const { world, scripts, log } = setup();
  scripts.register(
    defineScript({
      name: "t",
      fixedUpdate() {
        log.push("f");
      },
      update() {
        log.push("u");
      },
    }),
  );
  scripts.add(world.create(), "t");
  const schedule = new Schedule({ step: 0.1 });
  scripts.install(schedule);
  schedule.update(0.25);
  assert.deepEqual(log, ["f", "f", "u"]);
});

test("add refuses a stale entity and an unregistered type; a repeated name asks for reload", () => {
  const { world, scripts } = setup();
  const e = world.create();
  assert.throws(
    () => scripts.add(e, "nope"),
    (x) => x.code === "state",
  );
  scripts.register(defineScript({ name: "t" }));
  world.destroy(e);
  assert.throws(
    () => scripts.add(e, "t"),
    (x) => x.code === "state",
  );
  assert.throws(() => scripts.register(defineScript({ name: "t" })), /reload/);
});
