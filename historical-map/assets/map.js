const DATA_URL = "./data/conditions.json";
const WINDOW_DATA_URL = "./data/comparisons-seasonal-window.json";
const WATERSHED_URL = "./data/watersheds.geojson";
const BOUNDARY_URL = "./data/saskatchewan-boundary.geojson";
const SEASONAL_WINDOW = "seasonal_window";
// Percentiles are calculated for the 24-hour mean only; the archive holds daily means.
const STAT = "mean";
const LOCAL_TIME_ZONE = "America/Regina";
const missingReasonLabels = {
  stale: "Reading is stale",
  incomplete: "Incomplete 24-hour record",
  no_supported_feed: "No supported data feed",
  not_published: "Not published",
  no_recent_data: "No recent data",
};

const metricLabels = {
  level: "water level",
  flow: "flow",
  waterTemp: "water temperature",
  airTemp: "air temperature",
};
const statLabels = {
  min: "24-hour minimum",
  mean: "24-hour mean",
  max: "24-hour maximum",
};
const sensorStatusLabels = {
  confirmed: { label: "Confirmed", className: "yes" },
  not_published: { label: "None published", className: "no" },
  not_available: { label: "Not available", className: "no" },
  not_assessed: { label: "Not assessed", className: "no" },
};
const percentileClasses = [
  { max: 9, label: "Very low", css: "var(--p-lowest)" },
  { max: 24, label: "Low", css: "var(--p-low)" },
  { max: 49, label: "Below typical", css: "var(--p-below)" },
  { max: 74, label: "Above typical", css: "var(--p-above)" },
  { max: 90, label: "High", css: "var(--p-high)" },
  { max: 100, label: "Extreme high", css: "var(--p-extreme)" },
];

const els = {
  metric: document.querySelector("#metric"),
  comparisonMethod: document.querySelector("#comparison-method"),
  seasonalWindowOption: document.querySelector(`#comparison-method option[value="${SEASONAL_WINDOW}"]`),
  methodComparison: document.querySelector("#method-comparison"),
  stationSelect: document.querySelector("#station-select"),
  definition: document.querySelector("#definition"),
  mapTitle: document.querySelector("#map-title"),
  coverageSummary: document.querySelector("#coverage-summary"),
  provinceLayer: document.querySelector("#province-layer"),
  watershedLayer: document.querySelector("#watershed-layer"),
  stationLayer: document.querySelector("#station-layer"),
  stationCode: document.querySelector("#station-code"),
  stationName: document.querySelector("#station-name"),
  statusDot: document.querySelector("#status-dot"),
  statusLabel: document.querySelector("#status-label"),
  statusContext: document.querySelector("#status-context"),
  percentile: document.querySelector("#percentile"),
  marker: document.querySelector("#marker"),
  watershedName: document.querySelector("#watershed-name"),
  reportingArea: document.querySelector("#reporting-area"),
  coordinates: document.querySelector("#coordinates"),
  comparison: document.querySelector("#comparison"),
  comparisonDate: document.querySelector("#comparison-date"),
  quality: document.querySelector("#quality"),
  observed: document.querySelector("#observed"),
  source: document.querySelector("#source"),
  dataRetrieved: document.querySelector("#data-retrieved"),
  dataChip: document.querySelector("#data-chip"),
  values: [
    document.querySelector("#value-min"),
    document.querySelector("#value-mean"),
    document.querySelector("#value-max"),
  ],
  availabilityNote: document.querySelector("#availability-note"),
  sensors: {
    level: document.querySelector("#sensor-level"),
    flow: document.querySelector("#sensor-flow"),
    waterTemp: document.querySelector("#sensor-water"),
    airTemp: document.querySelector("#sensor-air"),
  },
  sensorDetails: {
    level: document.querySelector("#sensor-level-detail"),
    flow: document.querySelector("#sensor-flow-detail"),
    waterTemp: document.querySelector("#sensor-water-detail"),
    airTemp: document.querySelector("#sensor-air-detail"),
  },
};

let appData;
let windowComparisonData;
let watershedData;
let boundaryData;
let selectedStationId;
let projection;

function readEmbeddedJson(id) {
  const element = document.querySelector(`#${id}`);
  return element ? JSON.parse(element.textContent) : null;
}

