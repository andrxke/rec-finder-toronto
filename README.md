# Rec Finder Toronto

Find City of Toronto drop-in recreation sessions near you, open now or soon.

## Run locally

```sh
python3 scripts/build_data.py        # Download and normalize today's open data.
cd site && python3 -m http.server 8000
```

Open http://localhost:8000. Add `?now=2026-10-16T17:30` to pin the Toronto clock for testing.

## Layout

- `scripts/build_data.py` downloads the City's drop-in, location and facility data and writes
  `site/data/locations.json` and `site/data/sessions.json`. It uses only the Python standard library.
- `site/` is a static site with plain HTML, CSS and JavaScript and no build step.
- `CONTRACT.md` defines the data format shared by the script and the site.
- `DESIGN.md` is the UI and accessibility spec.

## Deploy

Any static host works. On GitHub Pages, serve the `site/` folder. The workflow in
`.github/workflows/refresh-data.yml` rebuilds the data daily and commits it.

## Data

City of Toronto Open Data, "Registered Programs and Drop In Courses Offering", used under the
Open Government Licence – Toronto. Coordinates come from the City's Parks and Recreation
Facilities dataset.
