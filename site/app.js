// Rec Finder: find Toronto drop-in recreation open now or soon.
// Data shapes are defined in CONTRACT.md at the repository root.

const TIME_ZONE = 'America/Toronto';
const MINUTES_PER_DAY = 1440;
const MS_PER_DAY = 86400000;
const SOON_WINDOW_MINUTES = 120;
const PAGE_SIZE = 50;
const CENTRE_PREVIEW_COUNT = 5;
const OPEN_NOW_LIMIT = 3;
// Weight rooms and tracks list their whole opening hours as one long session.
// The open-now strip skips those so it shows drop-ins with a set start and end.
const OPEN_HOURS_BLOCK_MINUTES = 240;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const GEO_PREF_KEY = 'recfinder.geolocation';
const ORIGIN_KEY = 'recfinder.origin';
const WHO_KEY = 'recfinder.who';
const ORIGIN_LABEL_MAX_LENGTH = 60;
const TORONTO_BOUNDS = { west: -79.64, north: 43.86, east: -79.11, south: 43.58 };
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Nominatim's usage policy allows at most one request per second.
const GEOCODE_MIN_INTERVAL_MS = 1000;
const GEOCODE_TIMEOUT_MS = 10000;
const POSTAL_CODE_PATTERN = /^([A-Z]\d[A-Z])\s*(\d[A-Z]\d)?$/i;
const CITY_PAGE_URL = 'https://www.toronto.ca/data/parks/prd/facilities/complex';
const ALL_CATEGORIES = 'all';
const DISTRICTS = ['Etobicoke York', 'North York', 'Scarborough', 'Toronto and East York'];
// Some rows use a large number such as 99 to mean "no upper age limit".
const OPEN_ENDED_AGE = 99;

const WHEN_OPTIONS = [
  ['now', 'Next 2 hours'],
  ['today', 'Later today'],
  ['tomorrow', 'Tomorrow'],
  ['weekend', 'Weekend'],
  ['date', 'Choose date'],
];

// Each band is tested with one representative age: a session suits the band
// when that age falls inside one of the session's age ranges.
const WHO_OPTIONS = [
  { id: 'adult', label: 'Adult (19+)', audience: 'adults', age: 30 },
  { id: 'older', label: '60+', hiddenLabel: ' (older adult)', audience: 'older adults', age: 65 },
  { id: 'youth', label: 'Youth (13–18)', audience: 'youth', age: 15 },
  { id: 'child', label: 'Child (under 13)', audience: 'children', age: 8 },
  { id: 'anyone', label: 'Anyone', audience: '', age: null },
];
const ANYONE = 'anyone';

// Ranges are minutes after midnight, judged by session start time.
const TIME_OF_DAY = {
  morning: { label: 'Morning', from: 0, to: 12 * 60 },
  afternoon: { label: 'Afternoon', from: 12 * 60, to: 17 * 60 },
  evening: { label: 'Evening', from: 17 * 60, to: MINUTES_PER_DAY },
};

// Category ids are fixed by CONTRACT.md. These plainer labels replace the
// data file's labels, which stay as the fallback for any id added later.
const CATEGORY_LABELS = {
  court: 'Gym sports',
  skate: 'Skating',
  kids: 'Kids & caregivers',
  youth: 'Youth (13–24)',
  arts: 'Arts & games',
};
const CATEGORY_ICONS = new Set(['swim', 'basketball', 'racquet', 'court', 'skate', 'fitness', 'aquafit',
  'kids', 'youth', 'arts', 'other']);

const CENTRE_NAME_ABBREVIATIONS = [
  [/ Community Recreation Centre$/, ' CRC'],
  [/ Community Centre$/, ' CC'],
  [/ Recreation Centre$/, ' RC'],
];

const elements = Object.fromEntries([
  'load-status', 'home-view', 'results-view', 'start-label', 'change-origin', 'home-who-chips',
  'open-now-title', 'open-now-list', 'search-input', 'search-results', 'category-grid',
  'results-title', 'filter-badge', 'group-row', 'when-chips', 'date-label', 'date-input',
  'result-summary', 'list-mode-button', 'map-mode-button', 'age-notice', 'results-list', 'show-more',
  'map', 'map-fallback', 'filters-sheet', 'filters-title', 'origin-current', 'geo-status', 'origin-form',
  'origin-input', 'origin-status', 'origin-centre', 'sheet-who-chips', 'activity-fieldset',
  'activity-checks', 'tod-chips', 'tod-note', 'district-select', 'by-centre-switch', 'apply-filters',
  'centre-sheet', 'sheet-title', 'sheet-subtitle', 'sheet-body', 'last-updated', 'fixture-note',
].map((id) => [toCamelCase(id), document.getElementById(id)]));

const state = defaultState();
let catalog = null;
let now = torontoNow();
let userPosition = null;
let geoMessage = '';
let renderedCount = PAGE_SIZE;
let lastFilterKey = '';
let currentMatches = [];
let hiddenByAgeCount = 0;
let centreNumbers = new Map();
let map = null;
let markerLayer = null;
let lastMapFitKey = '';
let geocodeBusy = false;
let lastGeocodeAt = 0;
const geocodeCache = new Map();
// True when this page added the history entry for the open centre sheet,
// so closing the sheet can step back instead of leaving a stale entry.
let sheetOpenedByPush = false;
// True while the history entry added for the filters sheet is the current one.
let filtersEntryPushed = false;

const desktopQuery = window.matchMedia('(min-width: 1024px)');

start();

async function start() {
  try {
    const data = await loadData();
    catalog = buildCatalog(data.sessions, data.locations);
    showDataNotes(data);
  } catch (error) {
    console.error(error);
    elements.loadStatus.textContent = 'Schedules unavailable. Try again later.';
    return;
  }
  elements.loadStatus.hidden = true;
  populateStaticControls();
  bindEvents();
  readStateFromHash();
  restoreLocationPermission();
  render();
  setInterval(refreshNow, REFRESH_INTERVAL_MS);
}

/* ---------- Data loading ---------- */

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

// Both files must come from the same source, so a failure of either one
// switches both to the fixture to keep location ids consistent.
async function loadData() {
  try {
    const [locations, sessions] = await Promise.all([
      fetchJson('data/locations.json'),
      fetchJson('data/sessions.json'),
    ]);
    return { locations, sessions, isFixture: false };
  } catch (error) {
    console.warn('Live data unavailable, using fixture.', error);
    const [locations, sessions] = await Promise.all([
      fetchJson('data/fixture/locations.json'),
      fetchJson('data/fixture/sessions.json'),
    ]);
    return { locations, sessions, isFixture: true };
  }
}

function showDataNotes(data) {
  elements.fixtureNote.hidden = !data.isFixture;
  const generated = new Date(data.sessions.generated || data.locations.generated);
  if (!Number.isNaN(generated.getTime())) {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short',
    }).format(generated);
    // Some locales end the time with "a.m.", so drop a trailing period before adding one.
    elements.lastUpdated.textContent = `Last updated ${formatted.trim().replace(/\.$/, '')}.`;
  }
}

/* ---------- Catalog and indexes ---------- */