async function loadJson(url, embeddedId) {
  const embedded = readEmbeddedJson(embeddedId);
  if (embedded) return embedded;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`);
  return response.json();
}

function category(percentile) {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) return null;
  return percentileClasses.find((item) => percentile <= item.max) ?? null;
}

function stationMetric(station, metric) {
  return station.metrics?.[metric] ?? null;
}

function comparisonRecord(station, metric) {
  const data = stationMetric(station, metric);
  if (!data) return null;
  if (usingSeasonalWindow()) {
    return windowComparisonData?.stations?.[station.id]?.[metric] ?? null;
  }
  return { usable_years: data.usable_years, percentiles: data.percentiles, comparison_note: data.comparison_note };
}

function percentileFor(station, metric, stat) {
  const percentile = comparisonRecord(station, metric)?.percentiles?.[stat];
  return Number.isFinite(percentile) && percentile >= 0 && percentile <= 100 ? percentile : null;
}

function formatValue(value, unit) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  let decimals = unit === "m" ? 2 : 1;
  if (unit === "m³/s") decimals = number >= 100 ? 0 : number >= 10 ? 1 : 2;
  return `${number.toFixed(decimals)} ${unit}`;
}

function formatCoordinate(latitude, longitude) {
  const ns = latitude >= 0 ? "N" : "S";
  const ew = longitude >= 0 ? "E" : "W";
  return `${Math.abs(latitude).toFixed(4)}° ${ns}, ${Math.abs(longitude).toFixed(4)}° ${ew}`;
}

function comparisonDateValue() {
  return appData.comparison_date ?? windowComparisonData?.comparison_date ?? String(appData.generated_at).slice(0, 10);
}

function formatComparisonDate(isoDate) {
  if (!isoDate) return "Same calendar date";
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("en-CA", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatFullDate(isoDate) {
  const [year, month, day] = String(isoDate).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatDateTime(isoTimestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: LOCAL_TIME_ZONE,
    timeZoneName: "short",
  }).format(new Date(isoTimestamp));
}

// Age at viewing time, so a saved or cached page never presents an old reading as current.
function formatAge(isoTimestamp) {
  const hours = (Date.now() - new Date(isoTimestamp).getTime()) / 3600000;
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${Math.round(hours)} ${Math.round(hours) === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function shiftComparisonDate(isoDate, dayOffset) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function usingSeasonalWindow() {
  return els.comparisonMethod.value === SEASONAL_WINDOW;
}

// The window size lives only in the data, as days either side of the comparison date.
function windowHalfWidthDays() {
  const days = windowComparisonData?.method?.half_width_days;
  return Number.isInteger(days) && days > 0 ? days : null;
}

function windowRange(days) {
  const date = comparisonDateValue();
  return {
    start: formatComparisonDate(shiftComparisonDate(date, -days)),
    end: formatComparisonDate(shiftComparisonDate(date, days)),
  };
}

function comparisonContextText() {
  const date = formatComparisonDate(comparisonDateValue());
  if (usingSeasonalWindow()) {
    const days = windowHalfWidthDays();
    const { start, end } = windowRange(days);
    return `±${days}-day window: ${start}–${end}`;
  }
  return `Same calendar date: ${date}`;
}

function comparisonDefinitionText() {
  const date = formatComparisonDate(comparisonDateValue());
  if (usingSeasonalWindow()) {
    const days = windowHalfWidthDays();
    const { start, end } = windowRange(days);
    return `Historical context pools daily means from ±${days} days around ${date} in each usable year (${start}–${end}).`;
  }
  return `Historical context uses only the same calendar date in each usable year (${date}).`;
}

// Fill in the comparison wording that depends on the data's date and window size.
function applyComparisonCopy() {
  const date = formatComparisonDate(comparisonDateValue());
  const days = windowHalfWidthDays();
  const sameDate =
    `The user can choose between two precomputed historical distributions: <strong>same calendar date</strong> ` +
    `(for example, ${date} compared only with prior ${date} values)`;

  if (days === null) {
    els.seasonalWindowOption.disabled = true;
    els.seasonalWindowOption.textContent = "Seasonal window (unavailable)";
    els.methodComparison.innerHTML =
      `${sameDate} or a <strong>seasonal window around that date</strong>, which is unavailable because this dataset does not define its width.`;
    return;
  }

  const { start, end } = windowRange(days);
  els.seasonalWindowOption.disabled = false;
  els.seasonalWindowOption.textContent = `±${days} days around date`;
  els.methodComparison.innerHTML =
    `${sameDate} or <strong>±${days} days around that date</strong>, the default ` +
    `(daily means from ${start} through ${end} across usable historical years).`;
}

function rawMercator([longitude, latitude]) {
  const lambda = (longitude * Math.PI) / 180;
  const clampedLatitude = Math.max(-85, Math.min(85, latitude));
  const phi = (clampedLatitude * Math.PI) / 180;
  return [lambda, Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

function visitCoordinates(coordinates, callback) {
  if (typeof coordinates?.[0] === "number") {
    callback(coordinates);
    return;
  }
  coordinates.forEach((child) => visitCoordinates(child, callback));
}

function makeProjection(features) {
  const projected = [];
  features.forEach((feature) => {
    visitCoordinates(feature.geometry.coordinates, (coordinate) => {
      projected.push(rawMercator(coordinate));
    });
  });

  const xs = projected.map((point) => point[0]);
  const ys = projected.map((point) => point[1]);
  const bounds = {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };

  const width = 700;
  const height = 780;
  const padding = 34;
  const dataWidth = bounds.maxX - bounds.minX;
  const dataHeight = bounds.maxY - bounds.minY;
  const scale = Math.min(
    (width - padding * 2) / dataWidth,
    (height - padding * 2) / dataHeight,
  );
  const drawnWidth = dataWidth * scale;
  const drawnHeight = dataHeight * scale;
  const left = (width - drawnWidth) / 2;
  const top = (height - drawnHeight) / 2;

  return (coordinate) => {
    const [x, y] = rawMercator(coordinate);
    return [
      left + (x - bounds.minX) * scale,
      top + (bounds.maxY - y) * scale,
    ];
  };
}

function ringPath(ring) {
  return `${ring
    .map((point, index) => {
      const [x, y] = projection(point);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join("")} Z`;
}

function geometryPath(geometry) {
  if (geometry.type === "Polygon") {
    return geometry.coordinates.map(ringPath).join(" ");
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .flatMap((polygon) => polygon.map(ringPath))
      .join(" ");
  }
  throw new Error(`Unsupported geometry type: ${geometry.type}`);
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value));
  });
  return element;
}

function buildGeography() {
  projection = makeProjection(boundaryData.features);
  els.provinceLayer.innerHTML = "";
  els.watershedLayer.innerHTML = "";

  boundaryData.features.forEach((feature) => {
    const path = createSvgElement("path", {
      class: "province",
      d: geometryPath(feature.geometry),
      "fill-rule": "evenodd",
    });
    const title = createSvgElement("title");
    title.textContent = feature.properties?.name ?? "Saskatchewan";
    path.append(title);
    els.provinceLayer.append(path);
  });

  watershedData.features.forEach((feature) => {
    const path = createSvgElement("path", {
      class: "watershed",
      d: geometryPath(feature.geometry),
      "fill-rule": "evenodd",
      "data-watershed-number": feature.properties.number,
      "aria-hidden": "true",
    });
    const title = createSvgElement("title");
    title.textContent = `${feature.properties.name} watershed`;
    path.append(title);
    els.watershedLayer.append(path);
  });
}

function populateStationSelect() {
  els.stationSelect.innerHTML = appData.stations
    .map(
      (station) =>
        `<option value="${station.id}">${station.id} · ${station.name}</option>`,
    )
    .join("");
  els.stationSelect.value = selectedStationId;
}

function isIllustrative() {
  return appData.status === "illustrative_conditions";
}

// Sensor inventory record for one measurement. Older data stored a bare status string.
function sensorEntry(station, metric) {
  const raw = station.sensor_availability?.[metric];
  const entry = typeof raw === "string" ? { status: raw } : raw;
  return entry && sensorStatusLabels[entry.status] ? entry : { status: "not_assessed" };
}

function sensorDetailText(entry) {
  if (entry.status === "confirmed" && entry.last_published) {
    return `Last published ${formatFullDate(entry.last_published)}`;
  }
  return entry.status === "not_assessed" ? "" : (entry.note ?? "");
}

function availabilityNoteText() {
  const checked = appData.sensor_inventory?.checked;
  if (!checked) {
    return "Sensor/channel availability has not been checked yet. In this concept, neither a mock value nor a dotted no-data point shows whether a station has a sensor.";
  }
  return (
    `Checked ${formatFullDate(checked)} against published ECCC and WSA data. “None published” means no public data was found; ` +
    "the sensor may still exist." + (isIllustrative() ? " The map’s mock values do not follow these statuses." : "")
  );
}

// Why a station has no value for this metric. Only the explicit sensor status is
// used; a missing value is never treated as evidence that a sensor is absent.
function missingDataLabel(station, metric) {
  if (sensorEntry(station, metric).status === "not_available") return "No direct sensor data";
  if (isIllustrative()) return "No mock data";
  return missingReasonLabels[station.unavailable?.[metric]?.reason] ?? "No recent data";
}

function observedText(station, metric) {
  const data = stationMetric(station, metric);
  if (data?.window_end) {
    const ageHours = (Date.now() - new Date(data.window_end).getTime()) / 3600000;
    const stale = ageHours > 48 ? " (stale)" : "";
    return `${formatDateTime(data.window_end)}, ${formatAge(data.window_end)}${stale}`;
  }
  const last = station.unavailable?.[metric]?.last_observed;
  if (!last) return "--";
  // A date-only value (from the inventory) must not be shown with an invented time of day.
  return `None in the last 24 hours; last reading ${last.length <= 10 ? formatFullDate(last) : formatDateTime(last)}`;
}

function stationAriaLabel(station) {
  const metric = els.metric.value;
  const stat = STAT;
  const percentile = percentileFor(station, metric, stat);
  if (!stationMetric(station, metric)) {
    return `${station.id}, ${station.name}: ${missingDataLabel(station, metric).toLowerCase()} for ${metricLabels[metric]}`;
  }
  if (percentile === null) {
    return `${station.id}, ${station.name}: no comparable ${metricLabels[metric]} data`;
  }
  return `${station.id}, ${station.name}: ${category(percentile).label}, percentile ${percentile}, ${statLabels[stat]} ${metricLabels[metric]}`;
}

function buildStationLayer() {
  els.stationLayer.innerHTML = "";

  appData.stations.forEach((station) => {
    const [x, y] = projection([station.longitude, station.latitude]);
    const group = createSvgElement("g", {
      class: "station-group",
      "data-station-id": station.id,
      transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})`,
      tabindex: "0",
      role: "button",
      "aria-label": stationAriaLabel(station),
    });
    const halo = createSvgElement("circle", {
      class: "station-halo",
      cx: 0,
      cy: 0,
      r: 10,
      "aria-hidden": "true",
    });
    const dot = createSvgElement("circle", {
      class: "station-dot",
      cx: 0,
      cy: 0,
      r: 6.2,
      "aria-hidden": "true",
    });
    const title = createSvgElement("title");
    title.textContent = `${station.id} — ${station.name}`;

    const activate = () => {
      selectedStationId = station.id;
      els.stationSelect.value = selectedStationId;
      render();
    };
    group.addEventListener("click", activate);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });

    group.append(halo, dot, title);
    els.stationLayer.append(group);
  });
}

