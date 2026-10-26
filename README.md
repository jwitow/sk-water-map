# Saskatchewan water conditions map (test build)

A static map comparing recent conditions at 37 Saskatchewan hydrometric stations with each station's own history. This repository is a test deployment for embedding the map in a web page. The data is provisional and the method has not yet been reviewed, so the map should not be presented as official conditions.

## Data

- **Recent readings:** Environment and Climate Change Canada (ECCC) real-time hydrometric data. These are provisional and subject to revision.
- **History:** approved daily means from ECCC's national hydrometric archive (HYDAT), through the MSC GeoMet API.
- **Which measurements each station publishes:** `docs/sensor-inventory-*.json`, from a dated check of ECCC and Saskatchewan Water Security Agency sources.
- **Map geometry:** simplified from Saskatchewan Water Security Agency province-boundary and watershed exports.

The page only reads the files in `historical-map/data/`. It never calls an agency service itself. A scheduled GitHub Actions workflow (`.github/workflows/deploy.yml`) refreshes those files every three hours and publishes the site with GitHub Pages. If a refresh fails, the previous version stays online. The method, defaults and known limitations are in `docs/map-data-pipeline.md`.

## Run locally

```bash
python scripts/build_map_data.py
python -m http.server 8080 --directory historical-map
```

Then open http://localhost:8080/. The first run downloads station history, which takes a few minutes; later runs use a local cache.

## Embedding

Replace `SITE-URL` with the site's GitHub Pages address, for example `https://jwitow.github.io/REPO-NAME/`.

```html
<iframe id="sk-water-map" src="SITE-URL" title="Saskatchewan water conditions map"
        style="width: 100%; height: 1500px; border: 0;" loading="lazy"></iframe>
```

The map reports its height to the parent page. If the host page allows a script, this keeps the iframe sized to fit:

```html
<script>
  window.addEventListener("message", function (event) {
    if (event.origin !== "https://jwitow.github.io") return;
    if (event.data && event.data.type === "giws-water-map-height") {
      document.getElementById("sk-water-map").style.height = event.data.height + "px";
    }
  });
</script>
```
