#!/usr/bin/env python3
"""Build the historical map's data files from official ECCC sources.

Reads pipeline/stations.json and the latest docs/sensor-inventory-*.json, fetches recent
real-time readings and HYDAT history, and writes:
  historical-map/data/conditions.json
  historical-map/data/comparisons-seasonal-window.json

All agency parsing and calculation happens here, never in the browser. The method and
defaults are documented in docs/map-data-pipeline.md.

Usage:
  python scripts/build_map_data.py               # fetch, calculate, and write the data files
  python scripts/build_map_data.py --self-test   # offline checks of the calculations (npm test)
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIONS_FILE = ROOT / "pipeline" / "stations.json"
OUT_CONDITIONS = ROOT / "historical-map" / "data" / "conditions.json"
OUT_WINDOW = ROOT / "historical-map" / "data" / "comparisons-seasonal-window.json"
DEFAULT_CACHE = ROOT / ".cache" / "map-data"

REALTIME_URL = "https://wateroffice.ec.gc.ca/services/real_time_data/csv/inline"
HYDAT_URL = (
    "https://api.weather.gc.ca/collections/hydrometric-daily-mean/items?STATION_NUMBER={}"
    "&datetime={}/{}&properties=DATE,LEVEL,DISCHARGE&limit=10000&skipGeometry=true&f=json"
)
USER_AGENT = "giws-water-widgets-map-data/1.0"

# Saskatchewan stays on Central Standard Time (UTC-6) all year.
LOCAL_TZ = timezone(timedelta(hours=-6), "CST")

METRICS = ("level", "flow", "waterTemp", "airTemp")
REALTIME_CODES = {"level": 46, "flow": 47, "waterTemp": 5, "airTemp": 1}
HYDAT_FIELD = {"level": "LEVEL", "flow": "DISCHARGE"}
UNITS = {"level": "m", "flow": "m³/s", "waterTemp": "°C", "airTemp": "°C"}
SOURCES = {
    "level": "ECCC real-time hydrometric data (water level, parameter 46)",
    "flow": "ECCC real-time hydrometric data (discharge, parameter 47)",
    "waterTemp": "ECCC real-time hydrometric data (water temperature, parameter 5)",
    "airTemp": "ECCC real-time hydrometric data (air temperature, parameter 1)",
}
# Values outside these ranges are treated as sensor errors and dropped.
PLAUSIBLE = {"level": (-100.0, 5000.0), "flow": (0.0, 20000.0), "waterTemp": (-0.5, 35.0), "airTemp": (-50.0, 45.0)}
MISSING_VALUE = 99999.0  # ECCC's in-data code for "no value"

FETCH_HOURS = 72
WINDOW_HOURS = 24
MIN_COVERAGE_HOURS = 18
MAX_GAP_HOURS = 2
CURRENT_MAX_AGE_HOURS = 6
STALE_AFTER_HOURS = 48

HALF_WIDTH_DAYS = 7
MIN_WINDOW_DAYS_PER_YEAR = 8  # of the 15 days in a ±7-day window
MIN_YEARS = 10
DATUM_TOLERANCE_M = 50.0
HYDAT_RANGES = [(f"{y}-01-01", f"{y + 25}-12-31") for y in range(1900, 2040, 26)]
HYDAT_CACHE_DAYS = 30

STATUS_DEFINITIONS = {
    "confirmed": "Published values found for this station and measurement in the last 18 months.",
    "not_published": "Checked; no public data found. The sensor may still exist.",
    "not_available": "The data owner has confirmed the station has no such sensor.",
    "not_assessed": "Not yet checked.",
}


# ---------------------------------------------------------------- fetching

def fetch(url: str, tries: int = 5, timeout: int = 120) -> str:
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries - 1:
                raise
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError("unreachable")


def realtime_url(station: str, codes: list[int], start: datetime, end: datetime) -> str:
    query = [("stations[]", station)] + [("parameters[]", str(c)) for c in codes]
    query += [("start_date", start.strftime("%Y-%m-%d %H:%M:%S")), ("end_date", end.strftime("%Y-%m-%d %H:%M:%S"))]
    return f"{REALTIME_URL}?{urllib.parse.urlencode(query)}"


def parse_realtime(text: str) -> dict[int, list[tuple[datetime, float]]]:
    """Group real-time CSV rows by parameter code, dropping missing-value codes and implausible values."""
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    header = [c.strip() for c in next(reader, [])]
    if not header:
        return {}
    date_i = header.index("Date")
    value_i = next(i for i, n in enumerate(header) if n.startswith("Value"))
    param_i = next(i for i, n in enumerate(header) if n.startswith("Parameter"))
    limits = {REALTIME_CODES[m]: PLAUSIBLE[m] for m in METRICS}
    out: dict[int, list[tuple[datetime, float]]] = {}
    for row in reader:
        if len(row) <= max(date_i, value_i, param_i) or not row[value_i].strip():
            continue
        code, value = int(row[param_i]), float(row[value_i])
        low, high = limits.get(code, (float("-inf"), float("inf")))
        if value >= MISSING_VALUE or not low <= value <= high:
            continue
        stamp = datetime.fromisoformat(row[date_i].strip().replace("Z", "+00:00"))
        out.setdefault(code, []).append((stamp, value))
    for points in out.values():
        points.sort()
    return out


def hydat_daily(station: str, cache_dir: Path, refresh: bool) -> dict[date, dict]:
    """Approved HYDAT daily means for a station, cached locally."""
    cache = cache_dir / "hydat" / f"{station}.json"
    if cache.exists() and not refresh:
        cached = json.loads(cache.read_text(encoding="utf-8"))
        age = datetime.now(timezone.utc) - datetime.fromisoformat(cached["fetched_at"])
        if age < timedelta(days=HYDAT_CACHE_DAYS):
            return {date.fromisoformat(r["DATE"]): r for r in cached["rows"]}
    rows = []
    for start, end in HYDAT_RANGES:
        data = json.loads(fetch(HYDAT_URL.format(station, start, end)))
        if data.get("numberReturned") != data.get("numberMatched"):
            raise ValueError(f"HYDAT response for {station} {start} was truncated")
        rows += [f["properties"] for f in data["features"]]
        time.sleep(0.3)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"fetched_at": datetime.now(timezone.utc).isoformat(), "rows": rows}), encoding="utf-8")
    return {date.fromisoformat(r["DATE"]): r for r in rows}


# ---------------------------------------------------------------- calculations

def recent_stats(points: list[tuple[datetime, float]], now: datetime) -> dict:
    """Rolling 24-hour min, time-weighted mean and max ending at the latest reading.

    Returns {"reason": ...} when the record is stale or incomplete.
    """
    if not points:
        return {"reason": "no_recent_data"}
    latest = points[-1][0]
    age_hours = (now - latest).total_seconds() / 3600
    if age_hours > STALE_AFTER_HOURS:
        return {"reason": "stale", "last_observed": latest.isoformat()}
    start = latest - timedelta(hours=WINDOW_HOURS)
    window = [(t, v) for t, v in points if t >= start]
    covered, integral = 0.0, 0.0
    for (t0, v0), (t1, v1) in zip(window, window[1:]):
        gap = (t1 - t0).total_seconds() / 3600
        if 0 < gap <= MAX_GAP_HOURS:
            covered += gap
            integral += gap * (v0 + v1) / 2
    if covered < MIN_COVERAGE_HOURS:
        return {"reason": "incomplete", "last_observed": latest.isoformat()}
    values = [v for _, v in window]
    return {
        "min": min(values),
        "mean": integral / covered,
        "max": max(values),
        "window_start": start.isoformat(),
        "window_end": latest.isoformat(),
        "covered_hours": round(covered, 1),
        "freshness": "current" if age_hours <= CURRENT_MAX_AGE_HOURS else "delayed",
    }


def empirical_percentile(value: float, sample: list[float]) -> int:
    """Mid-rank empirical percentile: share of the sample below the value, counting ties as half."""
    below = sum(1 for x in sample if x < value)
    equal = sum(1 for x in sample if x == value)
    return max(0, min(100, int(100 * (below + 0.5 * equal) / len(sample) + 0.5)))


def same_day(year: int, month: int, day: int) -> date:
    try:
        return date(year, month, day)
    except ValueError:  # February 29 in a non-leap year
        return date(year, month, day - 1)


def history_samples(daily: dict[date, float], target: date) -> dict:
    """Historical samples for both comparison methods, excluding the target's own year.

    "values" is the pool the percentile and the median are taken from. "year_values" holds one
    value per usable year for the plain-language rank: that day's mean (same date), or the mean
    of the year's daily means in the window (seasonal window).
    """
    years = sorted({d.year for d in daily if d.year < target.year})
    same_values, window_values, window_year_means = [], [], []
    for year in years:
        centre = same_day(year, target.month, target.day)
        if centre in daily:
            same_values.append(daily[centre])
        days = [centre + timedelta(days=k) for k in range(-HALF_WIDTH_DAYS, HALF_WIDTH_DAYS + 1)]
        present = [daily[d] for d in days if d in daily]
        if len(present) >= MIN_WINDOW_DAYS_PER_YEAR:
            window_values += present
            window_year_means.append(sum(present) / len(present))
    return {
        "same_date": {"years": len(same_values), "values": same_values, "year_values": same_values},
        "seasonal_window": {"years": len(window_year_means), "values": window_values, "year_values": window_year_means},
    }


def consistent_datum(daily: dict[date, float], reference: float) -> dict[date, float]:
    """Keep only years whose median level is on the same datum as today's reading (magnitude check)."""
    by_year: dict[int, list[float]] = {}
    for d, v in daily.items():
        by_year.setdefault(d.year, []).append(v)
    keep = {y for y, vs in by_year.items() if abs(sorted(vs)[len(vs) // 2] - reference) < DATUM_TOLERANCE_M}
    return {d: v for d, v in daily.items() if d.year in keep}


def history_summary(sample: dict, value: float, metric: str) -> dict:
    """Past values in the measurement's units, so the page can show how big a difference is.

    The 25th percentile, median and 75th percentile come from the same pool as the percentile.
    years_lower and years_higher count past years below and above the 24-hour mean (ties count
    as neither).
    """
    p25, median, p75 = statistics.quantiles(sample["values"], n=4, method="inclusive")
    return {
        "p25": round_value(metric, p25),
        "median": round_value(metric, median),
        "p75": round_value(metric, p75),
        "difference_from_median": round_value(metric, value - median),
        "years_lower": sum(1 for v in sample["year_values"] if v < value),
        "years_higher": sum(1 for v in sample["year_values"] if v > value),
    }


def comparison(sample: dict, value: float, metric: str) -> dict:
    if sample["years"] < MIN_YEARS:
        return {
            "usable_years": sample["years"],
            "percentiles": None,
            "history": None,
            "comparison_note": f"At least {MIN_YEARS} years needed for a percentile",
        }
    return {
        "usable_years": sample["years"],
        "percentiles": {"min": None, "mean": empirical_percentile(value, sample["values"]), "max": None},
        "history": history_summary(sample, value, metric),
    }


def round_value(metric: str, value: float) -> float:
    if metric == "level":
        return round(value, 3)
    if metric == "flow":
        size = abs(value)  # differences from the median can be negative
        return round(value, 1 if size >= 10 else 2 if size >= 1 else 3)
    return round(value, 1)


# ---------------------------------------------------------------- assembly

def latest_inventory() -> tuple[Path, dict]:
    reports = sorted((ROOT / "docs").glob("sensor-inventory-*.json"))
    if not reports:
        raise FileNotFoundError("No docs/sensor-inventory-*.json report found; run scripts/check_sensor_inventory.py")
    return reports[-1], json.loads(reports[-1].read_text(encoding="utf-8"))


def build(cache_dir: Path, refresh_history: bool, now: datetime | None = None) -> tuple[dict, dict]:
    now = now or datetime.now(timezone.utc).replace(microsecond=0)
    target = now.astimezone(LOCAL_TZ).date()
    inventory_path, inventory = latest_inventory()
    stations_doc = json.loads(STATIONS_FILE.read_text(encoding="utf-8"))

    out_stations, window_stations = [], {}
    for base in stations_doc["stations"]:
        sid = base["id"]
        statuses = {m: inventory["stations"][sid]["proposed_status"][m] for m in METRICS}
        wanted = [m for m in METRICS if statuses[m]["status"] == "confirmed" and statuses[m]["source"].startswith("ECCC")]
        series = {}
        if wanted:
            url = realtime_url(sid, [REALTIME_CODES[m] for m in wanted], now - timedelta(hours=FETCH_HOURS), now)
            series = parse_realtime(fetch(url))
            time.sleep(0.5)
        daily = None
        metrics, unavailable, window_entry = {}, {}, {}
        for metric in METRICS:
            status = statuses[metric]
            if status["status"] != "confirmed":
                metrics[metric] = None
                unavailable[metric] = {"reason": "not_published"}
                continue
            if metric not in wanted:
                metrics[metric] = None
                unavailable[metric] = {"reason": "no_supported_feed"}
                continue
            stats = recent_stats(series.get(REALTIME_CODES[metric], []), now)
            if "reason" in stats:
                metrics[metric] = None
                unavailable[metric] = {"reason": stats["reason"], "last_observed": stats.get("last_observed") or status.get("last_published")}
                continue
            record = {
                "unit": UNITS[metric],
                "recent": {k: round_value(metric, stats[k]) for k in ("min", "mean", "max")},
                "window_start": stats["window_start"],
                "window_end": stats["window_end"],
                "covered_hours": stats["covered_hours"],
                "freshness": stats["freshness"],
                "quality": "provisional",
                "source": SOURCES[metric],
                "usable_years": None,
                "percentiles": None,
                "history": None,
            }
            if metric in HYDAT_FIELD:
                if daily is None:
                    daily = hydat_daily(sid, cache_dir, refresh_history)
                values = {d: r[HYDAT_FIELD[metric]] for d, r in daily.items() if r[HYDAT_FIELD[metric]] is not None}
                if metric == "level":
                    values = consistent_datum(values, stats["mean"])
                samples = history_samples(values, target)
                same = comparison(samples["same_date"], stats["mean"], metric)
                record.update(same)
                window_entry[metric] = comparison(samples["seasonal_window"], stats["mean"], metric)
            else:
                record["comparison_note"] = "No historical temperature record is available."
            metrics[metric] = record
        out_stations.append({
            **base,
            "quality_note": "Provisional real-time data from ECCC, subject to revision. Historical comparison uses approved HYDAT daily means.",
            "metrics": metrics,
            "unavailable": unavailable,
            "sensor_availability": statuses,
        })
        if window_entry:
            window_stations[sid] = window_entry
        print(sid, {m: ("ok" if metrics[m] else unavailable[m]["reason"]) for m in METRICS}, flush=True)

    temperature_note = (
        "No historical comparison for water or air temperature: HYDAT holds no temperature for these stations "
        "and ECCC's real-time service keeps only 18 months. Recent values are shown without a percentile."
    )
    conditions = {
        "schema_version": "0.8",
        "generated_at": now.isoformat(),
        "status": "provisional",
        "comparison_date": target.isoformat(),
        "default_station": stations_doc["default_station"],
        "reference_method": {
            "mode": "same_calendar_date",
            "note": "The recent rolling 24-hour mean is ranked against approved HYDAT daily means on the same calendar date in each prior year.",
        },
        "method": {
            "description": "docs/map-data-pipeline.md",
            "recent_window_hours": WINDOW_HOURS,
            "min_coverage_hours": MIN_COVERAGE_HOURS,
            "max_gap_hours": MAX_GAP_HOURS,
            "current_max_age_hours": CURRENT_MAX_AGE_HOURS,
            "stale_after_hours": STALE_AFTER_HOURS,
            "min_years": MIN_YEARS,
            "percentile": "mid-rank empirical percentile of the 24-hour mean; minimum and maximum have no percentile",
            "history": (
                "p25, median and p75 of the same historical daily means the percentile uses, in the measurement's units; "
                "difference_from_median is the 24-hour mean minus that median; years_lower and years_higher count usable past "
                "years whose value is below or above the 24-hour mean (same date: that day's mean; seasonal window: the mean "
                "of the year's daily means in the window)"
            ),
        },
        "station_inventory_note": stations_doc["station_inventory_note"],
        "omitted_candidate_stations": stations_doc["omitted_candidate_stations"],
        "sensor_inventory": {
            "checked": inventory["checked_at"][:10],
            "method": "docs/sensor-inventory.md",
            "report": f"docs/{inventory_path.name}",
            "statuses": STATUS_DEFINITIONS,
        },
        "history_notes": {
            "level_and_flow": (
                "usable_years counts prior years with an approved HYDAT daily mean on the comparison date (same date) "
                f"or on at least {MIN_WINDOW_DAYS_PER_YEAR} of the {2 * HALF_WIDTH_DAYS + 1} window days (seasonal window); "
                f"water level counts only years on the same datum as today's reading. At least {MIN_YEARS} years are required for a percentile."
            ),
            "temperature": temperature_note,
        },
        "stations": out_stations,
    }
    window = {
        "schema_version": "0.7",
        "comparison_date": target.isoformat(),
        "method": {
            "mode": "day_of_year_window",
            "half_width_days": HALF_WIDTH_DAYS,
            "note": "Compare the 24-hour mean with approved HYDAT daily means from every day within half_width_days of the comparison date (a window of 2 × half_width_days + 1 days) across prior years.",
        },
        "temperature_note": temperature_note,
        "stations": window_stations,
    }
    return conditions, window


# ---------------------------------------------------------------- self-test

def self_test() -> None:
    utc = timezone.utc
    t0 = datetime(2026, 10, 26, 0, tzinfo=utc)
    hourly = [(t0 + timedelta(hours=h), float(h)) for h in range(25)]
    stats = recent_stats(hourly, t0 + timedelta(hours=25))
    assert abs(stats["mean"] - 12.0) < 1e-9 and stats["min"] == 0 and stats["max"] == 24, stats
    assert stats["freshness"] == "current" and stats["covered_hours"] == 24

    # Irregular sampling is time-weighted, not count-weighted.
    irregular = [(t0, 0.0), (t0 + timedelta(minutes=5), 0.0), (t0 + timedelta(minutes=10), 0.0)]
    irregular += [(t0 + timedelta(hours=h), 10.0) for h in range(1, 25)]
    weighted = recent_stats(irregular, t0 + timedelta(hours=24))
    assert 9.7 < weighted["mean"] < 9.9, weighted

    # Gaps longer than MAX_GAP_HOURS are not bridged, so a sparse day is incomplete.
    sparse = [(t0 + timedelta(hours=h), 1.0) for h in range(0, 25, 3)]
    assert recent_stats(sparse, t0 + timedelta(hours=24))["reason"] == "incomplete"
    assert recent_stats(hourly, t0 + timedelta(hours=24 + 49))["reason"] == "stale"
    assert recent_stats(hourly, t0 + timedelta(hours=24 + 10))["freshness"] == "delayed"
    assert recent_stats([], t0)["reason"] == "no_recent_data"

    assert empirical_percentile(5, [1, 2, 3, 4]) == 100
    assert empirical_percentile(0, [1, 2, 3, 4]) == 0
    assert empirical_percentile(2.5, [1, 2, 3, 4]) == 50
    assert empirical_percentile(2, [1, 2, 3, 4]) == 38  # (1 + 0.5) / 4

    assert same_day(2023, 2, 29) == date(2023, 2, 28)

    daily = {}
    for year in range(2000, 2026):
        for k in range(-7, 8):
            if year == 2005 and k > -2:
                continue  # only 6 days in 2005: not a usable window year
            daily[date(year, 10, 26) + timedelta(days=k)] = float(year)
    daily[date(2026, 10, 20)] = 999.0  # the target year itself is excluded
    samples = history_samples(daily, date(2026, 10, 26))
    assert samples["same_date"]["years"] == 25, samples["same_date"]["years"]  # 2005 lacks Oct 26
    assert samples["seasonal_window"]["years"] == 25
    assert 999.0 not in samples["seasonal_window"]["values"]

    shifted = {date(2010, 1, 1): 3.2, date(2010, 6, 1): 3.4, date(2015, 1, 1): 491.0, date(2015, 6, 1): 491.2}
    assert set(consistent_datum(shifted, 491.1)) == {date(2015, 1, 1), date(2015, 6, 1)}

    short = comparison({"years": 6, "values": [1.0] * 6, "year_values": [1.0] * 6}, 1.0, "level")
    assert short["percentiles"] is None and short["history"] is None and "At least" in short["comparison_note"]

    # History in units and the per-year counts behind "higher than N of M past years".
    pool = [float(v) for v in range(1, 13)]  # one value per year, 12 years
    ranked = comparison({"years": 12, "values": pool, "year_values": pool}, 10.5, "level")
    history = ranked["history"]
    assert (history["p25"], history["median"], history["p75"]) == (3.75, 6.5, 9.25), history
    assert history["difference_from_median"] == 4.0
    assert (history["years_lower"], history["years_higher"]) == (10, 2), history
    assert ranked["percentiles"]["mean"] == 83  # 10 of 12 below

    # The seasonal window ranks against each year's window mean, not single days.
    window_daily = {}
    for year in range(2010, 2022):
        for k in range(-7, 8):
            window_daily[date(year, 10, 26) + timedelta(days=k)] = year + k / 100
    window_sample = history_samples(window_daily, date(2026, 10, 26))["seasonal_window"]
    assert window_sample["years"] == 12 and len(window_sample["values"]) == 12 * 15
    assert [round(v, 6) for v in window_sample["year_values"]] == [float(y) for y in range(2010, 2022)]
    tied = history_summary(window_sample, 2015.0, "level")
    assert (tied["years_lower"], tied["years_higher"]) == (5, 6), tied  # 2015 itself ties

    assert round_value("flow", -12.345) == -12.3 and round_value("flow", -0.0456) == -0.046

    csv_text = (
        "﻿ ID,Date,Parameter/Paramètre,Value/Valeur,Qualifier/Qualificatif,Symbol/Symbole,Approval/Approbation,Grade/Classification,Qualifiers/Qualificatifs\n"
        "05HG001,2026-10-26T01:00:00Z,1,99999,,,Provisional/Provisoire,,\n"
        "05HG001,2026-10-26T00:00:00Z,1,46.9,,,Provisional/Provisoire,,\n"
        "05HG001,2026-10-26T02:00:00Z,1,3.5,,,Provisional/Provisoire,,\n"
        "05HG001,2026-10-26T00:00:00Z,46,2.21,,,Provisional/Provisoire,,\n"
    )
    parsed = parse_realtime(csv_text)
    assert [v for _, v in parsed[1]] == [3.5], parsed  # missing-value code and implausible spike dropped
    assert parsed[46][0][1] == 2.21
    print("Map data pipeline self-test passed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--self-test", action="store_true", help="Run offline checks of the calculations")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--refresh-history", action="store_true", help="Ignore cached HYDAT history")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    conditions, window = build(args.cache_dir, args.refresh_history)
    OUT_CONDITIONS.write_text(json.dumps(conditions, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    OUT_WINDOW.write_text(json.dumps(window, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT_CONDITIONS.relative_to(ROOT)} and {OUT_WINDOW.relative_to(ROOT)} for {conditions['comparison_date']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
