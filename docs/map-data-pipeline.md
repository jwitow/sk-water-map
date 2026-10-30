# Historical map data pipeline

`scripts/build_map_data.py` turns official ECCC data into the two files the map reads:

- `historical-map/data/conditions.json`: recent readings, same-calendar-date comparisons, station details and published-measurement statuses
- `historical-map/data/comparisons-seasonal-window.json`: seasonal-window comparisons, one set per window (±7 and ±15 days)

All agency parsing and calculation happens in this script. The browser only reads the files.

## Running it

```bash
python scripts/build_map_data.py      # fetch, calculate, write the data files
python scripts/build_map_data.py --self-test   # offline checks of the calculations
```

The first run downloads each station's full HYDAT history (a few minutes). History is cached in `.cache/map-data/` (not committed) for 30 days; pass `--refresh-history` to fetch it again. Network access to `wateroffice.ec.gc.ca` and `api.weather.gc.ca` is required.

## Inputs

| Input | Purpose |
|---|---|
| `pipeline/stations.json` | Static station list: IDs, names, coordinates, watershed context. Edit stations here, not in the generated files. |
| Latest `docs/sensor-inventory-*.json` | Which measurements each station publishes, and from which agency (see the `docs/sensor-inventory-*.json` report). Only measurements confirmed there are fetched. |
| ECCC real-time hydrometric web service | Recent readings: water level (46), discharge (47), water temperature (5), air temperature (1). |
| ECCC HYDAT daily means (GeoMet `hydrometric-daily-mean`) | Approved historical daily mean level and discharge. |

## Method and defaults

These are the defaults agreed for the prototype. They still need hydrologist review before public use.

**Recent statistic**
- Rolling 24 hours ending at the station's latest reading.
- Minimum, time-weighted mean (trapezoidal), and maximum.
- Needs at least 18 hours covered by readings. Gaps longer than 2 hours are not bridged.
- ECCC's 99999 missing-value code and physically implausible values are dropped. Plausible ranges: flow 0 to 20,000 m³/s; water temperature −0.5 to 35 °C; air temperature −50 to 45 °C.

**Freshness**
- `current`: latest reading up to 6 hours old when the script runs.
- `delayed`: 6 to 48 hours old.
- Older than 48 hours: no values and no comparison (`stale`).
- The page applies the same 48-hour rule when it is viewed, using `method.stale_after_hours` from the data: an older reading keeps its values but loses its colour and percentile. If the whole dataset is more than 12 hours old, the page shows a notice at the top. So if refreshes stop, the map says so instead of presenting old ranks as current.
- The page also shows each reading's age at viewing time.

**Historical comparison** (water level and flow only)
- Only the 24-hour mean gets a percentile. HYDAT holds daily means, so a 24-hour minimum or maximum has nothing comparable to rank against; they are shown as plain values.
- Same calendar date: approved daily means on the comparison date in each prior year. February 29 maps to February 28 in non-leap years.
- Seasonal windows: approved daily means from ±7 days (the default) or ±15 days around the comparison date. A year counts if it has data on more than half the window's days: 8 of 15, or 16 of 31. The widths are `WINDOW_HALF_WIDTHS` in the script; the data lists each under `windows` with its `half_width_days` and `min_days_per_year`, and names the default in `default_half_width_days`. Today the two windows rank stations within a few points of each other (on 2026-10-30, a median difference of 1 point and at most 6).
- The current year is excluded from history.
- Percentile: mid-rank empirical percentile (share of history below the value, ties counted as half), rounded to a whole number.
- At least 10 usable years are required. Below that the comparison shows the year count and no percentile.
- Each comparison with a percentile also publishes `history`, so the page can show how big a difference is, not only how unusual:
  - `p25`, `median` and `p75`: the 25th percentile, median and 75th percentile of the same daily means the percentile uses, in the measurement's units (linear interpolation between ranked values). The page shows the median and the "middle half of past values" (25th to 75th percentile).
  - `difference_from_median`: the 24-hour mean minus that median.
  - `years_lower` and `years_higher`: how many usable past years were below or above the 24-hour mean (ties count as neither). Each year contributes one value: its daily mean on the comparison date (same calendar date), or the average of its daily means in the window (seasonal window). The page words this as "Higher than 9 of 10 past years", which shows how short a record is. With the seasonal window it can differ slightly from the percentile, which ranks against every daily mean in the window.
  - `year_values`: those same per-year values as `[year, value]` pairs in year order, rounded like the other values, one per usable year. The page plots them as its chart of past years, so the chart shows exactly what the year count counts. A year without enough data is absent, never zero. Comparisons without a percentile (too few years, or withheld) have no `history`, so no chart.
