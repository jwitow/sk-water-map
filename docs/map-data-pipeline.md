# Historical map data pipeline

`scripts/build_map_data.py` turns official ECCC data into the two files the map reads:

- `historical-map/data/conditions.json`: recent readings, same-calendar-date comparisons, station details and published-measurement statuses
- `historical-map/data/comparisons-seasonal-window.json`: ±7-day seasonal-window comparisons

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
- The page also shows each reading's age at viewing time, so a saved copy never presents an old reading as current.

**Historical comparison** (water level and flow only)
- Only the 24-hour mean gets a percentile. HYDAT holds daily means, so a 24-hour minimum or maximum has nothing comparable to rank against; they are shown as plain values.
- Same calendar date: approved daily means on the comparison date in each prior year. February 29 maps to February 28 in non-leap years.
- Seasonal window (the default): approved daily means from ±7 days around the comparison date. A year counts if it has at least 8 of the 15 days.
- The current year is excluded from history.
- Percentile: mid-rank empirical percentile (share of history below the value, ties counted as half), rounded to a whole number.
- At least 10 usable years are required. Below that the comparison shows the year count and no percentile.
- Each comparison with a percentile also publishes `history`, so the page can show how big a difference is, not only how unusual:
  - `p25`, `median` and `p75`: the 25th percentile, median and 75th percentile of the same daily means the percentile uses, in the measurement's units (linear interpolation between ranked values). The page shows the median and the "middle half of past values" (25th to 75th percentile).
  - `difference_from_median`: the 24-hour mean minus that median.
  - `years_lower` and `years_higher`: how many usable past years were below or above the 24-hour mean (ties count as neither). Each year contributes one value: its daily mean on the comparison date (same calendar date), or the average of its daily means in the window (seasonal window). The page words this as "Higher than 9 of 10 past years", which shows how short a record is. With the seasonal window it can differ slightly from the percentile, which ranks against every daily mean in the window.
- A percentile measures how unusual a value is, not how large the difference is. Where a measurement barely varies at this time of year, or the record is short, a small difference can rank high; `history` lets readers judge both.
- Water level uses only years whose values are on the same datum as today's reading. This is a magnitude check: it catches large datum changes (for example 05JF001 in 2013) but not small ones, so datum histories still need confirming with the Water Survey of Canada.
- All available years are used, including years before dams or regulation changes. Regulated stations need a hydrologist's decision on which years are comparable.

**Temperature**
- Recent values only, with no percentile: no historical temperature archive is available (see the `docs/sensor-inventory-*.json` report).

**Missing data** is never filled in. Each missing measurement carries a reason the page displays:

| Reason | Meaning |
|---|---|
| `not_published` | The station does not publish this measurement (from the inventory). |
| `no_supported_feed` | Published only on WSA's charts, which production cannot use (the 7 WSA-operated stations' flow). |
| `no_recent_data` | Nothing published in the last 72 hours. |
| `incomplete` | Fewer than 18 hours of readings in the latest 24 hours. |
| `stale` | Latest reading more than 48 hours old. |

## Known limitations

- The rolling 24-hour mean is compared with historical calendar-day means, a close but not exact match.
- Real-time values are provisional and can be revised; history is approved HYDAT data, which lags by a year or more.
- Record counts are years with data, not yet quality-screened beyond ECCC's approval and the datum check.
- Inventory statuses reflect the date of the last inventory check, not every pipeline run.
