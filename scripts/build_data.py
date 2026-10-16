#!/usr/bin/env python3
"""Build site/data/locations.json and site/data/sessions.json.

Downloads the City of Toronto "Registered Programs and Drop In Courses
Offering" open data (Drop-in, Locations, Facilities) and joins it with the
"Parks and Recreation Facilities" dataset for coordinates. Locations missing
from that dataset are geocoded with Nominatim and cached in
scripts/geocode_cache.json. See CONTRACT.md for the output format.

Standard library only. Run from the repository root:

    python3 scripts/build_data.py
"""

import csv
import datetime as dt
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

CKAN_BASE = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action"
PROGRAMS_PACKAGE = "registered-programs-and-drop-in-courses-offering"
GEOMETRY_PACKAGE = "parks-and-recreation-facilities"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "toronto-rec-dropin-site/1.0 (https://github.com/; data build script)"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "site" / "data"
GEOCODE_CACHE_PATH = Path(__file__).resolve().parent / "geocode_cache.json"

# Rough bounding box of the City of Toronto, used to reject bad geocodes.
TORONTO_BOUNDS = {"lat": (43.55, 43.88), "lng": (-79.65, -79.10)}

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

CATEGORIES = [
    {"id": "swim", "label": "Swimming", "icon": "🏊"},
    {"id": "basketball", "label": "Basketball", "icon": "🏀"},
    {"id": "racquet", "label": "Racquet sports", "icon": "🏓"},
    {"id": "court", "label": "Gym & field sports", "icon": "🏐"},
    {"id": "skate", "label": "Skating & hockey", "icon": "⛸️"},
    {"id": "fitness", "label": "Fitness", "icon": "💪"},
    {"id": "aquafit", "label": "Aquafit", "icon": "💦"},
    {"id": "kids", "label": "Early years", "icon": "🧸"},
    {"id": "youth", "label": "Youth", "icon": "🎧"},
    {"id": "arts", "label": "Arts & hobbies", "icon": "🎨"},
    {"id": "other", "label": "Other", "icon": "✨"},
]

# Ordered (pattern, category, group) rules matched against the course title.
# The first match wins; a group of None means "derive from the title".
TITLE_RULES = [
    (r"^aquatic fitness", "aquafit", "Aquafit"),
    (r"^lane swim", "swim", "Lane Swim"),
    (r"leisure swim", "swim", "Leisure Swim"),
    (r"^humber college swim", "swim", "Humber College Swim"),
    (r"wheelchair basketball", "basketball", "Wheelchair Basketball"),
    (r"basketball", "basketball", "Basketball"),
    (r"^badminton", "racquet", "Badminton"),
    (r"^pickleball", "racquet", "Pickleball"),
    (r"^table tennis", "racquet", "Table Tennis"),
    (r"^tennis", "racquet", "Tennis"),
    (r"^squash", "racquet", "Squash"),
    (r"leisure skate", "skate", "Leisure Skate"),
    (r"^shinny", "skate", "Shinny"),
    (r"^pick up hockey", "skate", "Pick Up Hockey"),
    (r"^figure skating", "skate", "Figure Skating"),
    (r"^ice breakdancing", "skate", "Ice Breakdancing"),
    (r"^volleyball", "court", "Volleyball"),
    (r"^soccer", "court", "Soccer"),
    (r"^multi-sport", "court", "Multi-Sport"),
    (r"^open gym with caregiver", "kids", "Play with Caregiver"),
    (r"^open gym", "court", "Open Gym"),
    (r"^ball hockey", "court", "Ball Hockey"),
    (r"^dodgeball", "court", "Dodgeball"),
    (r"^(bocce|carpet bowling|lawn bowling|cornhole)", "court", "Bocce & Bowling"),
    (r"^(cricket|baseball|golf|archery)", "court", None),
    (r"^rock wall climbing", "court", "Rock Climbing"),
    (r"^skateboarding", "court", "Skateboarding"),
    (r"^weight/cardio room", "fitness", "Weight Room"),
    (r"^walking/running track", "fitness", "Indoor Track"),
    (r"^yoga", "fitness", "Yoga"),
    (r"^pilates", "fitness", "Pilates"),
    (r"^(tai chi|qigong|meditation)", "fitness", "Tai Chi & Meditation"),
    (r"^zumba", "fitness", "Zumba"),
    (r"^cardio", "fitness", "Cardio"),
    (r"hiit", "fitness", "HIIT & Boot Camp"),
    (r"^(strength and conditioning|learn to weight train|functional fit|pedal and strength)",
     "fitness", "Strength"),
    (r"^(gentle fit|osteo fit|mobility and strength|fit flow)", "fitness", "Gentle Fitness"),
    (r"walk ?fit|^walking$", "fitness", "Walking"),
    (r"^(step|cycle fit)", "fitness", "Cardio"),
    (r"with caregiver", "kids", "Play with Caregiver"),
    (r"^youth zone", "youth", "Youth Zone"),
    (r"^tween zone", "youth", "Tween Zone"),
    (r"^amped", "youth", "AMPED Music"),
    (r"^(youth council|youth leadership|young m[ae]n|young women|the great debate"
     r"|collaboration|level up|artist in the 6ix|chop it like)", "youth", "Youth Programs"),
    (r"^(open space|movie time|lunch time|tournament time|virtual driving)", "youth",
     "Youth Hangout"),
    (r"^study time", "youth", "Study Time"),
    (r"^video game", "youth", "Video Games"),
    (r"^(club|girls club)", "arts", "Clubs"),
    (r"^cards", "arts", "Cards"),
    (r"^games", "arts", "Games"),
    (r"^(computer lab|workshop: computers)", "arts", "Computer Lab"),
    (r"^dance", "arts", "Dance"),
    (r"^music", "arts", "Music"),
    (r"^(cooking|hair|diy)", "arts", "DIY & Workshops"),
    (r"^drag ", "arts", "Drag"),
    (r"^special event", "arts", "Special Events"),
    (r"^(art club|bazaar crafts|bunka|colouring|country crafts|crafts|crochet|decoupage"
     r"|drawing|jewellery|knitting|multi arts|painting|quilting|sewing|stained glass"
     r"|wood carving|media arts|photography|creative writing|open mic)", "arts",
     "Arts & Crafts"),
]

