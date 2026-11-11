# FSM live inspection follow-up (2026-11-10)

Compared two public specifications before writing this repair:

- WHATWG contributors, *HTML Living Standard*, 2026-11-09, section 4.11.1,
  https://html.spec.whatwg.org/multipage/interactive-elements.html#the-details-element.
  The native `open` property is the disclosure state; the `toggle` notification is
  queued. Retaining the details node preserves its current state even when a
  machine transition or filtering refresh runs before that notification.
- Jim Barnett et al., editors, *State Chart XML (SCXML): State Machine Notation
  for Control Abstraction*, W3C Recommendation, 2015, sections 3.5 and 3.13,
  https://www.w3.org/TR/scxml/. Authored event and eventless triggers are distinct
  from the runtime's selection mechanism. This repair displays the original
  final-runtime definitions without running guards or changing dispatch.

The view retains native disclosure nodes per machine identity and state name,
including while filtered out. Distinct parallel machines with identical state
names remain independent. Disposal clears the retained nodes. The optional
final runtime supplies `transitionDefinitions`; ordinary StateMachine remains
unchanged, and the inspect entry has only a type import of the final runtime.
No other repository implementation or companion code was read or copied.

Reproduce the regressions after `npm run build:packages`:

```
node --test --test-timeout=60000 packages/fsm/test/inspect.test.js packages/fsm/test/final.test.js
node packages/fsm/test/inspect-browser.mjs
node packages/fsm/test/inspect-browser.mjs --compat
npm run check:readme-run -- --packages=fsm
```

CPU coverage includes immediate close before queued toggle, filtering, separate
same-named regions, text-only event rendering, unchanged public descriptions
during microsteps, preserved trace metadata and no inspection guard calls.
Browser coverage uses a real summary click and a live transition, plus public
always/delay labels. It certifies browser DOM behavior, not human assistive
technology or physical device acceptance. No timing or rendering claim.