function updateStationPoints() {
  const metric = els.metric.value;
  const stat = STAT;
  let comparableCount = 0;
  let recentOnlyCount = 0;

  document.querySelectorAll(".station-group").forEach((group) => {
    const station = appData.stations.find(
      (item) => item.id === group.dataset.stationId,
    );
    const percentile = percentileFor(station, metric, stat);
    const dot = group.querySelector(".station-dot");

    group.classList.toggle("selected", station.id === selectedStationId);
    group.classList.toggle("no-data", percentile === null);
    group.setAttribute("aria-label", stationAriaLabel(station));

    if (percentile === null) {
      dot.style.fill = "var(--p-nodata)";
      if (stationMetric(station, metric)) recentOnlyCount += 1;
    } else {
      comparableCount += 1;
      dot.style.fill = category(percentile).css;
    }
  });

  const coverage =
    `${comparableCount} of ${appData.stations.length} plotted screening stations have comparable ` +
    `${metricLabels[metric]} data`;
  const recentOnly = recentOnlyCount
    ? ` ${recentOnlyCount} ${recentOnlyCount === 1 ? "has" : "have"} recent values but not enough history for a comparison.`
    : "";
  els.coverageSummary.textContent = isIllustrative()
    ? `${coverage} in this illustrative concept.${recentOnly} A dotted point means the station does not currently publish ` +
      "this measurement or has no record to compare against; each station’s published measurements are listed in its details."
    : `${coverage}.${recentOnly}`;
}

