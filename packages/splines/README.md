# @margoengine/splines

Piecewise 3D Catmull-Rom, cubic Bezier and cubic Hermite curves, with a cached arc-length lookup.

```ts
import {Spline} from '@margoengine/splines';
const curve = new Spline([[0,0,0], [5,1,5], [10,0,10]]);
const point = new Float64Array(3);
curve.atDistance(curve.length / 2, point);
curve.tangent(0.5, point);
```

Bezier curves require 3n+1 points and are open. Hermite requires one tangent per point; Catmull-Rom and Hermite can be closed. at uses t in 0..1; atDistance uses world units. Returned default output is reused, so provide an output buffer to retain multiple results. After editing points, call updateArcLengths. Arc lengths/tangents are numerical approximations controlled by divisions.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/splines