# Fallback category by Section prefix when no title rule matches.
SECTION_FALLBACKS = [
    ("swim", "swim"),
    ("aquatic", "aquafit"),
    ("skate", "skate"),
    ("fitnessto", "fitness"),
    ("eys - sports", "court"),
    ("sports", "court"),
    ("early years", "kids"),
    ("eys", "youth"),
    ("arts", "arts"),
    ("hobbies", "arts"),
]

# Facility types worth showing a visitor; utilities (fountains, kitchens,
# parking, dressing rooms) are left out.
FACILITY_WHITELIST = {
    "Gymnasium", "Indoor Pool", "Outdoor Pool", "Wading Pool", "Splash Pad",
    "Weight/Cardio Room", "Fitness/Dance Studio", "Indoor Track", "Outdoor track",
    "Indoor Rink", "Outdoor Rink", "Indoor Dry Pad", "Outdoor Dry Pad",
    "Pickleball Court", "Indoor Squash Court", "Outdoor Tennis Court",
    "Outdoor Basketball Court", "Outdoor Volleyball Court", "Outdoor Table Tennis",
    "Indoor Bocce Court", "Bowling Green", "Sport Field", "Multipurpose Field",
    "Ball Diamond", "Cricket Pitch Field", "Ball Hockey Pad", "Skateboard Area",
    "Enhanced Youth Space", "Games Room", "Computer/Training Room", "Recording Studio",
    "Craft Room", "Preschool", "Playroom", "Playground", "Gallery", "Auditorium",
    "Sauna", "Multipurpose Room",
}


def fetch_bytes(url, params=None):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except OSError as error:
            if attempt == 3:
                raise
            print(f"  retrying {url}: {error}", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    raise AssertionError("unreachable")


def resource_url(package_id, matches_resource):
    payload = json.loads(fetch_bytes(f"{CKAN_BASE}/package_show", {"id": package_id}))
    for resource in payload["result"]["resources"]:
        if matches_resource(resource):
            return resource["url"]
    raise SystemExit(f"No matching resource found in package {package_id}")


def download_csv(url):
    text = fetch_bytes(url).decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


def download_program_resource(resource_name):
    print(f"Downloading {resource_name}")
    url = resource_url(PROGRAMS_PACKAGE, lambda resource: resource["name"] == resource_name)
    return download_csv(url)


def download_geometry_rows():
    print("Downloading Parks and Recreation Facilities (WGS84)")
    url = resource_url(
        GEOMETRY_PACKAGE,
        lambda resource: resource["format"].upper() == "CSV" and "4326" in resource["name"],
    )
    return download_csv(url)


def clean(value):
    """Return a stripped string, or None for the dataset's empty markers."""
    if value is None:
        return None
    value = value.strip()
    return None if value in ("", "None", "none", "N/A") else value


def to_int(value):
    value = clean(value)
    return None if value is None else int(float(value))


def toronto_today():
    try:
        from zoneinfo import ZoneInfo

        return dt.datetime.now(ZoneInfo("America/Toronto")).date()
    except Exception:
        return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)).date()


