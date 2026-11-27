# The Dungeon Maker

Generate a new connected stone archive, or enter the current seed in first person. The model view exposes the real chambers and doorways. In the walkthrough, use the arrow buttons or the keyboard to move. Drag to aim the view. On a touchscreen, the left half of the scene is a movement stick and the right half turns the camera. W, A, S and D also work.

The seed first places an entrance, a vault and a few room anchors using Margo's procedural dungeon package. A constrained wave function collapse then solves the unpinned tiles on a 13 × 2 × 11 grid. The lower layer chooses rock, corridors and chamber styles. The upper layer assigns a compatible ceiling over every floor. The layout requires at least 49 walkable tiles, at most 76, one connected walkable component and a route to the vault. Walkable neighbors share real open passages. A worker produces the final scene geometry from the same tile map.

The two layers describe the archive floor and ceiling. Visitors walk the lower layer. Doorways have a roughly 2.46-metre clear structural opening and a genuine stone reveal. The original flagstones, arches, mounted lamps, storage and vault prism are Margo geometry. Point sources light the rooms in real time. Margo WalkControls collides with the resulting meshes. The model view lifts the ceiling for visibility.

The browser verification checked 24 distinct seeds, lower-layer connectivity, all vertical adjacencies and reproducibility of the opening seed. Walkthrough testing drove the camera into the perimeter and verified that it stopped inside the modeled wall.

## References

- Isaac Karth and Adam M. Smith. *WaveFunctionCollapse is Constraint Solving in the Wild*, 2017. [Paper](https://escholarship.org/uc/item/1f29235t)
- Joris Dormans. *Adventures in Level Design: Generating Missions and Spaces for Action Adventure Games*, 2010. [Paper](https://pcgworkshop.com/archive/dormans2010adventures.pdf)
- Noor Shaker, Antonios Liapis, Julian Togelius, Ricardo de Vasconcelos Abreu Lopes and Rafael Bidarra. *Constructive Generation Methods for Dungeons and Levels*, 2016. [Chapter](https://research.tudelft.nl/en/publications/constructive-generation-methods-for-dungeons-and-levels/)