function updateWatershedContext(station) {
  let selectedPath = null;
  document.querySelectorAll(".watershed").forEach((path) => {
    const selected =
      Number(path.dataset.watershedNumber) === Number(station.watershed?.number);
    path.classList.toggle("context-selected", selected);
    if (selected) selectedPath = path;
  });
  if (selectedPath) els.watershedLayer.append(selectedPath);
}

function renderDetail(station) {
  const metric = els.metric.value;
  const stat = STAT;
  const data = stationMetric(station, metric);
  const comparison = data ? comparisonRecord(station, metric) : null;
  const percentile = percentileFor(station, metric, stat);

  els.stationCode.textContent = station.id;
  els.stationName.textContent = station.name;
  els.statusContext.textContent = `${statLabels[stat]} ${metricLabels[metric]}`;
  els.watershedName.textContent = station.watershed?.name ?? "Not matched";
  els.reportingArea.textContent = station.reporting_area;
  els.coordinates.textContent = formatCoordinate(
    station.latitude,
    station.longitude,
  );
  els.quality.textContent = station.quality_note;
  els.observed.textContent = observedText(station, metric);
  els.source.textContent = data ? `${data.source}${data.quality === "provisional" ? ", provisional" : ""}` : "--";

  ["level", "flow", "waterTemp", "airTemp"].forEach((key) => {
    const entry = sensorEntry(station, key);
    const display = sensorStatusLabels[entry.status];
    els.sensorDetails[key].textContent = sensorDetailText(entry);
    const element = els.sensors[key];
    element.textContent = display.label;
    element.className = `tag ${display.className}`;
  });

  const recentKeys = ["min", "mean", "max"];
  els.values.forEach((element, index) => {
    element.textContent = formatValue(data?.recent?.[recentKeys[index]], data?.unit);
  });
  const note = comparison?.comparison_note ?? data?.comparison_note;
  if (Number.isFinite(comparison?.usable_years)) {
    els.comparison.textContent = `${comparison.usable_years} years of records${note ? ` (${note.toLowerCase()})` : ""}`;
  } else {
    els.comparison.textContent = note ?? "No usable historical comparison record";
  }
  els.comparisonDate.textContent = comparisonContextText();
  els.marker.style.display = "none";

  if (!data) {
    els.statusDot.style.background = "var(--p-nodata)";
    els.statusDot.style.borderStyle = "dashed";
    els.statusLabel.textContent = missingDataLabel(station, metric);
    els.percentile.textContent = "—";
    return;
  }

  const item = category(percentile);
  if (percentile === null || !item) {
    els.statusDot.style.background = "var(--p-nodata)";
    els.statusDot.style.borderStyle = "dashed";
    els.statusLabel.textContent = "No comparable data";
    els.percentile.textContent = "—";
    return;
  }

  els.statusDot.style.background = item.css;
  els.statusDot.style.borderStyle = "solid";
  els.statusLabel.textContent = item.label;
  els.percentile.textContent = `P${percentile}`;
  els.marker.style.display = "block";
  els.marker.style.left = `${percentile}%`;
}

