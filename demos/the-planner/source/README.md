# The Planner

Exhibit 165 of the Margo Web Demos brief. Nessa, the worker at a ridge lookout, needs a cooked supper and time to rest. The displayed itinerary comes from the selected stock Margo planner. **Start rain** changes the conditions and checks the plan again. **Run plan** makes Nessa carry out the listed actions. It can pause between frames. **Reset** restores the clear evening and the original supplies.

## What changes

- **Lowest effort** runs @margoengine/behavior/goap's planActions over the currently committed facts, action preconditions and effects. In clear weather it selects the cheaper splitting route, with total effort 5.8. In rain it takes covered kindling instead, for total effort 7.4. Effort is a unitless scenario cost. Animation duration is separate.
- **Camp routine** uses @margoengine/behavior/htn's planTasks. Its Evening compound task decomposes into Supper and Recovery. The fuel methods prioritize covered kindling as the house routine. The primitive tasks, resulting effects and visual actions are the same ones used by GOAP.
- The stump's split timber, covered rack inventory, stove, supper and rest readout update from completed actions. Changing conditions mid-action cancels the unfinished work and selects a legal continuation from the last committed world state. A prepared meal or lit stove is retained on a later replan.
- The route marks connect the actual planned stations using a shared porch crossing. The worker’s gait uses a measured human walk matched to traveled distance. Work gestures use authored kinematics. Both use inverse kinematics and Margo’s four-influence skinning. Travel and tools are animated staging. The exhibit models task dependencies and resource effects, without computing combustion, fluid mechanics, fatigue physiology or collision dynamics.

## Art and implementation

The lookout, roof cutaway, shelves, timber fixtures, weather, layered ridge and character art were authored for this exhibit. Nessa's base body, fitted field clothes, eyes, shoes and hair are adapted from standard MakeHuman community CC0 assets. The character is 1.59 m tall in engine space. Blender and MPFB 2.0.18 export the 52-joint character using author-worker.py. Pass the output .skin path and the extracted CC0 standard assets folder after Blender's -- separator. The authored character, wardrobe and materials are the same on all renderer paths. [MakeHuman asset licensing](https://static.makehumancommunity.org/about/license.html)

The public engine pin is 0efd9cff8230507a32deb49907ecd499d46925f5. Stock Margo packages used at runtime include core, quality, behavior/goap, behavior/htn, rigging/ik and animation. The core renders with WebGPU first. The stock WebGL2 renderer loads when needed, or when ?backend=webgl2 requests it. The rig uses the same skeletal transforms, surfaces and PBR materials in both paths.

The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217. The browser uses a small set of measured joints from subject 35, trial 35_02, at frames 191–326. `tools/sample-cmu-walk.mjs` reproduces those samples from the ASF and AMC source files. [CMU recording](https://mocap.cs.cmu.edu/search.php?subjectnumber=35)

## References

- Richard Fikes and Nils Nilsson (1971), *STRIPS: A New Approach to the Application of Theorem Proving to Problem Solving*. Basis for precondition/effect planning. [Original paper](https://ai.stanford.edu/~nilsson/OnlinePubs-Nils/PublishedPapers/strips.pdf)
- Jeff Orkin (2004), *Applying Goal-Oriented Action Planning to Games*. Goal-directed plans for game characters. [Author paper](https://static.hlt.bme.hu/semantics/external/pages/GOAP/alumni.media.mit.edu/_jorkin/GOAP_draft_AIWisdom2_2003.pdf)
- Kutluhan Erol, James Hendler and Dana Nau (1994), *HTN Planning: Complexity and Expressivity*. Ordered task decomposition. [AAAI paper](https://cdn.aaai.org/AAAI/1994/AAAI94-173.pdf)
- Andreas Aristidou and Joan Lasenby (2011), *FABRIK: A Fast, Iterative Solver for the Inverse Kinematics Problem*. [Author paper](https://www.andreasaristidou.com/publications/papers/FABRIK.pdf)
- U.S. National Park Service, *Mount Harkness Fire Lookout*. Rustic wood, stone and roof references. [Lookout record](https://home.nps.gov/places/mount-harkness-fire-lookout.htm)
- Cindy Schacher (2010), *Lookout Styles*. Roofed lookout cabins and their construction. [U.S. Forest Service](https://www.fs.usda.gov/media/259212)

## Browser verification

The isolated QA harness serves production Vite output and checks the first changed rendered frame after a trusted rain tap. The mobile profile is 390 × 844 CSS px, DPR 2, 150 ms RTT, 1.6 Mbps downstream and fourfold CPU slowdown in fresh Chromium contexts. The complete passes cover the dry and interrupted/rain routes, the sheltered stock, stove, meal and rest effects, and the HTN route selector. Consequence frames are captured from the actual Margo canvas. Browser QA uses workstation emulation.
