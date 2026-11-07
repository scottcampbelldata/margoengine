# METAR reports (test fixture)

`metar.txt` and `metar2.txt` are 798 routine and special aerodrome reports (METAR, SPECI) from 50 aerodromes, the 12
hours before 2026-11-07 17:15 UTC, as the NOAA Aviation Weather Center's data service serves them, one report a line:

- `metar.txt`: https://aviationweather.gov/api/data/metar?ids=EGLL,KJFK,KORD,KDEN,CYYZ,LFPG,EDDF,RJTT,YSSY,ENGM,UUEE,KMIA,BIKF,LIRF,ZBAA,SBGR,FAOR,VIDP,NZAA,PANC&format=raw&hours=12,
  399 lines, 30,720 bytes, SHA-256 2ab25e4c497e3dec530ab26135ca3fe762ce0b0dae7f36f5db0bc69a5a6fdf79.
- `metar2.txt`: the same service for ULLI, UUWW, ESSA, EFHK, ENTC, BGSF, CYUL, CYWG, CYEG, PAFA, KMSP, KBUF, KSEA, VTBS,
  WSSS, RPLL, VHHH, WMKK, MMMX, SKBO, KTPA, KHOU, FACT, HKJK, OMDB, LTFM, LEMD, EGPF, EIDW and LOWW, 399 lines, 30,134
  bytes, SHA-256 177e105cf7947f97ea84d344700b1956211f5683aee8da5a66c186b99e59c43d.
- Downloaded 2026-11-07. Terms: information from the NOAA Aviation Weather Center, a United States Government work,
  public domain in the United States; the reports themselves are the observations of the national weather services
  that issue them, exchanged under WMO Resolution 40 as essential data. Used only by the tests of
  `@margoengine/weather/data`; not shipped in any package.
