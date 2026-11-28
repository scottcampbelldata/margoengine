# The Hollow Cup

A circular blank becomes a cast cup. The draft slider tapers the outside wall about its base plane before the shell operation. The thickness slider changes the measured wall and base thickness after opening the top.

Margo's B-rep modeler builds and checks all 25 states in generate.mjs. Each output forms a closed topological solid around its open cavity. The generator writes the 25 tessellations as one meshopt-compressed glTF (one node per state); the page shows the selected one in sand-cast iron on `@margoengine/studio/bench` and `@margoengine/machinery/bench`, alongside the kernel's exact solid volume and face count.

- [Aristides A. G. Requicha, Representations for Rigid Solids, 1980](https://doi.org/10.1145/356827.356833).
