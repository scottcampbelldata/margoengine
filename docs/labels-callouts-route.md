# Routed callouts

The optional `@margoengine/labels/callouts-route` entry exports `RoutedCallouts`
as a `LabelRenderer` layout and `routeCalloutLeaders` as a pure routing function.
Each leader has an angled segment to a common bend column followed by a horizontal
segment to the corresponding label. Labels are reordered into disjoint slots.
Left and right columns are supported. Coincident anchors share only their origin.

The pure function takes equal-length arrays of finite screen points and label
ports, plus the bend column x coordinate. Ports must share a column and have
distinct y coordinates. The bend column must lie strictly between all sources
and the port column. It returns the input source index, assigned port index and
three points for each leader. The layout creates valid columns automatically.

Defaults are side `auto` (the side with more room), gap 16 px on either side of
the elbow column, box padding 4 px, view margin 8 px, color `currentColor`, width
1 px, and overflow enabled. All dimensions are CSS pixels. Slots use the largest
box height, so variable-sized boxes do not overlap. Their measured width/height
must be finite and nonzero. A distance layout may wrap this layout: it then sees
the final scaled sizes. Anchors and screen offsets remain owned by their labels.

When space is insufficient, the callout column can extend beyond the view. The
layout temporarily enables overlay overflow and restores it on `clear`/`dispose`.
Set `overflow: false` to require the column and boxes to fit; insufficient space
throws instead of silently dropping labels. `clear` removes every SVG leader;
`Symbol.dispose` is supported. The renderer removes its overlay on disposal.

The matching uses a balanced angular partition. Reflect a left column so ports
are on the right, then choose the extreme left source. All remaining points are
in one angular half-plane. Sort them around that source and take the first prefix
whose red-source and blue-port counts balance, including the chosen source. Its
last point is a port; match that pair and solve the two balanced partitions.
The resulting segment separates the remaining subproblems. Nearer collinear red
points precede ports, so a selected segment cannot pass through an unmatched
anchor. Coincident sources stay on the shared boundary and fan to distinct ports.
All horizontal terminal segments lie beyond the bend column, outside the region
of the matched angled segments. Thus distinct leaders cannot cross or overlap.

Orientation uses a conservative binary64 filter and exact BigInt determinants
when uncertain, including overflow and subnormal cases. Every finite binary64
coordinate has an exact integer representation in units of 2^-1074. Sorting uses
that sign rather than an angle approximation. An explicit work stack avoids
recursive call-stack limits. The worst case is O(n squared log n) comparison work;
this is a callout layout, with no throughput claim. It does not minimize total
leader length, route around scene obstacles or implement a multi-sided optimal
boundary-labeling solver. The requested angled-elbow and crossing-free layout is
complete; those are additional objectives, not hidden behavior.

Tests independently check intersections, touching and overlaps, injective ports,
collinear/coincident anchors, both sides, seeded point clouds, extreme binary64
scales, box layout, removal and still-frame caching. Browser tests check real SVG
endpoints against the reordered DOM boxes within 1 px on WebGPU and WebGL2.
