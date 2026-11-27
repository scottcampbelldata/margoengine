# The Boolean Bench

Union keeps both solids, subtraction removes the second from the first, and intersection keeps the volume they share. Switch to exact edges to see the same boundary-representation topology without internal tessellation edges.

Margo builds the two operands and validates all three Boolean results in generate.mjs. Each operand and all three results are closed solids. The generator independently checks both Boolean volume identities. The web exhibit switches among exact kernel results and draws either their certified tessellation or their original geometric edge segments.

- [Aristides A. G. Requicha, Representations for Rigid Solids, 1980](https://doi.org/10.1145/356827.356833).