function buildCatalog(sessionsData, locationsData) {
  const locations = locationsData.locations;
  const categories = sessionsData.categories.map((category) => ({
    id: category.id,
    label: CATEGORY_LABELS[category.id] || category.label,
    icon: CATEGORY_ICONS.has(category.id) ? category.id : 'other',
  }));
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const activityById = new Map(sessionsData.activities.map((activity) => [activity.id, activity]));
  const dayNumberCache = new Map();
  const sessions = [];
  const sessionByKey = new Map();
  let longestSession = 0;

  for (const [activityId, locationId, date, startClock, endClock, ageMin, ageMax] of sessionsData.sessions) {
    const location = locations[String(locationId)];
    if (!activityById.has(activityId) || !location) continue;
    if (!dayNumberCache.has(date)) dayNumberCache.set(date, dayNumber(date));
    const day = dayNumberCache.get(date);
    const start = day * MINUTES_PER_DAY + parseClock(startClock);
    let end = day * MINUTES_PER_DAY + parseClock(endClock);
    if (end <= start) end += MINUTES_PER_DAY;
    // The source lists the same drop-in twice when it has two age ranges;
    // merge them so one card shows both ranges.
    const key = `${activityId}|${locationId}|${start}|${end}`;
    const duplicate = sessionByKey.get(key);
    if (duplicate) {
      duplicate.ageRanges.push([ageMin, ageMax]);
      continue;
    }
    longestSession = Math.max(longestSession, end - start);
    const session = { activityId, locationId: String(locationId), day, start, end, ageRanges: [[ageMin, ageMax]] };
    sessionByKey.set(key, session);
    sessions.push(session);
  }
  sessions.sort((a, b) => a.start - b.start);

  return {
    locations,
    categories,
    categoryById,
    activityById,
    sessions,
    longestSession,
    sessionsByActivity: groupBy(sessions, (session) => session.activityId),
    sessionsByLocation: groupBy(sessions, (session) => session.locationId),
    groupsByCategory: buildGroupsByCategory(sessionsData.activities),
    searchEntries: buildSearchEntries(sessionsData.activities, locations, categoryById),
  };
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function buildGroupsByCategory(activities) {
  const groupsByCategory = new Map();
  for (const activity of activities) {
    if (!groupsByCategory.has(activity.category)) groupsByCategory.set(activity.category, new Map());
    const groups = groupsByCategory.get(activity.category);
    if (!groups.has(activity.group)) groups.set(activity.group, []);
    groups.get(activity.group).push(activity.id);
  }
  return groupsByCategory;
}

function buildSearchEntries(activities, locations, categoryById) {
  const entries = [];
  for (const activity of activities) {
    const key = `${activity.category}|${activity.group}`;
    const existing = entries.find((entry) => entry.key === key);
    if (existing) {
      existing.text += ` ${activity.name.toLowerCase()}`;
      continue;
    }
    const category = categoryById.get(activity.category);
    entries.push({
      key,
      kind: 'group',
      category: activity.category,
      group: activity.group,
      label: activity.group,
      detail: category ? category.label : '',
      icon: category ? category.icon : 'other',
      text: `${activity.group} ${activity.name} ${category ? category.label : ''}`.toLowerCase(),
    });
  }
  for (const [locationId, location] of Object.entries(locations)) {
    entries.push({
      key: `location|${locationId}`,
      kind: 'location',
      locationId,
      label: location.name,
      detail: location.address,
      icon: 'centre',
      text: `${location.name} ${location.address} ${location.district}`.toLowerCase(),
    });
  }
  return entries;
}

/* ---------- Toronto time ---------- */

function dayNumber(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function isoDateFromDayNumber(day) {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

function weekdayOf(day) {
  return new Date(day * MS_PER_DAY).getUTCDay();
}

function parseClock(clock) {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

// Times are kept as Toronto wall-clock minutes since the epoch, so "now" must be
// computed in Toronto time whatever the device timezone is.
// A ?now=YYYY-MM-DDTHH:MM query parameter pins the clock for testing.
function torontoNow() {
  const override = new URLSearchParams(window.location.search).get('now');
  if (override && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(override)) {
    const [date, clock] = override.split('T');
    return dayNumber(date) * MINUTES_PER_DAY + parseClock(clock);
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const day = dayNumber(`${parts.year}-${parts.month}-${parts.day}`);
  return day * MINUTES_PER_DAY + Number(parts.hour) * 60 + Number(parts.minute);
}

function todayOf(minutes) {
  return Math.floor(minutes / MINUTES_PER_DAY);
}

function isRunning(session) {
  return session.start <= now && now < session.end;
}

function formatClock(minutes) {
  const minuteOfDay = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours24 = Math.floor(minuteOfDay / 60);
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const suffix = hours24 < 12 ? 'am' : 'pm';
  return `${hours12}:${String(minuteOfDay % 60).padStart(2, '0')} ${suffix}`;
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
});

// Formats as "Fri Oct 16", without the comma the locale adds.
function formatShortDate(day) {
  const parts = Object.fromEntries(SHORT_DATE_FORMAT.formatToParts(new Date(day * MS_PER_DAY))
    .map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.month} ${parts.day}`;
}

function formatWeekday(day) {
  return formatShortDate(day).split(' ')[0];
}

function formatDayLabel(day) {
  const today = todayOf(now);
  if (day === today) return 'Today';
  if (day === today + 1) return 'Tomorrow';
  return formatShortDate(day);
}

function formatDayHeading(day) {
  const relative = formatDayLabel(day);
  const date = formatShortDate(day);
  return relative === date ? date : `${relative} · ${date}`;
}

function describeStatus(session) {
  if (isRunning(session)) {
    return { kind: 'open', text: `Open until ${formatClock(session.end)}`, shortText: 'Open now' };
  }
  const minutesAway = session.start - now;
  if (minutesAway > 0 && minutesAway <= SOON_WINDOW_MINUTES) {
    const duration = formatDuration(minutesAway);
    return { kind: 'soon', text: `Starts in ${duration}`, shortText: `In ${duration}` };
  }
  const dayLabel = formatDayLabel(session.day);
  return { kind: 'later', text: `${dayLabel} ${formatClock(session.start)}`, shortText: dayLabel };
}

// A refresh rebuilds the result cards, so it waits while someone is working in
// the list or in a sheet; the next tick catches up.
function refreshNow() {
  if (document.hidden || !catalog) return;
  if (elements.resultsList.contains(document.activeElement)) return;
  if (elements.centreSheet.open || elements.filtersSheet.open) return;
  now = torontoNow();
  render();
}

/* ---------- State and URL hash ---------- */

function defaultState() {
  return {
    category: null,
    groups: new Set(),
    when: 'now',
    date: '',
    timeOfDay: '',
    who: ANYONE,
    // "Show them" on the hidden-ages notice lifts the age filter for the
    // current view only, so it is neither stored nor put in the URL.
    ignoreAge: false,
    district: '',
    near: false,
    origin: null,
    byCentre: false,
    showMap: false,
    centre: null,
  };
}

function serializeState() {
  const params = new URLSearchParams();
  if (state.category) params.set('cat', state.category);
  if (state.groups.size) params.set('g', [...state.groups].join('|'));
  if (state.category && state.when !== 'now') params.set('when', state.when);
  if (state.when === 'date' && state.date) params.set('date', state.date);
  if (state.timeOfDay) params.set('tod', state.timeOfDay);
  if (state.who !== ANYONE) params.set('who', state.who);
  if (state.district) params.set('district', state.district);
  if (state.near) params.set('near', '1');
  if (state.origin) {
    const { from, name } = originParams(state.origin);
    params.set('from', from);
    if (name) params.set('fromname', name);
  }
  if (state.byCentre) params.set('by', 'centre');
  if (state.showMap) params.set('map', '1');
  if (state.centre) params.set('centre', state.centre);
  return params.toString();
}

function readStateFromHash() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const next = defaultState();
  const category = params.get('cat');
  if (category === ALL_CATEGORIES || (category && catalog.categoryById.has(category))) {
    next.category = category;
  }
  next.groups = new Set((params.get('g') || '').split('|').filter(Boolean));
  const when = params.get('when');
  if (WHEN_OPTIONS.some(([value]) => value === when)) next.when = when;
  next.date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : '';
  if (next.when === 'date' && !next.date) next.date = isoDateFromDayNumber(todayOf(now));
  next.timeOfDay = TIME_OF_DAY[params.get('tod')] ? params.get('tod') : '';
  next.who = parseWho(params.get('who')) || whoForAge(params.get('age')) || readStoredWho() || ANYONE;
  next.district = DISTRICTS.includes(params.get('district')) ? params.get('district') : '';
  next.near = params.get('near') === '1';
  // The starting point is a standing preference, so entries without one fall back to the saved one.
  next.origin = parseOrigin(params.get('from'), params.get('fromname')) || readStoredOrigin();
  next.byCentre = params.get('by') === 'centre';
  next.showMap = params.get('map') === '1';
  const centre = params.get('centre');
  next.centre = centre && catalog.locations[centre] ? centre : null;
  Object.assign(state, next);
}

function parseWho(value) {
  return WHO_OPTIONS.some((option) => option.id === value) ? value : null;
}

// Links made before "Who's going?" carried an exact age as `age=`; map it to its band.
function whoForAge(value) {
  if (value === null || value === '') return null;
  const age = Number(value);
  if (!Number.isInteger(age) || age < 0 || age > 120) return null;
  if (age >= 60) return 'older';
  if (age >= 19) return 'adult';
  if (age >= 13) return 'youth';
  return 'child';
}

function readStoredWho() {
  try {
    return parseWho(window.localStorage.getItem(WHO_KEY));
  } catch {
    return null;
  }
}

function storeWho(who) {
  try {
    window.localStorage.setItem(WHO_KEY, who);
  } catch {
    // Storage can be unavailable (private mode); the URL hash still carries the choice.
  }
}

function urlForState() {
  const hash = serializeState();
  return `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`;
}

// A push adds a history entry (changing views); a replace keeps Back meaningful
// while filters are adjusted.
function updateState(changes, { push = false } = {}) {
  Object.assign(state, changes);
  if (push) {
    window.location.hash = serializeState();
  } else {
    history.replaceState(history.state, '', urlForState());
  }
  render();
}

/* ---------- Filtering ---------- */

function whoOption(id) {
  return WHO_OPTIONS.find((option) => option.id === id);
}

function activeWho() {
  return whoOption(state.ignoreAge ? ANYONE : state.who);
}

function fitsAge(session, age) {
  return age === null || session.ageRanges.some(([ageMin, ageMax]) =>
    (ageMin === null || age >= ageMin) && (ageMax === null || age <= ageMax));
}

function fitsWho(session) {
  return fitsAge(session, whoOption(state.who).age);
}

function selectedActivityIds() {
  if (state.category === ALL_CATEGORIES) return [...catalog.activityById.keys()];
  const groups = catalog.groupsByCategory.get(state.category) || new Map();
  const ids = [];
  for (const [groupName, activityIds] of groups) {
    if (state.groups.size === 0 || state.groups.has(groupName)) ids.push(...activityIds);
  }
  return ids;
}

function categoryGroups() {
  if (state.category === ALL_CATEGORIES) return [];
  return [...(catalog.groupsByCategory.get(state.category) || new Map()).keys()].sort();
}

// Returns [from, to): a session matches when it ends after `from` and starts before `to`.
function timeWindow() {
  const today = todayOf(now);
  const dayStart = (day) => day * MINUTES_PER_DAY;
  switch (state.when) {
    case 'today':
      return [now, dayStart(today + 1)];
    case 'tomorrow':
      return [dayStart(today + 1), dayStart(today + 2)];
    case 'weekend': {
      const weekday = weekdayOf(today);
      const saturday = weekday === 0 ? today - 1 : today + (6 - weekday);
      return [Math.max(now, dayStart(saturday)), dayStart(saturday + 2)];
    }
    case 'date': {
      const day = state.date ? dayNumber(state.date) : today;
      return [Math.max(now, dayStart(day)), dayStart(day + 1)];
    }
    default:
      return [now, now + SOON_WINDOW_MINUTES + 1];
  }
}

function lowerBoundByStart(sessions, minute) {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sessions[middle].start < minute) low = middle + 1;
    else high = middle;
  }
  return low;
}

function passesPlaceAndTimeFilters(session) {
  if (state.timeOfDay && state.when !== 'now') {
    const range = TIME_OF_DAY[state.timeOfDay];
    const minuteOfDay = session.start - session.day * MINUTES_PER_DAY;
    if (minuteOfDay < range.from || minuteOfDay >= range.to) return false;
  }
  if (state.district && catalog.locations[session.locationId].district !== state.district) return false;
  return true;
}

// Sessions that pass every filter except age are counted, so the list can say
// how many are hidden for being meant for other ages.
function findMatches() {
  const [from, to] = timeWindow();
  const result = { matches: [], hiddenByAge: 0 };
  if (to <= from) return result;
  const age = activeWho().age;
  for (const activityId of selectedActivityIds()) {
    const sessions = catalog.sessionsByActivity.get(activityId) || [];
    // Sessions that started before `from` may still be running, so look back
    // by the longest session length.
    for (let i = lowerBoundByStart(sessions, from - catalog.longestSession); i < sessions.length; i++) {
      const session = sessions[i];
      if (session.start >= to) break;
      if (session.end <= from || !passesPlaceAndTimeFilters(session)) continue;
      if (fitsAge(session, age)) result.matches.push(session);
      else result.hiddenByAge++;
    }
  }
  sortSessions(result.matches);
  return result;
}

// Sessions already running come first. Among those, the most recently started
// lead, so all-day open-hours blocks (weight rooms, tracks) do not crowd the top.
function sortSessions(sessions) {
  const byStart = (a, b) => (a.start <= now ? b.start - a.start : a.start - b.start);
  const byDistance = (a, b) => distanceTo(a.locationId) - distanceTo(b.locationId);
  const useDistance = isSortingByDistance();
  return sessions.sort((a, b) => Number(b.start <= now) - Number(a.start <= now)
    || (useDistance ? byDistance(a, b) : 0)
    || byStart(a, b));
}

// Up to OPEN_NOW_LIMIT running drop-ins at different centres, closest first.
// Ties go to the one with more time left.
function findOpenNowSessions() {
  const running = [];
  const sessions = catalog.sessions;
  for (let i = lowerBoundByStart(sessions, now - catalog.longestSession); i < sessions.length; i++) {
    const session = sessions[i];
    if (session.start > now) break;
    if (session.end > now && session.end - session.start <= OPEN_HOURS_BLOCK_MINUTES && fitsWho(session)) {
      running.push(session);
    }
  }
  const useDistance = Boolean(referencePoint());
  running.sort((a, b) => (useDistance ? distanceTo(a.locationId) - distanceTo(b.locationId) : 0)
    || b.end - a.end);
  const seenCentres = new Set();
  return running.filter((session) => {
    if (seenCentres.has(session.locationId)) return false;
    seenCentres.add(session.locationId);
    return true;
  }).slice(0, OPEN_NOW_LIMIT);
}

// For each category (and for all of them): sessions open now, sessions later
// today, and the start of the next one after today, all for the chosen ages.
function summarizeCategories() {
  const tomorrowStart = (todayOf(now) + 1) * MINUTES_PER_DAY;
  const summaries = new Map();
  const summaryOf = (key) => {
    if (!summaries.has(key)) summaries.set(key, { open: 0, laterToday: 0, nextStart: null, forChosenAges: 0 });
    return summaries.get(key);
  };
  const sessions = catalog.sessions;
  for (let i = lowerBoundByStart(sessions, now - catalog.longestSession); i < sessions.length; i++) {
    const session = sessions[i];
    if (session.end <= now) continue;
    const category = catalog.activityById.get(session.activityId).category;
    const fits = fitsWho(session);
    for (const summary of [summaryOf(category), summaryOf(ALL_CATEGORIES)]) {
      if (!fits) continue;
      summary.forChosenAges++;
      if (session.start <= now) summary.open++;
      else if (session.start < tomorrowStart) summary.laterToday++;
      else if (summary.nextStart === null) summary.nextStart = session.start;
    }
  }
  return summaries;
}

/* ---------- Location ---------- */

const distanceCache = new Map();
let distanceCacheKey = '';

// "Use my current location" uses the device position; otherwise a chosen starting
// point wins over a position that was only fetched quietly from a remembered permission.
function referencePoint() {
  if (state.near && userPosition) return userPosition;
  return state.origin || userPosition;
}

function isSortingByDistance() {
  return Boolean((state.near && userPosition) || state.origin);
}

function startingPointLabel() {
  if (state.near && userPosition) return 'your current location';
  return state.origin ? state.origin.label : '';
}

function distanceTo(locationId) {
  const point = referencePoint();
  if (!point) return Infinity;
  const pointKey = `${point.lat},${point.lng}`;
  if (pointKey !== distanceCacheKey) {
    distanceCache.clear();
    distanceCacheKey = pointKey;
  }
  if (distanceCache.has(locationId)) return distanceCache.get(locationId);
  const location = catalog.locations[locationId];
  const distance = location && location.lat !== null && location.lng !== null
    ? haversineKm(point, location)
    : Infinity;
  distanceCache.set(locationId, distance);
  return distance;
}

function haversineKm(a, b) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function formatDistance(locationId) {
  const distance = distanceTo(locationId);
  if (!Number.isFinite(distance)) return '';
  return distance < 10 ? `${distance.toFixed(1)} km` : `${Math.round(distance)} km`;
}

function readGeoPreference() {
  try {
    return window.localStorage.getItem(GEO_PREF_KEY);
  } catch {
    return null;
  }
}

function writeGeoPreference(value) {
  try {
    window.localStorage.setItem(GEO_PREF_KEY, value);
  } catch {
    // Storage can be unavailable (private mode); the choice is simply not remembered.
  }
}

function restoreLocationPermission() {
  const preference = readGeoPreference();
  if (preference === 'granted' || (state.near && preference !== 'denied')) {
    requestPosition({ quiet: !state.near });
  } else if (state.near) {
    geoMessage = 'Location off. Sorted by start time.';
  }
}

function requestPosition({ quiet = false } = {}) {
  if (!('geolocation' in navigator)) {
    geoMessage = 'Location unavailable. Enter a place instead.';
    updateState({ near: false });
    return;
  }
  if (!quiet) {
    geoMessage = 'Finding your location…';
    renderGeoStatus();
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      userPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
      writeGeoPreference('granted');
      geoMessage = '';
      lastMapFitKey = '';
      if (state.near && state.origin) {
        storeOrigin(null);
        updateState({ origin: null });
      } else {
        render();
      }
      if (!quiet) finishLocationPick();
    },
    (error) => {
      if (error.code === error.PERMISSION_DENIED) writeGeoPreference('denied');
      if (!quiet) {
        geoMessage = 'Location blocked. Enter a place instead.';
      }
      updateState({ near: false });
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
  );
}

/* ---------- Starting point ---------- */

function isInToronto({ lat, lng }) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= TORONTO_BOUNDS.south && lat <= TORONTO_BOUNDS.north
    && lng >= TORONTO_BOUNDS.west && lng <= TORONTO_BOUNDS.east;
}

function centreOrigin(locationId) {
  const location = catalog.locations[locationId];
  if (!location || location.lat === null || location.lng === null) return null;
  return { kind: 'centre', locationId, lat: location.lat, lng: location.lng, label: location.name };
}

function placeOrigin(lat, lng, label) {
  return { kind: 'place', lat, lng, label: label.slice(0, ORIGIN_LABEL_MAX_LENGTH) };
}

// The same two strings are used in the URL hash and in storage.
function originParams(origin) {
  if (origin.kind === 'centre') return { from: `centre:${origin.locationId}`, name: '' };
  return { from: `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}`, name: origin.label };
}

function parseOrigin(from, name) {
  if (!from) return null;
  if (from.startsWith('centre:')) return centreOrigin(from.slice('centre:'.length));
  const [lat, lng] = from.split(',').map(Number);
  if (!name || !isInToronto({ lat, lng })) return null;
  return placeOrigin(lat, lng, name.trim());
}

function readStoredOrigin() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(ORIGIN_KEY));
    return saved ? parseOrigin(saved.from, saved.name) : null;
  } catch {
    return null;
  }
}

function storeOrigin(origin) {
  try {
    if (origin) window.localStorage.setItem(ORIGIN_KEY, JSON.stringify(originParams(origin)));
    else window.localStorage.removeItem(ORIGIN_KEY);
  } catch {
    // Storage can be unavailable (private mode); the URL hash still carries the choice.
  }
}

function setOrigin(origin) {
  storeOrigin(origin);
  geoMessage = '';
  lastMapFitKey = '';
  updateState({ origin, near: false });
  elements.originStatus.textContent = `Starting from ${origin.label}.`;
  finishLocationPick();
}

// Opened from Home's "Change" button, the sheet is only a location picker,
// so it closes as soon as a place is chosen.
function finishLocationPick() {
  if (elements.filtersSheet.open && elements.filtersSheet.dataset.mode === 'location') {
    elements.filtersSheet.close();
  }
}

async function submitOriginSearch() {
  if (geocodeBusy) return;
  const query = elements.originInput.value.trim().replace(/\s+/g, ' ');
  if (!query) {
    elements.originStatus.textContent = 'Enter a place first.';
    return;
  }
  geocodeBusy = true;
  elements.originStatus.textContent = 'Looking up…';
  const postalCode = query.match(POSTAL_CODE_PATTERN);
  try {
    const origin = postalCode
      ? locatePostalCode(postalCode[1].toUpperCase(), (postalCode[2] || '').toUpperCase())
      : await locatePlace(query);
    if (origin) {
      elements.originInput.value = '';
      setOrigin(origin);
    } else {
      elements.originStatus.textContent = postalCode
        ? `${query.toUpperCase()} not found. Try an intersection.`
        : 'Place not found. Try a main intersection.';
    }
  } catch (error) {
    console.warn('Place lookup failed.', error);
    elements.originStatus.textContent = 'Lookup failed. Pick a centre.';
  } finally {
    geocodeBusy = false;
  }
}

// OpenStreetMap has almost no Canadian postal codes, so a postal code is placed
// using the centres that share it: an exact match first, then the average of the
// centres in the same forward sortation area (its first three characters).
function locatePostalCode(area, localUnit) {
  const label = localUnit ? `${area} ${localUnit}` : area;
  const centres = Object.values(catalog.locations)
    .filter((location) => location.postal && location.lat !== null && location.lng !== null);
  const normalize = (postal) => postal.replace(/\s/g, '').toUpperCase();
  const exact = localUnit && centres.find((location) => normalize(location.postal) === area + localUnit);
  if (exact) return placeOrigin(exact.lat, exact.lng, label);
  const sameArea = centres.filter((location) => normalize(location.postal).startsWith(area));
  if (!sameArea.length) return null;
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return placeOrigin(
    average(sameArea.map((location) => location.lat)),
    average(sameArea.map((location) => location.lng)),
    label,
  );
}

// Nominatim matches intersections far more reliably when they are written with "&".
async function locatePlace(query) {
  const point = await geocode(query.replace(/\s+(?:and|at|@|\/)\s+/gi, ' & '));
  return point && placeOrigin(point.lat, point.lng, query);
}

async function geocode(query) {
  const cacheKey = query.toLowerCase();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);
  const waitMs = lastGeocodeAt + GEOCODE_MIN_INTERVAL_MS - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastGeocodeAt = Date.now();
  const { west, north, east, south } = TORONTO_BOUNDS;
  const params = new URLSearchParams({
    format: 'json', countrycodes: 'ca', viewbox: `${west},${north},${east},${south}`, bounded: '1', limit: '1', q: query,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const response = await fetch(`${NOMINATIM_URL}?${params}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Nominatim returned ${response.status}`);
    const [first] = await response.json();
    const point = first ? { lat: Number(first.lat), lng: Number(first.lon) } : null;
    const result = point && isInToronto(point) ? point : null;
    geocodeCache.set(cacheKey, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Rendering helpers ---------- */

function render() {
  if (!catalog) return;
  const savedFocus = captureFocus();
  const onResults = state.category !== null;
  elements.homeView.hidden = onResults;
  elements.resultsView.hidden = !onResults;
  if (onResults) renderResults();
  else renderHome();
  renderFiltersSheet();
  renderCentreSheet();
  restoreFocus(savedFocus);
}

const REBUILT_CONTAINERS = '#home-who-chips, #open-now-list, #category-grid, #search-results, #group-row, '
  + '#when-chips, #age-notice, #results-list, #origin-current, #sheet-who-chips, #activity-checks, '
  + '#tod-chips, #sheet-body';
const renderedHtml = new WeakMap();

// Skipping identical rewrites keeps focus and scroll position in unchanged parts.
function setHtml(element, html) {
  if (renderedHtml.get(element) === html) return;
  renderedHtml.set(element, html);
  element.innerHTML = html;
}

function focusSignature(element) {
  const { action, value, category, key } = element.dataset;
  return [element.tagName, action, value, category, key, element.getAttribute('href')].join('|');
}

function twinsOf(container, signature) {
  return [...container.querySelectorAll('a[href], button, input')]
    .filter((element) => focusSignature(element) === signature);
}

// Rebuilding a container's HTML drops the focused control; remember which one it
// was (and which repeat, for buttons shared by several cards) to focus its replacement.
function captureFocus() {
  const active = document.activeElement;
  const container = active && active !== document.body ? active.closest(REBUILT_CONTAINERS) : null;
  if (!container) return null;
  const signature = focusSignature(active);
  return { active, container, signature, occurrence: twinsOf(container, signature).indexOf(active) };
}

function restoreFocus(saved) {
  if (!saved || saved.active.isConnected) return;
  const twins = twinsOf(saved.container, saved.signature);
  const replacement = twins[Math.min(saved.occurrence, twins.length - 1)];
  if (replacement) replacement.focus({ preventScroll: true });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count.toLocaleString('en-CA')} ${count === 1 ? singular : plural}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "Weight/Cardio Room" becomes "weight/cardio room"; all-capital words such as "BMX" stay.
function toSentenceCase(text) {
  return capitalize(text.replace(/\b([A-Z])([a-z]+)/g, (word, first, rest) => first.toLowerCase() + rest));
}

function iconHtml(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

function chipHtml(label, pressed, action, value = '', { disabled = false, hiddenLabel = '' } = {}) {
  return `<button type="button" class="chip" aria-pressed="${pressed}" data-action="${action}" data-value="${escapeHtml(value)}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}${hiddenLabel ? `<span class="visually-hidden">${escapeHtml(hiddenLabel)}</span>` : ''}</button>`;
}

function whoChipsHtml() {
  return WHO_OPTIONS.map((option) => chipHtml(option.label, state.who === option.id, 'set-who', option.id,
    { hiddenLabel: option.hiddenLabel })).join('');
}

function setPressed(button, pressed) {
  button.setAttribute('aria-pressed', String(pressed));
}

function statusHtml(session, { short = false } = {}) {
  const status = describeStatus(session);
  const mark = status.kind === 'later' ? '' : '<span class="status-mark" aria-hidden="true"></span>';
  return `<span class="status status-${status.kind}">${mark}${escapeHtml(short ? status.shortText : status.text)}</span>`;
}

function ageRangeLabel([ageMin, ageMax]) {
  const hasMin = ageMin !== null && ageMin > 0;
  const hasMax = ageMax !== null && ageMax < OPEN_ENDED_AGE;
  if (hasMin && hasMax) return `${ageMin}–${ageMax}`;
  if (hasMin) return `${ageMin} and up`;
  if (hasMax) return `${ageMax} and under`;
  return null;
}

function ageLabel(session) {
  const labels = session.ageRanges.map(ageRangeLabel);
  if (labels.includes(null)) return 'All ages';
  return `Ages ${[...new Set(labels)].join(', ')}`;
}

// Names the one band a session is meant for, such as "Youth only, ages 13–18".
function otherAgesLabel(session) {
  const bands = WHO_OPTIONS.filter((option) => option.age !== null && fitsAge(session, option.age));
  const ages = ageLabel(session);
  if (bands.length !== 1) return ages;
  return `${capitalize(bands[0].audience)} only, ${ages.charAt(0).toLowerCase()}${ages.slice(1)}`;
}

function shortCentreName(name) {
  return CENTRE_NAME_ABBREVIATIONS.reduce((short, [pattern, replacement]) => short.replace(pattern, replacement), name);
}

function directionsUrl(location) {
  const destination = location.lat !== null && location.lng !== null
    ? `${location.lat},${location.lng}`
    : `${location.address}, Toronto, ON ${location.postal || ''}`.trim();
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

function directionsIconLinkHtml(location) {
  return `<a class="directions-link" href="${escapeHtml(directionsUrl(location))}" target="_blank" rel="noopener"
    aria-label="Directions to ${escapeHtml(location.name)}">${iconHtml('directions')}</a>`;
}

/* ---------- Home ---------- */

function renderHome() {
  document.title = 'Rec Finder Toronto';
  renderStartCard();
  setHtml(elements.homeWhoChips, whoChipsHtml());
  renderOpenNow();
  renderCategoryTiles();
}

function renderStartCard() {
  const label = startingPointLabel();
  elements.startLabel.innerHTML = label
    ? `Near <strong>${escapeHtml(label)}</strong>`
    : 'No location set.';
  elements.changeOrigin.textContent = label ? 'Change' : 'Set your location';
  if (label) elements.changeOrigin.setAttribute('aria-label', 'Change starting point');
  else elements.changeOrigin.removeAttribute('aria-label');
}

function renderOpenNow() {
  elements.openNowTitle.textContent = referencePoint() ? 'Open now near you' : 'Open now';
  const sessions = findOpenNowSessions();
  const audience = whoOption(state.who).audience;
  setHtml(elements.openNowList, sessions.length
    ? sessions.map(openNowRowHtml).join('')
    : `<li class="open-now-empty">Nothing open${audience ? ` for ${escapeHtml(audience)}` : ' now'}.</li>`);
}

function openNowRowHtml(session) {
  const activity = catalog.activityById.get(session.activityId);
  const location = catalog.locations[session.locationId];
  const distance = formatDistance(session.locationId);
  return `
    <li>
      <button type="button" class="open-now-row" data-action="open-centre" data-value="${escapeHtml(session.locationId)}">
        <span class="status-mark status-open" aria-hidden="true"></span>
        <span class="open-now-text">
          <span class="open-now-activity">${escapeHtml(activity.name)}</span>
          <span class="open-now-meta"><span aria-hidden="true">${escapeHtml(shortCentreName(location.name))}</span><span class="visually-hidden">${escapeHtml(location.name)}</span>${distance ? ` · ${distance}` : ''}</span>
        </span>
        <span class="status status-open open-now-until">Open until ${formatClock(session.end)}</span>
      </button>
    </li>`;
}

function renderCategoryTiles() {
  const summaries = summarizeCategories();
  const tiles = [...catalog.categories, { id: ALL_CATEGORIES, label: 'Everything', icon: 'all' }]
    .filter((category) => summaries.has(category.id));
  setHtml(elements.categoryGrid, tiles.map((category) => `
      <button type="button" class="tile" data-action="pick-category" data-category="${escapeHtml(category.id)}">
        ${iconHtml(category.icon, 'icon tile-icon')}
        <span class="tile-label">${escapeHtml(category.label)}</span>
        ${tileCountHtml(summaries.get(category.id))}
      </button>`).join(''));
}

function tileCountHtml(summary) {
  if (summary.open) {
    return `<span class="tile-count status status-open"><span class="status-mark" aria-hidden="true"></span>${summary.open.toLocaleString('en-CA')} open now</span>`;
  }
  if (summary.laterToday) return `<span class="tile-count">${summary.laterToday.toLocaleString('en-CA')} later today</span>`;
  if (summary.nextStart !== null) {
    return `<span class="tile-count">Next: ${formatWeekday(todayOf(summary.nextStart))} ${formatClock(summary.nextStart)}</span>`;
  }
  return `<span class="tile-count">None for ${escapeHtml(whoOption(state.who).audience)}</span>`;
}

function renderSearchResults() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) {
    elements.searchResults.hidden = true;
    elements.searchResults.innerHTML = '';
    return;
  }
  const matches = catalog.searchEntries
    .filter((entry) => terms.every((term) => entry.text.includes(term)))
    .slice(0, 8);
  elements.searchResults.hidden = false;
  elements.searchResults.innerHTML = matches.length
    ? matches.map((entry) => `
      <li>
        <button type="button" class="search-match" data-action="search-pick" data-key="${escapeHtml(entry.key)}">
          ${iconHtml(entry.icon)}
          <span><span class="search-label">${escapeHtml(entry.label)}</span>
          <span class="search-detail">${escapeHtml(entry.kind === 'location' ? `Centre · ${entry.detail}` : entry.detail)}</span></span>
        </button>
      </li>`).join('')
    : '<li class="search-empty">No matches.</li>';
}

/* ---------- Results ---------- */

function renderResults() {
  const filterKey = serializeFilterKey();
  if (filterKey !== lastFilterKey) {
    renderedCount = PAGE_SIZE;
    lastFilterKey = filterKey;
  }
  const { matches, hiddenByAge } = findMatches();
  currentMatches = matches;
  hiddenByAgeCount = hiddenByAge;
  centreNumbers = numberCentres(matches);
  renderResultsHeader();
  renderResultSummary();
  renderResultList();
  renderMap();
}

function serializeFilterKey() {
  return JSON.stringify([state.category, [...state.groups], state.when, state.date, state.timeOfDay,
    state.who, state.ignoreAge, state.district, state.near, state.origin && originParams(state.origin),
    state.byCentre]);
}

function numberCentres(sessions) {
  const numbers = new Map();
  for (const session of sessions) {
    if (!numbers.has(session.locationId)) numbers.set(session.locationId, numbers.size + 1);
  }
  return numbers;
}

// Filters that narrow the results; grouping only changes how they are shown.
function narrowingFilterCount() {
  return [state.who !== ANYONE, state.groups.size > 0, state.timeOfDay && state.when !== 'now', state.district]
    .filter(Boolean).length;
}

function renderResultsHeader() {
  const category = catalog.categoryById.get(state.category);
  const label = category ? category.label : 'Everything';
  setHtml(elements.resultsTitle, `${iconHtml(category ? category.icon : 'all')}<span>${escapeHtml(label)}</span>`);
  document.title = `${label} · Rec Finder Toronto`;

  const groups = categoryGroups();
  elements.groupRow.hidden = groups.length < 2;
  setHtml(elements.groupRow, [
    chipHtml('All', state.groups.size === 0, 'all-groups'),
    ...groups.map((group) => chipHtml(group, state.groups.has(group), 'toggle-group', group)),
  ].join(''));

  setHtml(elements.whenChips, WHEN_OPTIONS
    .map(([value, whenLabel]) => chipHtml(whenLabel, state.when === value, 'set-when', value)).join(''));
  elements.dateLabel.hidden = state.when !== 'date';
  elements.dateInput.value = state.date;

  const activeCount = narrowingFilterCount() + Number(state.byCentre);
  elements.filterBadge.hidden = activeCount === 0;
  elements.filterBadge.innerHTML = activeCount ? `${activeCount}<span class="visually-hidden"> active</span>` : '';

  setPressed(elements.listModeButton, !state.showMap);
  setPressed(elements.mapModeButton, state.showMap);
  elements.resultsView.dataset.mode = state.showMap ? 'map' : 'list';
}

function resultCount() {
  return state.byCentre ? centreNumbers.size : currentMatches.length;
}

function renderResultSummary() {
  const audience = activeWho().audience;
  const placeLabel = startingPointLabel();
  const place = placeLabel === 'your current location'
    ? ' Closest to you.'
    : placeLabel ? ` Closest to ${escapeHtml(placeLabel)}.` : ' Soonest first.';
  elements.resultSummary.innerHTML = `<strong>${pluralize(resultCount(), state.byCentre ? 'centre' : 'session')}</strong>`
    + `${audience ? ` for ${escapeHtml(audience)}` : ''}.${place}`;

  let notice = '';
  if (state.ignoreAge) {
    notice = `Showing all ages. <button type="button" class="link-button" data-action="hide-other-ages">${escapeHtml(capitalize(whoOption(state.who).audience))} only</button>`;
  } else if (hiddenByAgeCount) {
    notice = `${pluralize(hiddenByAgeCount, 'session')} for other ages hidden. `
      + '<button type="button" class="link-button" data-action="show-other-ages">Show<span class="visually-hidden"> all ages</span></button>';
  }
  setHtml(elements.ageNotice, notice ? `<p>${notice}</p>` : '');
  elements.ageNotice.hidden = !notice;
}

function renderResultList() {
  const items = state.byCentre ? groupMatchesByCentre(currentMatches) : currentMatches;
  const visible = items.slice(0, renderedCount);
  const showsActivity = new Set(currentMatches.map((session) => session.activityId)).size > 1;
  const cardHtml = state.byCentre ? centreCardHtml : (session) => sessionCardHtml(session, showsActivity);
  setHtml(elements.resultsList, visible.length ? visible.map(cardHtml).join('') : emptyStateHtml());
  elements.resultsList.classList.toggle('shows-pin-numbers', isMapVisible());
  elements.showMore.hidden = items.length <= renderedCount;
  elements.showMore.textContent = `Show more (${(items.length - renderedCount).toLocaleString('en-CA')} left)`;
}

function emptyStateHtml() {
  const button = (action, value, label) =>
    `<button type="button" class="button" data-action="${action}" data-value="${value}">${label}</button>`;
  const today = todayOf(now);
  const lastDay = catalog.sessions.length ? catalog.sessions[catalog.sessions.length - 1].day : today;
  const pickedDay = state.when === 'date' && state.date ? dayNumber(state.date) : null;
  let message = 'No matches.';
  const actions = [];
  if (pickedDay !== null && pickedDay < today) {
    message = 'That date has passed.';
    actions.push(button('set-when', 'today', 'Later today'));
  } else if (pickedDay !== null && pickedDay > lastDay) {
    message = `Schedule ends ${escapeHtml(formatShortDate(lastDay))}.`;
  } else {
    if (narrowingFilterCount()) actions.push(button('reset-filters', '', 'Clear filters'));
    if (state.when === 'now') actions.push(button('set-when', 'today', 'Later today'));
    if (state.when === 'now' || state.when === 'today') actions.push(button('set-when', 'tomorrow', 'Tomorrow'));
  }
  return `<div class="empty"><p>${message}</p><div class="empty-actions">${actions.join(' ')}</div></div>`;
}

function groupMatchesByCentre(sessions) {
  const centres = new Map();
  for (const session of sessions) {
    if (!centres.has(session.locationId)) centres.set(session.locationId, { locationId: session.locationId, sessions: [] });
    centres.get(session.locationId).sessions.push(session);
  }
  return [...centres.values()];
}

function pinNumberHtml(locationId) {
  return `<span class="pin-number"><span class="visually-hidden">Map pin </span>${centreNumbers.get(locationId)}</span>`;
}

function sessionCardHtml(session, showsActivity) {
  const activity = catalog.activityById.get(session.activityId);
  const location = catalog.locations[session.locationId];
  const meta = [formatDistance(session.locationId), ageLabel(session)].filter(Boolean).join(' · ');
  return `
    <article class="card">
      <button type="button" class="card-main" data-action="open-centre" data-value="${escapeHtml(session.locationId)}">
        <span class="card-time">
          <span class="time-start">${formatClock(session.start)}</span>
          <span class="time-end">to ${formatClock(session.end)}</span>
        </span>
        <span class="card-text">
          <span class="card-centre">${pinNumberHtml(session.locationId)}${escapeHtml(location.name)}</span>
          ${showsActivity ? `<span class="card-activity">${escapeHtml(activity.name)}</span>` : ''}
          <span class="card-meta">${escapeHtml(meta)}</span>
          ${statusHtml(session)}
        </span>
      </button>
      ${directionsIconLinkHtml(location)}
    </article>`;
}

function centreCardHtml({ locationId, sessions }) {
  const location = catalog.locations[locationId];
  const meta = [formatDistance(locationId), location.address].filter(Boolean).join(' · ');
  const preview = sessions.slice(0, CENTRE_PREVIEW_COUNT);
  const remaining = sessions.length - preview.length;
  return `
    <article class="card card-grouped">
      <div class="card-grouped-head">
        <button type="button" class="card-main" data-action="open-centre" data-value="${escapeHtml(locationId)}">
          <span class="card-text">
            <span class="card-centre">${pinNumberHtml(locationId)}${escapeHtml(location.name)}</span>
            <span class="card-meta">${escapeHtml(meta)}</span>
          </span>
        </button>
        ${directionsIconLinkHtml(location)}
      </div>
      <ul class="session-rows">
        ${preview.map((session) => `
          <li class="session-row">
            <span class="session-row-time">${formatClock(session.start)}</span>
            <span class="session-row-activity">${escapeHtml(catalog.activityById.get(session.activityId).name)}</span>
            ${statusHtml(session, { short: true })}
          </li>`).join('')}
      </ul>
      ${remaining > 0 ? `<p class="card-more">+ ${pluralize(remaining, 'more session')}</p>` : ''}
    </article>`;
}

/* ---------- Map ---------- */

function isMapVisible() {
  return state.category !== null && (desktopQuery.matches || state.showMap);
}

function ensureMap() {
  if (map) return true;
  if (!window.L) {
    elements.mapFallback.hidden = false;
    return false;
  }
  map = window.L.map(elements.map, { zoomControl: true }).setView([43.7, -79.4], 11);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  markerLayer = window.L.layerGroup().addTo(map);
  return true;
}

// Open-now pins are filled and later pins are hollow rings, so the two differ
// by shape as well as colour. Each pin carries the centre's number in the list.
function centreMarker(locationId, sessions) {
  const location = catalog.locations[locationId];
  const number = centreNumbers.get(locationId);
  const isOpen = sessions.some(isRunning);
  const label = `${number}. ${location.name}${isOpen ? ', open now' : ''}`;
  const marker = window.L.marker([location.lat, location.lng], {
    title: label,
    keyboard: true,
    icon: window.L.divIcon({
      className: 'pin-icon',
      html: `<span class="pin ${isOpen ? 'pin-open' : 'pin-later'}">${number}</span>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -14],
    }),
  });
  marker.bindPopup(() => mapPopupElement(locationId, sessions));
  marker.on('add', () => marker.getElement().setAttribute('aria-label', label));
  return marker;
}

function renderMap() {
  if (!isMapVisible() || !ensureMap()) return;
  map.invalidateSize();
  markerLayer.clearLayers();
  const points = [];
  for (const { locationId, sessions } of groupMatchesByCentre(currentMatches)) {
    const location = catalog.locations[locationId];
    if (location.lat === null || location.lng === null) continue;
    centreMarker(locationId, sessions).addTo(markerLayer);
    points.push([location.lat, location.lng]);
  }
  const point = referencePoint();
  if (point) {
    const tooltip = point === userPosition ? 'You are here' : `Starting point: ${escapeHtml(point.label)}`;
    window.L.circleMarker([point.lat, point.lng], {
      radius: 7, weight: 3, color: '#ffffff', fillColor: '#c2255c', fillOpacity: 1,
    }).bindTooltip(tooltip).addTo(markerLayer);
  }
  // Wait a frame so a just-revealed container has its final size before fitting.
  requestAnimationFrame(() => {
    map.invalidateSize();
    fitMapOnce(points);
  });
}

// Refit only when the filters change, so panning is not undone by a refresh.
function fitMapOnce(points) {
  const fitKey = `${lastFilterKey}|${points.length}`;
  if (fitKey === lastMapFitKey || !points.length) return;
  lastMapFitKey = fitKey;
  map.fitBounds(points, { padding: [32, 32], maxZoom: 14 });
}

function mapPopupElement(locationId, sessions) {
  const location = catalog.locations[locationId];
  const container = document.createElement('div');
  container.className = 'map-popup';
  container.innerHTML = `
    <strong>${centreNumbers.get(locationId)}. ${escapeHtml(location.name)}</strong>
    <p>${pluralize(sessions.length, 'matching session')}</p>
    <p>${escapeHtml(catalog.activityById.get(sessions[0].activityId).name)}: ${statusHtml(sessions[0])}</p>
    <button type="button" class="button button-small" data-action="open-centre" data-value="${escapeHtml(locationId)}">Centre details</button>`;
  return container;
}

/* ---------- Filters sheet ---------- */

function renderFiltersSheet() {
  if (!elements.filtersSheet.open) return;
  renderOriginControls();
  setHtml(elements.sheetWhoChips, whoChipsHtml());

  const groups = categoryGroups();
  elements.activityFieldset.hidden = groups.length < 2;
  setHtml(elements.activityChecks, groups.map((group) => `
    <label class="check">
      <input type="checkbox" data-value="${escapeHtml(group)}"${state.groups.size === 0 || state.groups.has(group) ? ' checked' : ''}>
      <span>${escapeHtml(group)}</span>
    </label>`).join(''));

  const timeOfDayApplies = state.when !== 'now';
  setHtml(elements.todChips, [
    chipHtml('Any time', !state.timeOfDay, 'set-tod', '', { disabled: !timeOfDayApplies }),
    ...Object.entries(TIME_OF_DAY).map(([value, range]) =>
      chipHtml(range.label, state.timeOfDay === value, 'set-tod', value, { disabled: !timeOfDayApplies })),
  ].join(''));
  elements.todNote.hidden = timeOfDayApplies;

  elements.districtSelect.value = state.district;
  elements.byCentreSwitch.checked = state.byCentre;
  elements.applyFilters.textContent = elements.filtersSheet.dataset.mode === 'location'
    ? 'Done'
    : `Show ${pluralize(currentMatches.length, 'session')}`;
}

function renderOriginControls() {
  const label = startingPointLabel();
  setHtml(elements.originCurrent, label
    ? `<span>Starting from <strong>${escapeHtml(label)}</strong>.</span>
      <button type="button" class="link-button" data-action="clear-origin">Clear<span class="visually-hidden"> starting point</span></button>`
    : '<span>None set. Sorted by time.</span>');
  renderGeoStatus();
}

function renderGeoStatus() {
  if (elements.geoStatus.textContent !== geoMessage) elements.geoStatus.textContent = geoMessage;
  elements.geoStatus.hidden = !geoMessage;
}

function openFiltersSheet(mode) {
  const sheet = elements.filtersSheet;
  sheet.dataset.mode = mode;
  elements.filtersTitle.textContent = mode === 'location' ? 'Starting point' : 'Filters';
  elements.originStatus.textContent = '';
  history.pushState({ sheet: 'filters' }, '', window.location.href);
  filtersEntryPushed = true;
  sheet.showModal();
  render();
  elements.filtersTitle.focus();
}

function handleFiltersSheetClosed() {
  if (filtersEntryPushed) history.back();
}

// Back from the sheet's history entry lands on the URL saved before the sheet
// opened; replace it with the current state so changes made in the sheet stay.
function handlePopState() {
  if (!filtersEntryPushed) return;
  filtersEntryPushed = false;
  history.replaceState(null, '', urlForState());
  if (elements.filtersSheet.open) elements.filtersSheet.close();
}

function resetFilters() {
  storeWho(ANYONE);
  updateState({ who: ANYONE, ignoreAge: false, groups: new Set(), timeOfDay: '', district: '', byCentre: false });
}

// A checkbox list where every box is ticked means no activity filter; unticking
// the last box also returns to every activity rather than to an empty list.
function applyActivityChecks() {
  const boxes = [...elements.activityChecks.querySelectorAll('input[type="checkbox"]')];
  const checked = boxes.filter((box) => box.checked).map((box) => box.dataset.value);
  const groups = checked.length === boxes.length ? new Set() : new Set(checked);
  updateState({ groups });
}

/* ---------- Centre sheet ---------- */

function renderCentreSheet() {
  const dialog = elements.centreSheet;
  if (!state.centre) {
    if (dialog.open) dialog.close();
    return;
  }
  const location = catalog.locations[state.centre];
  elements.sheetTitle.textContent = location.name;
  elements.sheetSubtitle.textContent = [location.address, location.district].filter(Boolean).join(' · ');
  setHtml(elements.sheetBody, centreDetailsHtml(state.centre, location));
  if (!dialog.open) dialog.showModal();
}

function centreDetailsHtml(locationId, location) {
  const upcoming = (catalog.sessionsByLocation.get(locationId) || []).filter((session) => session.end > now);
  const days = groupBy(upcoming, (session) => session.day);
  return `
    ${centreActionsHtml(locationId, location)}
    ${centreFactsHtml(location)}
    <h3 class="sheet-section">Upcoming drop-ins</h3>
    ${upcoming.length
    ? [...days].map(([day, sessions]) => `
      <section class="schedule-day" aria-label="${escapeHtml(formatDayHeading(day))}">
        <h4 class="day-heading">${escapeHtml(formatDayHeading(day))}</h4>
        <ul class="schedule">${scheduleRowsHtml(sessions)}</ul>
      </section>`).join('')
    : '<p>No upcoming drop-ins.</p>'}`;
}

function centreActionsHtml(locationId, location) {
  const distance = formatDistance(locationId);
  return `
    <div class="sheet-actions">
      <a class="button button-primary" href="${escapeHtml(directionsUrl(location))}" target="_blank" rel="noopener">
        ${iconHtml('directions')}Directions${distance ? ` · ${distance}` : ''}<span class="visually-hidden"> to ${escapeHtml(location.name)}</span></a>
      <a class="button" href="${CITY_PAGE_URL}/${encodeURIComponent(locationId)}/index.html" target="_blank" rel="noopener">
        City page<span class="visually-hidden"> for ${escapeHtml(location.name)}</span></a>
    </div>`;
}

function centreFactsHtml(location) {
  const facts = [
    ['Accessibility', location.accessibility && toSentenceCase(location.accessibility)],
    ['Facilities', (location.facilities || []).length && toSentenceCase(location.facilities.join(', '))],
    ['TTC', location.ttc],
  ].filter(([, value]) => value);
  if (!facts.length) return '';
  return `<dl class="details">${facts.map(([term, value]) =>
    `<div><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
}

// Sessions for the chosen ages come first; the rest follow, greyed and labelled.
function scheduleRowsHtml(sessions) {
  const picked = new Set(state.category ? selectedActivityIds() : []);
  const age = activeWho().age;
  const forChosenAges = sessions.filter((session) => fitsAge(session, age));
  const forOtherAges = sessions.filter((session) => !fitsAge(session, age));
  return [
    ...forChosenAges.map((session) => scheduleRowHtml(session, picked.has(session.activityId), false)),
    ...forOtherAges.map((session) => scheduleRowHtml(session, false, true)),
  ].join('');
}

function scheduleRowHtml(session, isPick, isForOtherAges) {
  const activity = catalog.activityById.get(session.activityId);
  return `
    <li class="schedule-row${isForOtherAges ? ' is-other-ages' : ''}">
      <span class="schedule-time">
        <span class="time-start">${formatClock(session.start)}</span>
        <span class="time-end">to ${formatClock(session.end)}</span>
      </span>
      <span class="schedule-text">
        <span class="schedule-name">${escapeHtml(activity.name)}${isPick ? ' <span class="pick-tag">Your pick</span>' : ''}</span>
        <span class="schedule-ages">${escapeHtml(isForOtherAges ? otherAgesLabel(session) : ageLabel(session))}</span>
        ${isRunning(session) ? statusHtml(session) : ''}
      </span>
    </li>`;
}

/* ---------- Events ---------- */

function populateStaticControls() {
  elements.districtSelect.insertAdjacentHTML('beforeend',
    DISTRICTS.map((district) => `<option value="${escapeHtml(district)}">${escapeHtml(district)}</option>`).join(''));
  const firstDay = todayOf(now);
  const lastDay = catalog.sessions.length ? catalog.sessions[catalog.sessions.length - 1].day : firstDay;
  elements.dateInput.min = isoDateFromDayNumber(firstDay);
  elements.dateInput.max = isoDateFromDayNumber(Math.max(firstDay, lastDay));
  const centres = Object.entries(catalog.locations)
    .filter(([, location]) => location.lat !== null && location.lng !== null)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name, 'en-CA'));
  elements.originCentre.insertAdjacentHTML('beforeend',
    centres.map(([locationId, location]) => `<option value="${escapeHtml(locationId)}">${escapeHtml(location.name)}</option>`).join(''));
}

const actionHandlers = {
  'go-home': () => {
    elements.searchInput.value = '';
    renderSearchResults();
    updateState({ category: null, groups: new Set(), centre: null, ignoreAge: false }, { push: true });
    window.scrollTo(0, 0);
  },
  'pick-category': (button) => openCategory(button.dataset.category),
  'see-all': () => openCategory(ALL_CATEGORIES, { when: 'now' }),
  'search-pick': (button) => pickSearchEntry(button.dataset.key),
  'all-groups': () => updateState({ groups: new Set() }),
  'toggle-group': (button) => {
    const groups = new Set(state.groups);
    if (groups.has(button.dataset.value)) groups.delete(button.dataset.value);
    else groups.add(button.dataset.value);
    updateState({ groups });
  },
  'set-when': (button) => {
    const when = button.dataset.value;
    const date = when === 'date' ? state.date || isoDateFromDayNumber(todayOf(now)) : state.date;
    updateState({ when, date });
    if (when === 'date') elements.dateInput.focus();
  },
  'set-tod': (button) => updateState({ timeOfDay: button.dataset.value }),
  'set-who': (button) => {
    storeWho(button.dataset.value);
    updateState({ who: button.dataset.value, ignoreAge: false });
  },
  'show-other-ages': () => updateState({ ignoreAge: true }),
  'hide-other-ages': () => updateState({ ignoreAge: false }),
  'set-mode': (button) => updateState({ showMap: button.dataset.value === 'map' }),
  'open-filters': () => openFiltersSheet('filters'),
  'open-location': () => openFiltersSheet('location'),
  'close-filters': () => elements.filtersSheet.close(),
  'reset-filters': resetFilters,
  'use-device-location': () => {
    geoMessage = '';
    elements.originStatus.textContent = '';
    if (userPosition) {
      storeOrigin(null);
      lastMapFitKey = '';
      updateState({ near: true, origin: null });
      finishLocationPick();
    } else {
      updateState({ near: true });
      requestPosition();
    }
  },
  'clear-origin': () => {
    storeOrigin(null);
    lastMapFitKey = '';
    geoMessage = '';
    elements.originStatus.textContent = 'Starting point cleared.';
    updateState({ origin: null, near: false });
    elements.originInput.focus();
  },
  'show-more': () => {
    renderedCount += PAGE_SIZE;
    renderResultList();
  },
  'open-centre': (button) => openCentre(button.dataset.value),
  'close-sheet': () => elements.centreSheet.close(),
};

function openCategory(category, { when = state.when } = {}) {
  updateState({ category, when, groups: new Set(), centre: null, ignoreAge: false }, { push: true });
  window.scrollTo(0, 0);
}

// The sheet gets its own history entry so the browser's Back button closes it.
function openCentre(locationId) {
  sheetOpenedByPush = true;
  updateState({ centre: locationId }, { push: true });
}

function closeCentre() {
  if (!state.centre) return;
  if (sheetOpenedByPush) {
    sheetOpenedByPush = false;
    state.centre = null;
    history.back();
  } else {
    updateState({ centre: null });
  }
}

function pickSearchEntry(key) {
  const entry = catalog.searchEntries.find((candidate) => candidate.key === key);
  if (!entry) return;
  if (entry.kind === 'location') {
    openCentre(entry.locationId);
    return;
  }
  updateState({ category: entry.category, groups: new Set([entry.group]), centre: null, ignoreAge: false }, { push: true });
  window.scrollTo(0, 0);
}

function closeOnBackdropClick(dialog) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !actionHandlers[target.dataset.action]) return;
    if (target.tagName === 'A') event.preventDefault();
    actionHandlers[target.dataset.action](target);
  });

  elements.searchInput.addEventListener('input', renderSearchResults);
  elements.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const firstMatch = elements.searchResults.querySelector('[data-action="search-pick"]');
      if (firstMatch) firstMatch.click();
    }
  });

  elements.dateInput.addEventListener('change', () => {
    if (elements.dateInput.value) updateState({ date: elements.dateInput.value });
  });
  elements.activityChecks.addEventListener('change', applyActivityChecks);
  elements.districtSelect.addEventListener('change', () => updateState({ district: elements.districtSelect.value }));
  elements.byCentreSwitch.addEventListener('change', () => updateState({ byCentre: elements.byCentreSwitch.checked }));

  elements.originForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitOriginSearch();
  });
  elements.originCentre.addEventListener('change', () => {
    const origin = centreOrigin(elements.originCentre.value);
    elements.originCentre.value = '';
    if (origin) setOrigin(origin);
  });

  // Closing with Escape, the close button or the backdrop all land here.
  elements.centreSheet.addEventListener('close', closeCentre);
  elements.filtersSheet.addEventListener('close', handleFiltersSheetClosed);
  closeOnBackdropClick(elements.centreSheet);
  closeOnBackdropClick(elements.filtersSheet);

  window.addEventListener('popstate', handlePopState);
  window.addEventListener('hashchange', () => {
    // Our own pushes, and a Back after closing a sheet, already match the state.
    if (window.location.hash.slice(1) === serializeState()) return;
    readStateFromHash();
    if (!state.centre) sheetOpenedByPush = false;
    render();
  });
  desktopQuery.addEventListener('change', () => render());
  document.addEventListener('visibilitychange', refreshNow);
}

function toCamelCase(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
