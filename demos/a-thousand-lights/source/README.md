# A Thousand Lights

Sweep the control to move a thousand live lights through the hall, or play the full cycle. The installation hangs a chamfered bronze ribbon over an engraved circular plinth in a ribbed basalt interior.

Margo Clustered evaluates 1,000 point and spot emitters per state. Six of those emitters use spot shadow maps and cast shadows from the suspended bronze. The counter reads the actual submitted lights. The matching lens instances are depth tested. The same thousand emitters drive the opening frame. On WebGL2 the fixed camera uses one conservative light list to avoid rebuilding a separate list for each of the 192 native clusters. Both paths evaluate the same light ranges and shadow maps. Their shadow maps and bloom load after the hall becomes interactive. The performance button opens Margo's live frame-time and draw-call readout.

The native WebGPU renderer and Margo's full WebGL2 compatibility renderer draw the same scene. Use `?backend=webgl2` to exercise the compatibility route.

- Ola Olsson, Markus Billeter and Ulf Assarsson (2012), *Clustered Deferred and Forward Shading*. [Paper](https://research.chalmers.se/en/publication/161725)
- Kimbell Art Museum, *Kahn Building in Detail*. The separation of a ribbed structure from its reflective surfaces informed the original hall. [Architecture notes](https://kimbellart.org/content/kahn-building-detail)
- Benesse Art Site Naoshima, *Chichu Art Museum*. Reference for a dark architectural enclosure whose appearance changes with illumination. [Museum architecture](https://www.benesse-artsite.jp/en/art/chichu.html)