def classify(title, section):
    lowered = title.lower()
    for pattern, category, group in TITLE_RULES:
        if re.search(pattern, lowered):
            return category, group or derive_group(title)
    section_lowered = section.lower()
    for prefix, category in SECTION_FALLBACKS:
        if section_lowered.startswith(prefix):
            return category, derive_group(title)
    return "other", derive_group(title)


def derive_group(title):
    """Strip audience qualifiers so variants share a parent name."""
    group = re.sub(r"\s*\([^)]*\)", "", title)
    group = re.sub(r"\s+with (family|caregiver|baby)$", "", group, flags=re.IGNORECASE)
    group = group.split(":")[0].strip()
    return group or title


def format_address(location):
    # The suffix is a unit letter that belongs against the number, e.g. "25A".
    number = (clean(location.get("Street No")) or "") + (clean(location.get("Street No Suffix")) or "")
    parts = [
        number,
        clean(location.get("Street Name")),
        clean(location.get("Street Type")),
        clean(location.get("Street Direction")),
    ]
    return " ".join(part for part in parts if part) or None


def normalize_district(district):
    district = clean(district)
    if district == "Toronto East York":
        return "Toronto and East York"
    return district


def coordinates_by_location(geometry_rows):
    coordinates = {}
    for row in geometry_rows:
        location_id = clean(row.get("LOCATIONID"))
        if not location_id or location_id in coordinates:
            continue
        try:
            geometry = json.loads(row["geometry"])
        except (KeyError, ValueError):
            continue
        points = geometry.get("coordinates") or []
        if geometry.get("type") == "Point":
            points = [points]
        if points and len(points[0]) >= 2:
            lng, lat = points[0][0], points[0][1]
            coordinates[location_id] = (round(lat, 6), round(lng, 6))
    return coordinates


def within_toronto(lat, lng):
    return (TORONTO_BOUNDS["lat"][0] <= lat <= TORONTO_BOUNDS["lat"][1]
            and TORONTO_BOUNDS["lng"][0] <= lng <= TORONTO_BOUNDS["lng"][1])


def load_geocode_cache():
    if GEOCODE_CACHE_PATH.exists():
        return json.loads(GEOCODE_CACHE_PATH.read_text(encoding="utf-8"))
    return {}


def geocode(query, cache):
    """Look up an address with Nominatim, caching hits and misses."""
    if query in cache:
        return cache[query]
    time.sleep(1.1)  # Nominatim usage policy: at most one request per second.
    params = {"q": query, "format": "json", "limit": 1, "countrycodes": "ca"}
    try:
        results = json.loads(fetch_bytes(NOMINATIM_URL, params))
    except (OSError, ValueError) as error:
        print(f"  geocode failed for {query!r}: {error}", file=sys.stderr)
        return None
    result = None
    if results:
        lat, lng = float(results[0]["lat"]), float(results[0]["lon"])
        if within_toronto(lat, lng):
            result = [round(lat, 6), round(lng, 6)]
    cache[query] = result
    return result


def geocode_location(location, cache):
    address = format_address(location)
    postal = clean(location.get("Postal Code"))
    name = clean(location.get("Location Name"))
    queries = []
    if address:
        queries.append(f"{address}, Toronto, ON" + (f" {postal}" if postal else ""))
        queries.append(f"{address}, Toronto, ON")
    if name:
        queries.append(f"{name}, Toronto, ON")
    for query in dict.fromkeys(queries):
        result = geocode(query, cache)
        if result:
            return tuple(result)
    return None


def expand_dates(row):
    """Yield every date in First Date..Last Date that falls on DayOftheWeek."""
    first = dt.date.fromisoformat(row["First Date"].strip()[:10])
    last = dt.date.fromisoformat(row["Last Date"].strip()[:10])
    weekday_name = clean(row.get("DayOftheWeek"))
    weekday = WEEKDAYS.index(weekday_name) if weekday_name in WEEKDAYS else None
    day = first
    while day <= last:
        if weekday is None or day.weekday() == weekday or first == last:
            yield day
        day += dt.timedelta(days=1)


def format_time(hour, minute):
    return f"{int(hour):02d}:{int(minute):02d}"


