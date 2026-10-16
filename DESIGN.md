# Rec Finder design spec

This spec turns the UI and accessibility audit into build instructions. The proposed screens
are on the design canvas; this file is the source of truth for implementation.

Target: WCAG 2.2 AA, and one tap from Home to "what's open near me right now".

## Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--control-border` | `#8a93a3` | `#7d8796` | Borders of every interactive control (chips, inputs, selects, toggle buttons, tiles). At least 3:1 against surface. |
| `--border` | `#d8dde5` | `#333b46` | Decorative dividers and card outlines only. |
| `--muted` | `#3d4450` | `#b4bcc8` | Secondary text. Darker than the current `#5a6270`. |
| Focus ring | `outline: 3px solid #0b1f4d` + `box-shadow: 0 0 0 5px #fff` | `outline: 3px solid #ffffff` + `box-shadow: 0 0 0 5px #0b1f4d` | Two-tone ring that is visible on any background. Replaces `#f0a400`. |

Typography: Atkinson Hyperlegible 400/700 from Google Fonts, with a system-ui fallback.
Body text 17px, meta text at least 15px, never below 14px. Line height 1.4 or more.

Icons: replace emoji with one inline stroke-SVG icon set (24px viewBox, stroke 1.8–2,
`currentColor`, `aria-hidden="true"`). Covers each category plus back, close, filters,
location, directions and search.

## 1. "Who's going?" (new, high priority)

- Choices: Adult (19+), 60+ (older adult), Youth (13–18), Child (under 13), Anyone. It replaces
  the free-number age field. A session matches when its age range overlaps the chosen band.
  Use these representative ages: Adult 30, 60+ 65, Youth 15, Child 8. Anyone means no filter.
- Shown on Home in the starting-point card and in the Filters sheet. Persist the choice in
  localStorage and in the URL hash. The default is Anyone until the user picks.
- Results show "N sessions for other ages hidden.", with a "Show" button that switches to
  Anyone for this view.
- Category tile counts and the open-now strip respect the choice.

## 2. Home

Order from top to bottom:
1. Starting-point card: "Near <label>" plus a Change button that opens the location picker,
   or a "Set your location" prompt when none is set. Below it, the "Who's going?" chips.
2. "Open now near you" (when a starting point is set; otherwise "Open now"): up to 3
   sessions in progress, sorted by distance. Each row shows a filled status dot, the activity,
   the short centre name, the distance, and "Open until 9:00 pm". The "See all" link goes to
   results for all categories in the next 2 hours.
3. "Pick an activity": a search field with a visible 1px `--control-border`, then category
   tiles with an SVG icon, the label, and a live count: "N open now" in green bold, else
   "N later today", else "Next: Sat 1:00 pm". The six-week totals go away.
4. Plain category labels: "Kids & caregivers", "Youth (13–24)", "Gym sports" (instead of
   "Gym & field sports"), "Skating", "Arts & games".

## 3. Results

- Sticky header: back button, category title, and a "Filters" button with a count badge
  of active non-default filters.
- One horizontally scrolling chip row (no wrapping, `overflow-x: auto`, scroll snap):
  When = Next 2 hours, Later today, Tomorrow, Weekend, Choose date. If the category has more
  than one activity group, add a second scrolling row of activity chips above it.
- Summary line (`aria-live="polite"`): "**6 sessions** for adults. Closest to Dufferin & Bloor."
- Segmented control List | Map. It replaces the Map and By centre toggles. Move "Group by
  centre" into the Filters sheet as a switch.
- Card layout: a fixed 78px time column on the left (start bold, "to <end>" below), then the
  centre name in bold, a meta line (distance · ages in words), and a status line. On the right
  is a 52px Directions icon link with an aria-label of "Directions to <centre>". Tapping the
  card opens centre details.
- Status uses shape as well as colour: open now is a filled dot in green text, starting soon
  is a hollow ring in amber text, and later is plain muted text. Status wording: "Open until
  9:00 pm", "Starts in 25 min", "Tomorrow 7:00 pm".
- Plain wording everywhere: "Next 2 hours", "Group by centre", "Choose date". Write "Ages 19
  and up", "All ages" and "Ages 13–18".
- Group by centre: one row per session (time | activity | short status) instead of a pill
  on every line.

## 4. Filters bottom sheet (`<dialog>`)

Sections in this order: Starting point (Use my current location, plus the existing
postal-code/intersection/centre input from the QA pass), Who's going, Activity (checkboxes),
Time of day, District, and a Group by centre switch. The sticky footer has "Reset" and a primary
"Show N sessions" button that shows a live count. Esc and Back close the sheet. Focus starts
on the heading.

## 5. Map

- An open-now pin is a filled circle and a later pin is a hollow ring with a thick stroke,
  so pins differ by shape and not only by colour. Add a small legend in the map corner.
- Number the pins in list order and show the same number on the list cards when the map is
  visible.
- `aria-label` on the map region: "Map of matching centres. Same results as the list."

## 6. Centre details sheet

- Header: the centre name (h2), "address · district", and a close button.
- Action row: a primary "Directions · 2.7 km" button and a secondary "City page" link (use
  `https://www.toronto.ca/data/parks/prd/facilities/complex/<locationId>/index.html`).
- A compact `<dl>` with Accessibility and Facilities as comma-separated sentence case.
- Schedule: sticky day headings ("Today · Fri Oct 16"). Each row shows a fixed 92px time column,
  the activity name in bold, and ages on their own line. A "Your pick" text tag replaces ★.
  Sessions outside the chosen age band are greyed out with "Youth only, ages 13–18" and
  listed after the matching ones for that day.

## 7. Global accessibility checks

- Every control has a visible label or `aria-label`. Toggles use `aria-pressed`, and
  segmented controls use `role="group"` with `aria-label`.
- Tap targets are at least 44×44.
- The layout reflows at 320 CSS px and at 200% zoom with no horizontal page scroll.
  Only the chip rows scroll sideways.
- `prefers-reduced-motion` turns off smooth scrolling and transitions.
- Dark mode uses the token values above. Check every text and control pair against 4.5:1
  for text and 3:1 for UI.
