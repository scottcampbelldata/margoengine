# L-System Garden

Grow three original botanical specimens in a modeled glasshouse. Rewrite the axiom and production rules, change the turtle angle, step forward or scrub back through generations. Drag to orbit the plant.

## Growth model

The axiom is the starting module string. The Margo procedural package applies all production rules in parallel for each generation, interprets the result with a three-dimensional turtle and turns the resulting branch network into tapered tubes. One rule per line uses the form `A = F[+A][-A]`. Symbols without a rule carry through unchanged. Square brackets save and restore the turtle state.

- 'F' and 'G' draw stems. 'f' and 'g' advance without drawing.
- '+' and '-' turn, '&' and '^' pitch, and '/' and '\' roll. '|' reverses direction.
- '!' tapers the current branch. A parenthesized number overrides the default step or radius in meters, or the turn in degrees.
- 'L' and 'B' place a leaf or bloom at the current turtle frame. A bracketed marker pass reads their exact locations and orientation from the same Margo interpretation. The marker pass leaves the actual stem geometry and frame unchanged.

The screen counts modules, drawable stems, and the actual modeled leaf and bloom placements. Invalid edits leave the last good generation visible. The editor caps generation at six, successive module expansion at 12,000 symbols, displayed geometry at 1,700 stem segments and 720 organs, and the plant bounds at 5 m. These limits keep live editing usable.

## Original scene

Lantern bells borrow the pendent tubular calyx, four spreading sepals and contrasting corolla of fuchsia as visual cues. The other two plants are fictional silhouette studies. Their controllable grammar describes shape and branching. It abstracts real plant development. The flattened, serrated leaf edges, curved surfaces and raised venation are mesh geometry. The rose and violet flowers have separate cup, sepal and filament meshes. The glasshouse, tiled floor, raku-style glazed bowl and small soil aggregate are made for this scene.

The exhibit opens with `openBench` from Margo’s studio package, which also gives it the contact shadow. The exhibit runs from [the verified public engine revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). WebGPU opens first. The full Margo WebGL2 compatibility layer draws the same branch, leaf, flower, pot and glasshouse meshes. Append `?backend=webgl2` to test that path directly.

## References

- Aristid Lindenmayer and Przemyslaw Prusinkiewicz, *The Algorithmic Beauty of Plants*, 1990. [Parallel rewriting, turtle interpretation and plant architecture](https://link.springer.com/book/10.1007/978-1-4613-8476-2).
- Przemyslaw Prusinkiewicz, Aristid Lindenmayer and James Hanan, *Development Models of Herbaceous Plants for Computer Imagery Purposes*, SIGGRAPH 1988. [Growth sequences and three-dimensional turtle mounting](https://algorithmicbotany.org/papers/developmental.sig1988.pdf).
- Australian Biological Resources Study, *Flora of Australia*, *Fuchsia magellanica*. [Plant description and morphology](https://profiles.ala.org.au/opus/foa/profile/Fuchsia%20magellanica).
- Royal Horticultural Society, *Fuchsia magellanica 'Globosa'*. [Pendulous red and violet flower reference](https://www.rhs.org.uk/plants/7496/fuchsia-magellanica-globosa/details).
- Margo Engine, *L-systems*. [Pinned procedural package reference](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/procedural/README.md#l-systems-margoengineprocedurallsystem-23-kb-mingzip).
