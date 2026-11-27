# Parallel Coordinates

Explore eight measurements from red and white vinho verde wines in northern Portugal. Every row passes through eight vertical axes. A 229 × 124 density grid counts every row along its path across the axes. Brightness shows the relative density within the current selection. The unselected distribution stays visible in subdued colors. The linked scatter plot places the same samples by alcohol and residual sugar. Coral marks represent red wines and gold marks represent white wines. The scatter uses a 120 × 100 raster. Samples that occupy the same cell share a mark, with color blended by their red-to-white ratio. Brushing a range highlights matching rows in both plots and updates the counts.

Drag upward or downward along an axis, or enter an inclusive range below the chart. Brushes on different axes intersect. **All wines** clears the selection. The two example brushes select samples with at least 10 g/L of residual sugar or at least 12% alcohol. Of the 1,222 observations with at least 10 g/L of residual sugar, 1,211 are white and 11 are red. These counts describe the source samples.

The chart displays all 6,497 records with seven physicochemical measurements and the tasting score. The data packet preserves the selected source values and each observation's original red or white label. Sugar, volatile acidity and sulphates use logarithmic scales on the parallel axes. The scatter plot uses a logarithmic sugar axis and a linear alcohol axis. Fixed and volatile acidity are reported as tartaric acid and acetic acid equivalents, respectively, as described by the investigators.

## Sources

- Paulo Cortez, António Cerdeira, Fernando Almeida, Telmo Matos and José Reis. *Wine Quality* (2009), UCI Machine Learning Repository. The dataset is available under CC BY 4.0. [Dataset and license](https://doi.org/10.24432/C56S3T), [Source archive](https://archive.ics.uci.edu/static/public/186/wine+quality.zip).
- Paulo Cortez, António Cerdeira, Fernando Almeida, Telmo Matos and José Reis. *Modeling wine preferences by data mining from physicochemical properties* (2009). [Paper](https://www.sciencedirect.com/science/article/pii/S0167923609001377).
- Alfred Inselberg. *The plane with parallel coordinates* (1985). [Paper](https://doi.org/10.1007/BF01898350).
- Richard A. Becker and William S. Cleveland. *Brushing Scatterplots* (1987). [Paper](https://doi.org/10.1080/00401706.1987.10488204).

The input archive SHA-256 is `3ed56667f4b828242bd732d7d1dd7f2861e54432239d7fa63877014cbb0304d4`. To rebuild the packed data, save the UCI archive as `uci-wine.zip` and run `python tools/extract-wine.py uci-wine.zip assets/vinho-verde.deflate`.
