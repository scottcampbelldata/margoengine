# The Neural Playground

Exhibit 67 in the Margo Web Demos brief. This decision atlas lets the visitor train, pause and step a small classifier. Select Crescents or Rings for a fresh run. Choose a class and place a labeled point on the map to perturb the training set. Keyboard users can focus the map, move the marker with the arrow keys and press Enter or Space to plant it.

## Model and provenance

- `data.js` generates two original, deterministic synthetic datasets. Each starts with 38 points per class and accepts up to 144 total points. The exhibit uses only these examples and the points placed during the session. The counter measures accuracy on the training samples.
- Two position inputs feed ten tanh units and one binary logit. `trainer.js` uses two custom `@margoengine/compute` WGSL kernels. Each backpropagation invocation owns one of the 41 weights or biases, computes its mean gradient over the full training batch, and writes the parameter and its bias-corrected Adam moments to an alternate GPU buffer. The readout kernel evaluates the classifier at the 65×65 map vertices and at the labeled points.
- The map uses 17 display bands and linearly interpolated contours over the model's sampled logit. The cream contour is the 50% class decision boundary. The thinner guides are the 25% and 75% class-B probabilities. The bands emphasize uncertainty around the boundary and share the same geometry resolution on phone and desktop. PBR materials and geometry draw all parts of the map through Margo Engine.
- WebGPU is the default. Margo WebGL2 compatibility runs both compute kernels in its GPU scatter tier and draws the same map. This was verified with the device's dispatch counters for automatic and forced compatibility. The page exposes the same controls and marks the first completed rendered training step as `neural-step-applied`.

## Sources

- Rumelhart, David E., Geoffrey E. Hinton, and Ronald J. Williams. 1986. [Learning representations by back-propagating errors](https://www.nature.com/articles/323533a0). *Nature* 323, 533–536.
- Kingma, Diederik P., and Jimmy Ba. 2014. [Adam: A Method for Stochastic Optimization](https://arxiv.org/abs/1412.6980).
- Margo Engine public main, [verified build pin 0efd9cff](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). The implementation uses the public Compute custom-kernel and Core geometry APIs.