- A percentile measures how unusual a value is, not how large the difference is. Where a measurement barely varies at this time of year, or the record is short, a small difference can rank high; `history` lets readers judge both.

**Withheld comparisons.** Two checks can withhold a comparison that has enough history. The record count stays; the percentile and `history` are dropped, and `comparison_withheld` and `comparison_note` say why.

| `comparison_withheld` | When | What is withheld |
|---|---|---|
| `ice` | ECCC's ice code (`10`, "ice conditions ... may have caused backwater") appears in a qualifier or grade column on any of the station's level or flow readings in the latest 24 hours. | Both level and flow at that station, for every comparison method. Ice raises water levels and makes flow estimates uncertain. |
| `level_flow_mismatch` | The station has both level and flow, and the level percentile differs from the flow percentile, calculated over the same years, by 25 points or more. `withheld_detail` gives both percentiles. | Level only, for that comparison method. At one station the two should rank similarly; a large gap usually means a datum or channel change that ECCC has corrected in the flow record but not in the level record. |

ECCC applies the ice code to discharge only, so at stations that publish only water level, ice is not detected and winter ranks may read high. ECCC's "estimated" code (`20`) is not used.
- Water level uses only years whose values are on the same datum as today's reading. This is a magnitude check: it catches large datum changes (for example 05JF001 in 2013) but not small ones, so datum histories still need confirming with the Water Survey of Canada.
- All available years are used, including years before dams or regulation changes. Regulated stations need a hydrologist's decision on which years are comparable.

**Temperature**
- Recent values only, with no percentile: no historical temperature archive is available (see the `docs/sensor-inventory-*.json` report).
- The page does not offer temperature yet (2026-10-29). The readings stay in the data so it can return without a pipeline change once a reliable historical source is found.

**Missing data** is never filled in. Each missing measurement carries a reason the page displays:

| Reason | Meaning |
|---|---|
| `not_published` | The station does not publish this measurement (from the inventory). |
| `no_supported_feed` | Published only on WSA's charts, which production cannot use (the 7 WSA-operated stations' flow). |
| `no_recent_data` | Nothing published in the last 72 hours. |
| `incomplete` | Fewer than 18 hours of readings in the latest 24 hours. |
| `stale` | Latest reading more than 48 hours old. |

## Known limitations

- The level-against-flow check and its 25-point threshold are a prototype safeguard, not a reviewed method. Stations near the threshold can change between runs. On 2026-10-28 it withheld level at 05HA003, 05JG004, 05MC001 and 05NB040. An independent check of 05JG004 found a level step of about 0.3 to 0.45 m at the same flow from October 2018, and of 05NB040 a gradual drift of about 13 cm lower since 2025; both need confirming with the Water Survey of Canada.

- The rolling 24-hour mean is compared with historical calendar-day means, a close but not exact match.
- Real-time values are provisional and can be revised; history is approved HYDAT data, which lags by a year or more.
- Record counts are years with data, not yet quality-screened beyond ECCC's approval and the datum check.
- Inventory statuses reflect the date of the last inventory check, not every pipeline run.
