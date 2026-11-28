# State Machine Door

The vault puts the running statechart next to the mechanism it drives. Open the leaf, switch on the chamber lamp, hold during a swing, and resume. The chart displays the active drive and lamp regions at the same time. In Hold, it displays the remembered leaf of each stopped region. The transition log comes from the engine's recorded transitions.

The public Margo Engine pin provides `@margoengine/fsm` for the hierarchy, `@margoengine/fsm/parallel` for the independent drive and inspection regions, and `@margoengine/fsm/trace` for snapshots and the event log. The Hold event leaves Service from its active descendant. Its deep history returns through Mechanism to Operating, and the parallel region history restores the drive phase and lamp together. Drive update hooks retain their stroke progress across the interruption. The door can swing only after the bolts fully retract. Once it closes, the bolts extend before the drive becomes sealed.

All geometry was authored for the exhibit. The render uses Margo's core PBR lighting and the same authored geometry, materials and camera on WebGPU and WebGL2. The lamp switches an authored lighting state on the chamber surfaces and pilot lenses. The stroke curves describe a fictional museum mechanism with illustrative interlocks.

## References

- David Harel, “Statecharts: A Visual Formalism for Complex Systems,” *Science of Computer Programming*, 1987. Hierarchy, orthogonal regions and history. [Original paper](https://doi.org/10.1016/0167-6423(87)90035-9).
- World Wide Web Consortium, *State Chart XML (SCXML): State Machine Notation for Control Abstraction*, 2015. Parallel active states and deep history. [W3C Recommendation](https://www.w3.org/TR/scxml/).
- Smithsonian National Museum of American History, *The Value of Money*, vault door visual description. Physical reference for concentric metal construction, a spoke wheel and a visible bolt mechanism. [Museum exhibit](https://americanhistory.si.edu/visual-descriptions/value-of-money).
