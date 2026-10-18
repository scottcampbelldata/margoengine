# JT reader: licensing and patents

Research by Scott, 2026-10-18 (not legal advice; the open items below want counsel). Summary for whoever builds or
ships the JT (ISO 14306) reader in `@margoengine/brep`.

## What permits it

- **Copyright.** The JT File Format Reference's "Intellectual Property License Terms" let anyone write and distribute
  software that accepts JT input and displays or otherwise interprets it, and copy the specification's list of data
  structures and operators as far as needed for that, on the condition that it carries an appropriate copyright
  notice (below). It does not allow copying the specification document itself, Siemens software, or combining the JT
  format, structure or schema into another data format.
- **Patents.** Siemens' "JT Data Format Reference Patent Clarification Notice" licenses US 8,019,788 and US
  2011/0199382 (and foreign counterparts) royalty-free and non-exclusively, for the term of each patent, for software
  that produces, consumes and interprets JT files compliant with the specification (JT 9.5 and later, ISO 14306), and
  its distribution and use. No reciprocity clause. Only those patents; Siemens' other patents are not licensed.
  Source: https://www.plm.automation.siemens.com/media/global/en/Siemens-PLM-JT-Data-Format-Reference-Patent-Clarification-Notice-mi-X1_tcm27-58013.pdf
- **ISO.** ISO 14306:2017's foreword names the same two patents; Siemens' statement registered with ISO is RAND. The
  royalty-free notice above is the more generous grant.
- **Other techniques** in the specification (valence-coded topological mesh compression, Deering normal compression,
  quantization, Huffman/arithmetic/bitlength coding, matrix compression) rest on patents filed in the 1990s that have
  expired (for example US 5,793,371, US 6,169,549, US 6,591,019), or on textbook methods.

## What the reader must do

- Implement only what the published specification (and ISO 14306) discloses; no Siemens SDK, JT Open Toolkit, JT2Go
  or other Siemens code, decompiled or otherwise. The specification PDFs stay out of the repository (they live in a
  scratch folder; link to Siemens instead).
- Ship the notice below in the package's NOTICE file and in the JT reader's source header.
- Read JT into Margo's own model and meshes; do not convert JT's structure into another file format. (Embedded
  Parasolid XT B-rep segments are read with the XT reader, from the separately published XT format.)
- Name things nominatively ("JT reader", `parseJT`); never brand a package as "JT".

## The notice

```
This software reads the JT Data Format as described in the Siemens JT File Format Reference and ISO 14306.
Copyright in the JT data structures and operators is owned by Siemens Product Lifecycle Management Software Inc.
(Siemens Digital Industries Software) and they are used under the Siemens JT Data Format Reference Intellectual
Property License Terms. US 8,019,788, US 2011/0199382 and corresponding foreign patents are licensed royalty-free
under the Siemens JT Data Format Reference Patent Clarification Notice. JT and Parasolid are trademarks of Siemens;
they are named here only to identify the format. This software is not endorsed by or affiliated with Siemens.
```

## For counsel

- The exact expiry of US 8,019,788 (filed 30 Sept 2002; a 2,398-day term adjustment is recorded) and its foreign
  counterparts.
- Whether files older than JT 9.5 (JT 8.x) need anything beyond the expired 1990s patents.
- Whether a partial, visualization-only reader counts as "compliant with the specification" for the patent grant.
- The form and placement of the "appropriate copyright notice", and how the package licence sits with the
  restriction on combining JT into other formats.
- How the royalty-free notice and the RAND statement registered with ISO interact.
