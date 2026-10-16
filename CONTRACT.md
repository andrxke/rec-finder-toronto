# Data contract between the pipeline and the site

Source: City of Toronto Open Data, "Registered Programs and Drop In Courses Offering"
(CKAN package `registered-programs-and-drop-in-courses-offering`, refreshed daily).
Only the Drop-in, Locations, and Facilities resources are used.

The pipeline (`scripts/build_data.py`, Python 3 stdlib only) writes two files into `site/data/`.
The site (`site/`, static HTML/CSS/vanilla JS, no build step) only reads these two files.

## site/data/locations.json

```json
{
  "generated": "2026-10-16T05:00:00Z",
  "locations": {
    "749": {
      "name": "Wallace Emerson Community Centre",
      "address": "1260 Dufferin St",
      "postal": "M6H 4C3",
      "district": "Toronto and East York",
      "lat": 43.667, "lng": -79.441,
      "accessibility": "Fully Accessible",
      "ttc": "Dufferin 29 bus",
      "facilities": ["Indoor Pool", "Gymnasium"]
    }
  }
}
```

`lat`/`lng` may be `null` when no coordinates could be found. Unused locations are omitted.

## site/data/sessions.json

```json
{
  "generated": "2026-10-16T05:00:00Z",
  "categories": [
    {"id": "swim", "label": "Swimming", "icon": "🏊"}
  ],
  "activities": [
    {"id": 0, "name": "Lane Swim", "category": "swim", "group": "Lane Swim"}
  ],
  "sessions": [
    [0, "749", "2026-10-15", "16:00", "18:00", 13, 24]
  ]
}
```

Each session row is `[activityId, locationId, date, start, end, ageMin, ageMax]`.
`ageMin`/`ageMax` are integers or `null` for no limit. Rows are sorted by date then start.

`group` is a friendly parent name that merges variants (for example "Lane Swim: Older Adult"
and "Lane Swim" both have group "Lane Swim"), so users can pick "Lane Swim" without knowing
every variant.

Category ids (fixed so the site can rely on them):
`swim`, `basketball`, `racquet` (badminton, pickleball, tennis, table tennis, squash),
`court` (volleyball, soccer, multi-sport, open gym, ball hockey, other gym sports),
`skate` (leisure skate, shinny/hockey), `fitness` (weight room, track, yoga, cardio classes),
`aquafit`, `kids` (early years, caregiver play), `youth` (youth/tween zones),
`arts` (arts, hobbies, games, clubs, computer lab), `other`.
