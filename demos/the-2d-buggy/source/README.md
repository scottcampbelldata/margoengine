# The 2D Buggy

Drive forward to climb Salt Ridge. Brake to stop on a slope, reverse to back down, and restart to repeat the run. The arrow keys and Space also control the buggy. The five checkpoint flags track the farthest point reached. The spring bars read the independent suspension lengths in the simulation.

A 650 kg chassis drives on two ray-cast wheels in Margo Physics2D. The trail drawing and the stock polyline collider use the same quarter-metre samples. The engine solves wheel contact, spring and damper response, tire traction and braking. The view places each wheel at the measured center and rotates it by its actual spin. The driver limits requested speed near the ends of the trail through the same force and brake controls. The buggy follows its physical trajectory as the camera follows it. [Erin Catto, Soft Constraints, GDC 2011](https://box2d.org/files/ErinCatto_SoftConstraints_GDC2011.pdf).

Both renderers show the same layered terrain, vehicle art and solver output. WebGPU is tried first. The direct Margo WebGL2 renderer uses the same core meshes. The browser opens exactly one losslessly compressed copy of the stock selected SIMD or scalar kernel. The decompressed SIMD SHA-256 is `d921119b281178f8b624dffabdb2a3fdbaf1810aa20bace5f53fa248987e1a33`, and the scalar SHA-256 is `c8aaf4cffc5c847dac18e852501c6a6998a7e0fd58070a2535bc63295a808dd8`. [Verified public Margo main revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

The full numerical route covers all five flags and reaches a controlled stop before the edge of the 160 m mesh. The browser check drives the buggy from rest, observes real travel and different spring lengths, reaches a flag, brakes, reverses and restarts.