function render() {
  const metric = els.metric.value;
  const stat = STAT;
  const station = appData.stations.find(
    (item) => item.id === selectedStationId,
  );

  els.mapTitle.textContent =
    `${metricLabels[metric][0].toUpperCase()}${metricLabels[metric].slice(1)} — ${statLabels[stat]}`;
  els.definition.textContent = metric === "waterTemp" || metric === "airTemp"
    ? `No ${metricLabels[metric]} percentiles are shown, because no historical temperature record is available. ` +
      "Recent readings appear in each station’s details where the station publishes them. Watershed outlines are geographic context only."
    : `Each coloured point shows that station’s ${statLabels[stat]} ${metricLabels[metric]} percentile. ` +
      `Watershed outlines are geographic context only. ${comparisonDefinitionText()}`;

  updateStationPoints();
  updateWatershedContext(station);
  renderDetail(station);
  announceHeight();
}

function announceHeight() {
  if (window.parent !== window) {
    window.parent.postMessage(
      { type: "giws-water-map-height", height: document.documentElement.scrollHeight },
      "*",
    );
  }
}

async function init() {
  try {
    [appData, windowComparisonData, watershedData, boundaryData] = await Promise.all([
      loadJson(DATA_URL, "giws-map-data"),
      loadJson(WINDOW_DATA_URL, "giws-map-window-data"),
      loadJson(WATERSHED_URL, "giws-map-geojson"),
      loadJson(BOUNDARY_URL, "giws-map-boundary"),
    ]);

    selectedStationId = appData.default_station;
    applyComparisonCopy();
    // The seasonal window is the default; fall back only if the data does not define its width.
    els.comparisonMethod.value = els.seasonalWindowOption.disabled ? "same_date" : SEASONAL_WINDOW;
    els.availabilityNote.textContent = availabilityNoteText();
    els.dataChip.textContent = isIllustrative() ? "Mock conditions" : "Provisional data";
    els.dataRetrieved.textContent = isIllustrative() ? "" : `Data retrieved ${formatDateTime(appData.generated_at)}`;
    buildGeography();
    populateStationSelect();
    buildStationLayer();

    els.metric.addEventListener("change", render);
    els.comparisonMethod.addEventListener("change", render);
    els.stationSelect.addEventListener("change", () => {
      selectedStationId = els.stationSelect.value;
      render();
    });
    window.addEventListener("resize", announceHeight);
    render();
  } catch (error) {
    console.error(error);
    els.definition.textContent =
      "Map data could not be loaded. Serve this folder over HTTP or use the generated self-contained preview.";
  }
}

init();