def build_sessions(dropin_rows, today):
    """Return (activity metadata by title, unique session tuples)."""
    activity_info = {}
    sessions = set()
    for row in dropin_rows:
        title = clean(row.get("Course Title"))
        location_id = clean(row.get("Location ID"))
        if not title or not location_id:
            continue
        section = clean(row.get("Section")) or ""
        start = format_time(row["Start Hour"], row["Start Minute"])
        end = format_time(row["End Hour"], row["End Min"])
        age_min = to_int(row.get("Age Min"))
        age_max = to_int(row.get("Age Max"))
        for day in expand_dates(row):
            if day < today:
                continue
            if title not in activity_info:
                activity_info[title] = classify(title, section)
            sessions.add((title, location_id, day.isoformat(), start, end, age_min, age_max))
    return activity_info, sessions


def build_location(location, coordinates, facility_names):
    lat, lng = coordinates if coordinates else (None, None)
    return {
        "name": clean(location.get("Location Name")),
        "address": format_address(location),
        "postal": clean(location.get("Postal Code")),
        "district": normalize_district(location.get("District")),
        "lat": lat,
        "lng": lng,
        "accessibility": clean(location.get("Accessibility")),
        "ttc": clean(location.get("TTC Information")),
        "facilities": facility_names,
    }


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text + "\n", encoding="utf-8")
    print(f"Wrote {path.relative_to(REPO_ROOT)} ({path.stat().st_size / 1024:.0f} KB)")


def main():
    today = toronto_today()
    generated = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    generated = generated.replace("+00:00", "Z")

    dropin_rows = download_program_resource("Drop-in.csv")
    location_rows = download_program_resource("Locations.csv")
    facility_rows = download_program_resource("Facilities.csv")
    geometry_rows = download_geometry_rows()

    activity_info, sessions = build_sessions(dropin_rows, today)
    if not sessions:
        raise SystemExit("No sessions from today onward; refusing to write empty data.")

    activity_ids = {title: index for index, title in enumerate(sorted(activity_info))}
    activities = [
        {"id": activity_ids[title], "name": title, "category": category, "group": group}
        for title, (category, group) in sorted(activity_info.items())
    ]

    session_rows = sorted(
        ([activity_ids[title], location_id, day, start, end, age_min, age_max]
         for title, location_id, day, start, end, age_min, age_max in sessions),
        key=lambda row: (row[2], row[3], row[4], row[1], row[0]),
    )

    used_location_ids = sorted({row[1] for row in session_rows}, key=int)
    locations_by_id = {clean(row.get("Location ID")): row for row in location_rows}

    facilities_by_location = {}
    for row in facility_rows:
        facility_name = clean(row.get("Facility Type (Display Name)"))
        if facility_name in FACILITY_WHITELIST:
            location_id = clean(row.get("Location ID"))
            facilities_by_location.setdefault(location_id, set()).add(facility_name)

    coordinates = coordinates_by_location(geometry_rows)
    geocode_cache = load_geocode_cache()
    coordinate_sources = Counter()
    locations = {}
    for location_id in used_location_ids:
        location = locations_by_id.get(location_id, {"Location Name": f"Location {location_id}"})
        point = coordinates.get(location_id)
        if point:
            coordinate_sources["open data"] += 1
        else:
            point = geocode_location(location, geocode_cache)
            coordinate_sources["geocoded" if point else "missing"] += 1
        facility_names = sorted(facilities_by_location.get(location_id, ()))
        locations[location_id] = build_location(location, point, facility_names)

    GEOCODE_CACHE_PATH.write_text(
        json.dumps(geocode_cache, indent=1, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    write_json(OUTPUT_DIR / "locations.json", {"generated": generated, "locations": locations})
    write_json(OUTPUT_DIR / "sessions.json", {
        "generated": generated,
        "categories": CATEGORIES,
        "activities": activities,
        "sessions": session_rows,
    })

    located = coordinate_sources["open data"] + coordinate_sources["geocoded"]
    print(f"Sessions: {len(session_rows)} from {today} to {session_rows[-1][2]}")
    print(f"Activities: {len(activities)}; locations: {len(locations)}")
    print(f"Coordinates: {located}/{len(locations)} "
          f"({100 * located / len(locations):.1f}%) {dict(coordinate_sources)}")
    sessions_per_category = Counter(activities[row[0]]["category"] for row in session_rows)
    print("Sessions per category:", dict(sessions_per_category.most_common()))


if __name__ == "__main__":
    main()
