// The places Invisible Earth can show. Every fact here is from a published source (see `sources`);
// anything the app invents is marked as synthetic in `signal` and in the interface.

// quake: a rupture moves the ground; quake-normal: a small one; flood / volcano: the surface is remade, so the radar reads
// coherence loss rather than motion; subsidence: no event, a slow sinking accumulated pair after pair.
export type SiteKind = 'quake' | 'quake-normal' | 'flood' | 'volcano' | 'subsidence';

export interface Aoi { west: number; south: number; east: number; north: number }
export interface Epicentre { lon: number; lat: number; label: string }
export interface Place { name: string; lat: number; lon: number; kind: 'city' | 'area' | 'peak' | 'note' } // a note is shown on the displacement map only
export interface Source { label: string; url: string }

// Synthetic-signal model parameters (used only until the real GUNW raster is dropped in).
export interface Fault { lon: number; lat: number; strikeDeg: number; lengthKm: number; depthKm: number; slipM: number }
export interface FloodPath { waypoints: [number, number][]; widthKm: [number, number]; source: [number, number]; sourceKm: number }

export interface SiteDef {
  id: 'venezuela' | 'nepal' | 'granada' | 'mexico' | 'krasheninnikov';
  name: string;
  region: string;
  kind: SiteKind;
  headline: string; // one-line event description for the selector card
  stat: { value: string; unit: string; label: string }; // what NISAR saw, as one number (shown on the selector card)
  tag: string; // short label for the timeline's event marker
  aoi: Aoi;
  zoom: number; // Terrarium tile zoom
  date: number; // event day, UTC ms
  eventAt: number; // the event itself (first shock), UTC ms
  epicentres: Epicentre[];
  pair: { ref: string; sec: string; track: string; frame: string; orbit: 'A' | 'D' };
  facts: [string, string][]; // [label, value] pairs for the About panel
  vex: number; // vertical exaggeration of terrain
  liftKm: number; // km of rendered lift per metre of LOS
  range: number; // ± LOS metres mapped onto the displacement colour scale
  look: [number, number, number]; // ground→satellite unit vector, E N U (assumed unless the GUNW says otherwise)
  fault?: Fault;
  flood?: FloodPath;
  places: Place[];
  sources: Source[];
  focus?: { at: [number, number]; scale: Partial<Record<number, number>> }; // a tighter close-up on a small feature: its centre (lon, lat) and per-chapter scale of the framed box
  cams?: Partial<Record<number, [number[], number[]]>>; // per-chapter camera overrides, in reference-slab units
  camsP?: Partial<Record<number, [number[], number[]]>>; // the same for portrait screens
  finding?: string; // what the real NISAR pair shows (our reading of the extracted raster), shown in About when it is on screen
  hero?: { value: number; unit: string; label: string }; // the chapter-3 number for change sites (a published or measured figure)
  noEvent?: boolean; // a continuing process: no event marker, no seismic wave
}

// NISAR is left-looking (the granules say lookDirection = Left). On an ascending pass, heading about 10° west of
// north, it looks west-south-west, so the ground-to-satellite vector points east-north-east.
const INC = (37 * Math.PI) / 180;
const ASC_LOOK: [number, number, number] = [0.984 * Math.sin(INC), 0.18 * Math.sin(INC), Math.cos(INC)];

export const SITES: SiteDef[] = [
  {
    id: 'venezuela',
    name: 'Venezuela',
    region: 'Yaracuy → La Guaira',
    kind: 'quake',
    headline: 'M7.2 then M7.5 · shallow strike-slip',
    stat: { value: '60', unit: 'cm', label: 'radar motion range' },
    tag: 'M7.5',
    aoi: { west: -69.5, south: 9.95, east: -66.6, north: 11.45 },
    zoom: 10,
    date: Date.UTC(2026, 5, 24),
    eventAt: Date.UTC(2026, 5, 24, 22, 4, 33),
    epicentres: [
      { lon: -68.472, lat: 10.435, label: 'Epicentre · M7.2' },
      { lon: -67.221, lat: 10.596, label: 'Epicentre · M7.5' },
    ],
    pair: { ref: '2026-06-13', sec: '2026-06-25', track: '162', frame: '006 + 007', orbit: 'A' },
    facts: [
      ['Event', '24 Jun 2026 · M7.2, then M7.5 under a minute later'],
      ['Mechanism', 'Right-lateral strike-slip · San Sebastián fault system'],
      ['Rupture', 'Roughly 175–230 km long, offshore then back onshore (model-dependent)'],
      ['Ground motion', 'Up to about 60 cm westward (NASA NISAR Urgent Response)'],
      ['NISAR pair', '13 Jun → 25 Jun 2026 · track 162 · frames 006 + 007 · ascending'],
    ],
    vex: 4,
    liftKm: 5,
    range: 0.35,
    look: ASC_LOOK,
    fault: { lon: -68.05, lat: 10.5, strikeDeg: 82, lengthKm: 200, depthKm: 13, slipM: 0.88 },
    finding: 'Line-of-sight motion of roughly 60 cm peak to peak (0.5–99.5 percentile) along the rupture. The block south of the fault moves away from the satellite, matching a right-lateral rupture seen from a left-looking radar. The sea has no coherence; about 42% of the area stays coherent (> 0.3).',
    places: [
      { name: 'Caracas', lat: 10.4806, lon: -66.9036, kind: 'city' },
      { name: 'La Guaira', lat: 10.5993, lon: -66.9346, kind: 'city' },
      { name: 'Valencia', lat: 10.162, lon: -68.0077, kind: 'city' },
      { name: 'Maracay', lat: 10.2469, lon: -67.5958, kind: 'city' },
      { name: 'Puerto Cabello', lat: 10.4731, lon: -68.0125, kind: 'city' },
      { name: 'San Felipe', lat: 10.3399, lon: -68.7417, kind: 'city' },
      { name: 'Yumare', lat: 10.6123, lon: -68.6785, kind: 'city' },
      { name: 'Lago de Valencia', lat: 10.18, lon: -67.75, kind: 'area' },
      { name: 'Mar Caribe', lat: 11.15, lon: -68.0, kind: 'area' },
    ],
    sources: [
      { label: 'NASA Earth Observatory — Where Venezuela’s Earthquakes Shifted the Ground', url: 'https://science.nasa.gov/earth/earth-observatory/where-venezuelas-earthquakes-shifted-the-ground/' },
      { label: 'USGS — M 7.5, 20 km W of Catia La Mar', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000t7zp/executive' },
      { label: 'openSEPPO — NISAR GUNW Venezuela reproduction', url: 'https://openseppo.readthedocs.io/en/latest/nisar_gunw_convert_examples/' },
    ],
  },
  {
    id: 'nepal',
    name: 'Nepal · Tibet',
    region: 'Rasuwa · Trishuli valley',
    kind: 'flood',
    headline: 'Glacier collapse · 72 km debris flood',
    stat: { value: '72', unit: 'km', label: 'flood path · reported' },
    tag: 'Collapse',
    aoi: { west: 84.8, south: 27.8, east: 85.9, north: 28.6 },
    zoom: 11,
    date: Date.UTC(2026, 7, 26),
    eventAt: Date.UTC(2026, 7, 26, 2, 52), // ~08:37 Nepal time
    epicentres: [{ lon: 85.5167, lat: 28.2556, label: 'Collapse · Langtang Lirung' }],
    pair: { ref: '2026-08-19', sec: '2026-08-31', track: '098', frame: '015 + 016', orbit: 'A' },
    facts: [
      ['Event', '26 Aug 2026 · a rock-and-ice slab fell from Langtang Lirung (7,227 m)'],
      ['Flow', 'Debris flow down the Lhende, Bhote Koshi and Trishuli — about 72 km of Nepal’s valley'],
      ['Scale', 'Up to about 200 million m³ displaced (geologists’ estimate)'],
      ['What radar sees', 'Not motion but lost coherence: scoured ground no longer matches the earlier pass'],
      ['NISAR pair', '19 Aug → 31 Aug 2026 · track 098 · frames 015 + 016 · ascending (a 14 Jul → 26 Jul pair gives the baseline coherence)'],
    ],
    vex: 0.85,
    liftKm: 12,
    range: 0.05,
    look: ASC_LOOK,
    cams: {
      0: [[70, 96, 190], [-6, -6, -10]],
      3: [[-108, 62, 165], [8, -6, 14]],
      4: [[-150, 112, 135], [4, -8, 12]],
      5: [[-40, 120, 150], [0, -4, 6]],
    },
    flood: {
      waypoints: [
        [85.52, 28.27], [85.42, 28.29], [85.375, 28.28], [85.385, 28.22], [85.355, 28.16],
        [85.30, 28.09], [85.23, 28.03], [85.17, 27.98], [85.15, 27.92],
      ],
      widthKm: [0.5, 1.1],
      source: [85.5167, 28.2556],
      sourceKm: 3.2,
    },
    hero: { value: 72, unit: 'km', label: 'of valley scoured · reported' },
    finding: 'Coherence drops along the Trishuli valley: up to 0.57–0.68 lost at Rasuwagadhi, Syabrubesi, Betrawati and Trishuli Bazaar, against 0.20 on a control ridge. Elsewhere the map also shows scattered weaker loss from vegetation, steep slopes and the monsoon, which is not flood damage.',
    places: [
      { name: 'Gyirong', lat: 28.31, lon: 85.39, kind: 'city' },
      { name: 'Rasuwagadhi', lat: 28.28, lon: 85.37, kind: 'city' },
      { name: 'Syabrubesi', lat: 28.15, lon: 85.35, kind: 'city' },
      { name: 'Betrawati', lat: 27.98, lon: 85.17, kind: 'city' },
    ],
    sources: [
      { label: '2026 Nepal–Tibet floods — Wikipedia', url: 'https://en.wikipedia.org/wiki/2026_Nepal%E2%80%93Tibet_floods' },
      { label: 'ICIMOD — Kyirong–Rasuwa Flood 2026', url: 'https://www.icimod.org/kyirong-rasuwa-flood-2026-nepal-china-border/' },
      { label: 'EarthSky — Nepal flash flood: what caused it?', url: 'https://earthsky.org/earth/nepal-flash-flood-glacier-collapse-landslide-aug-26-2026/' },
    ],
  },
];

SITES.push({
  id: 'granada',
  name: 'Granada',
  region: 'Vega de Granada · Alhendín',
  kind: 'quake-normal',
  headline: 'M5.0 shallow sequence · 600+ quakes',
  stat: { value: '<1', unit: 'cm', label: 'local radar difference' },
  tag: 'M5.0',
  aoi: { west: -4.1, south: 36.8, east: -3.0, north: 37.42 },
  zoom: 11,
  date: Date.UTC(2026, 7, 15),
  eventAt: Date.UTC(2026, 7, 14, 23, 4), // 01:04 on 15 Aug, Madrid time
  epicentres: [{ lon: -3.662, lat: 37.115, label: 'Epicentre · M5.0' }],
  // Ascending track 087 covers the whole area and the epicentre (track 015, the 12-day pair, only reaches its eastern edge).
  pair: { ref: '2026-07-26', sec: '2026-08-19', track: '087', frame: '020 + 021', orbit: 'A' },
  facts: [
    ['Event', '15 Aug 2026, 01:04 local (23:04 UTC on 14 Aug) · mbLg 5.0, up to M5.2 by other agencies'],
    ['Location', 'Near Alhendín, south of Granada · epicentre about 37.115°N 3.662°W'],
    ['Depth', 'Shallow — reported between 2 and 10 km'],
    ['Mechanism', 'Normal faulting on high-angle faults (Belicena–Alhendín, Granada, Dílar, Santa Fe systems)'],
    ['Sequence', 'More than 600 earthquakes since 14 Aug; a second event near M4.8–4.9 followed on 18 Aug'],
    ['NISAR pair', '26 Jul → 19 Aug 2026 · track 087 · frames 020 + 021 · ascending — 24 days, so it spans the whole sequence (the 18 Aug M4.9 included), not only the first shock'],
    ['Context', '2021 Atarfe–Santa Fe swarm (Sentinel-1 InSAR: downward motion near Pinos Puente, Atarfe, Santa Fe); Vega de Granada subsidence up to about 10 mm/yr (Envisat era)'],
  ],
  vex: 1.5,
  liftKm: 60,
  range: 0.06,
  look: ASC_LOOK,
  fault: { lon: -3.662, lat: 37.115, strikeDeg: 140, lengthKm: 7, depthKm: 4, slipM: 0.25 },
  finding: 'In this 24-day pair, the line-of-sight signal near Alhendín differs from its surroundings by under 1 cm after ionosphere correction; no clear earthquake-related displacement is identified there. This does not mean the earthquake was not felt or that no ground motion occurred. A +5 to +7 cm streak 29 km to the north reverses to −4 cm in the next pair, which shares 19 Aug; this suggests an atmospheric contribution rather than ground displacement.',
  places: [
    { name: 'Granada', lat: 37.1773, lon: -3.5986, kind: 'city' },
    { name: 'Alhendín', lat: 37.1256, lon: -3.6525, kind: 'city' },
    { name: 'La Zubia', lat: 37.1128, lon: -3.5918, kind: 'city' },
    { name: 'Atarfe', lat: 37.2233, lon: -3.6853, kind: 'city' },
    { name: 'Santa Fe', lat: 37.1889, lon: -3.7231, kind: 'city' },
    { name: 'Pinos Puente', lat: 37.2549, lon: -3.7626, kind: 'city' },
    { name: 'Alhama de Granada', lat: 37.0044, lon: -3.9897, kind: 'city' },
    { name: 'Mulhacén', lat: 37.0534, lon: -3.3111, kind: 'peak' },
    { name: 'Vega de Granada', lat: 37.2, lon: -3.86, kind: 'area' },
    { name: 'Sierra Nevada', lat: 37.13, lon: -3.2, kind: 'area' },
    { name: 'Weather on 19 Aug · not ground', lat: 37.349, lon: -3.528, kind: 'note' },
  ],
  sources: [
    { label: 'IGN — nota informativa, serie sísmica de Alhendín', url: 'https://www.ign.es/resources/sismologia/tproximos/informes/nota_informativa_20260814_Mw4.8_ALHENDIN.GR.PDF' },
    { label: 'The Watchers — Granada seismic sequence exceeds 620 earthquakes', url: 'https://watchers.news/2026/08/20/granada-seismic-sequence-exceeds-620-earthquakes-around-600-residents-evacuated-spain/' },
    { label: 'GJI 2025 — 2021 Atarfe–Santa Fe earthquake swarm', url: 'https://academic.oup.com/gji/article/241/3/1911/8108816' },
    { label: 'Multiband PSInSAR of Vega de Granada subsidence', url: 'https://zenodo.org/records/1158019' },
  ],
});

SITES.push({
  id: 'mexico',
  name: 'Mexico City',
  region: 'Valle de México · CDMX',
  kind: 'subsidence',
  noEvent: true,
  headline: 'A megacity sinking · centimetres a month',
  stat: { value: '−7', unit: 'cm', label: 'sinking · 4 months' },
  tag: 'Sinking',
  aoi: { west: -99.35, south: 19.15, east: -98.8, north: 19.62 },
  zoom: 12,
  date: Date.UTC(2026, 4, 22),
  eventAt: Date.UTC(2026, 6, 21, 12),
  epicentres: [{ lon: -99.028, lat: 19.446, label: 'Fastest sinking' }],
  pair: { ref: '2026-05-22', sec: '2026-09-19', track: '019', frame: 'to be confirmed', orbit: 'A' },
  facts: [
    ['What', 'The city is sinking: groundwater pumping compacts the clay of the ancient lakebed it was built on'],
    ['Rate', 'More than 2 cm a month in the fastest-sinking districts (NISAR, Oct 2025 – Jan 2026, NASA/JPL)'],
    ['Damage', 'Uneven sinking cracks roads, buildings and water mains'],
    ['NISAR pairs', '9 consecutive pairs, 22 May → 19 Sep 2026 · track 019 · ascending · summed into one record'],
  ],
  finding: 'Summed over nine pairs, the ground east of the airport — the old bed of Lake Texcoco, around Nezahualcóyotl — sank about 7 cm along the line of sight in four months (medians over ~2.5 km). The historic centre moved about 1.5 cm. Isolated values beyond −10 cm are unwrapping errors next to water, and the texture over the western ranges is atmosphere that sums up too: the sinking is the broad bowl, not single pixels.',
  vex: 3,
  liftKm: 28,
  range: 0.08,
  hero: { value: 7.1, unit: 'cm', label: 'sunk at the fastest · 22 May → 19 Sep' },
  look: ASC_LOOK,
  places: [
    { name: 'Zócalo', lat: 19.4326, lon: -99.1332, kind: 'city' },
    { name: 'Airport (AICM)', lat: 19.4361, lon: -99.0719, kind: 'city' },
    { name: 'Iztapalapa', lat: 19.3574, lon: -99.0926, kind: 'city' },
    { name: 'Nezahualcóyotl', lat: 19.4006, lon: -99.0148, kind: 'city' },
    { name: 'Chalco', lat: 19.264, lon: -98.897, kind: 'city' },
    { name: 'Xochimilco', lat: 19.2572, lon: -99.1037, kind: 'city' },
    { name: 'Texcoco', lat: 19.5117, lon: -98.8829, kind: 'city' },
    { name: 'Former Lake Texcoco', lat: 19.49, lon: -98.99, kind: 'area' },
    { name: 'Sierra de las Cruces', lat: 19.3, lon: -99.29, kind: 'area' },
  ],
  sources: [
    { label: 'NASA/JPL — US-Indian space mission maps extreme subsidence in Mexico City', url: 'https://www.jpl.nasa.gov/news/us-indian-space-mission-maps-extreme-subsidence-in-mexico-city/' },
    { label: 'NASA/JPL — PIA26709: US-Indian spacecraft captures Mexico City subsidence', url: 'https://www.jpl.nasa.gov/images/pia26709-us-indian-spacecraft-captures-mexico-city-subsidence/' },
  ],
});

SITES.push({
  id: 'krasheninnikov',
  name: 'Krasheninnikov',
  region: 'Kamchatka · Kronotsky reserve',
  kind: 'volcano',
  noEvent: true,
  headline: 'Awake after ~470 years · lava still spreading',
  stat: { value: '1.2', unit: 'km²', label: 'low-coherence area' },
  tag: 'Eruption',
  aoi: { west: 159.9, south: 54.38, east: 160.62, north: 54.8 },
  zoom: 11,
  date: Date.UTC(2025, 7, 3),
  eventAt: Date.UTC(2026, 7, 1, 12),
  epicentres: [{ lon: 160.273, lat: 54.593, label: 'Vent · Krasheninnikov' }],
  pair: { ref: '2026-08-30', sec: '2026-09-11', track: '080', frame: 'to be confirmed', orbit: 'A' },
  hero: { value: 1.2, unit: 'km²', label: 'never coherent · near the vent' },
  focus: { at: [160.292, 54.604], scale: { 3: 0.38 } }, // the flow is a few km long: the change chapter frames it close
  facts: [
    ['Event', 'Erupting since early August 2025, days after the M8.8 Kamchatka earthquake of 30 July 2025'],
    ['History', 'Its first eruption in about 470 years (the last around 1550)'],
    ['What NISAR saw', 'Lava filling the inner caldera, spilling into the larger crater and fanning out (NASA/JPL, Dec 2025 – Aug 2026)'],
    ['What radar reads here', 'Not motion but lost coherence: fresh lava remakes the surface between two passes'],
    ['NISAR pairs', '6 consecutive pairs, 1 Jul → 23 Sep 2026 · track 080 · ascending · shown: 30 Aug → 11 Sep'],
  ],
  finding: 'In the three snow-free pairs (18 Aug → 23 Sep) about 1.2 km² of ground near the vent never holds coherence while the slopes around it do: a branching tongue running north-east from the crater, the shape of a lava flow still on the move. We read it as the active flow; steep, shadowed ground can also lose coherence. The July pairs lose coherence over the whole massif (snowmelt), so they are not used to find it, and the +5 to +10 cm patch 15 km east on 11–23 Sep is atmosphere or an unwrapping jump, not the volcano.',
  vex: 1.6,
  liftKm: 12,
  range: 0.08,
  look: ASC_LOOK,
  places: [
    { name: 'Lava flow', lat: 54.612, lon: 160.303, kind: 'area' },
    { name: 'Kikhpinych', lat: 54.487, lon: 160.253, kind: 'peak' },
    { name: 'Valley of Geysers', lat: 54.43, lon: 160.14, kind: 'city' },
    { name: 'Uzon caldera', lat: 54.5, lon: 159.97, kind: 'area' },
    { name: 'Kronotsky Lake', lat: 54.75, lon: 160.25, kind: 'area' },
    { name: 'Kronotsky', lat: 54.753, lon: 160.527, kind: 'peak' },
  ],
  sources: [
    { label: 'NASA — US-India satellite captures time-lapse video of volcanic eruption', url: 'https://www.nasa.gov/missions/nisar/us-india-satellite-captures-time-lapse-video-of-volcanic-eruption/' },
    { label: 'Smithsonian GVP — Krasheninnikov', url: 'https://volcano.si.edu/volcano.cfm?vn=300120' },
  ],
});

export const siteById = (id: string) => SITES.find((s) => s.id === id);

// ---------- per-site story ----------
export interface Beat {
  label: string;
  eyebrow: string;
  title: string;
  sub: string;
  next: string;
  cam: [number[], number[]];
  camP?: [number[], number[]]; // portrait screens: used as is, without the landscape-to-portrait turn
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDate = (iso: string) => {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
export const eventDate = (s: SiteDef) => {
  const d = new Date(s.date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

// Camera framing is authored for the ≈1.9:1 slab; `scale` (km of slab width / 273) keeps other AOIs comfortable.
const CAMS: [number[], number[]][] = [
  [[214, 78, 112], [-64, -8, -6]],
  [[110, 185, -165], [-10, -6, 15]], // Acquire's wide shot: high in the north-east, NISAR comes in from far to the south
  [[-120, 200, -150], [0, -8, 10]], // Interfere's wide shot: from the north-west, NISAR comes towards it from the south
  [[110, 104, 160], [-22, -6, -4]],
  [[-96, 150, 190], [18, -12, -6]],
  [[0, 196, 262], [0, -12, -8]],
];

// Portrait: let the slab run away up the screen instead of across it.
const CAMS_P: Partial<Record<number, [number[], number[]]>> = {
  0: [[330, 116, 30], [-16, -6, -2]],
};

export function beatsFor(s: SiteDef, real = false, series: { ref: string; sec: string }[] = []): Beat[] {
  const a = shortDate(s.pair.ref) || 'before the event', b = shortDate(s.pair.sec) || 'after the event';
  const cumulative = s.kind === 'subsidence' && real && series.length > 1;
  const acquire = { label: 'First pass', eyebrow: `Pass 1 · ${a} · L-band SAR`, title: 'The first<br><em>radar pass.</em>', sub: 'NISAR records its first radar view of the surface, even through clouds or darkness.', next: cumulative ? 'Later passes' : 'Second pass' };
  const interfere = cumulative
    ? { label: 'Compare', eyebrow: `Observations · ${a} → ${b}`, title: 'Many passes.<br><em>Changes over time.</em>', sub: `${series.length} consecutive pairs build the accumulated map. The radar passes shown are illustrative.`, next: 'See movement' }
    : { label: 'Compare', eyebrow: `Pass 2 · ${b} · same orbit`, title: 'Two passes.<br><em>One comparison.</em>', sub: 'The colours show differences between radar echoes, not a photograph of movement.', next: s.kind === 'flood' ? 'See surface change' : s.kind === 'volcano' ? 'See surface change' : 'See movement' };
  const trust = { label: 'Reliability', eyebrow: 'Signal reliability · coherence', title: 'How much can<br><em>we trust?</em>', sub: 'Where the radar echoes match poorly, the measurement is less reliable.', next: 'Explore' };
  const explore =
    series.length > 1
      ? { label: 'Explore', eyebrow: `${series.length} real pairs · ${shortDate(series[0].ref)} → ${shortDate(series[series.length - 1].sec)}`, title: 'Before, <em>during, after.</em>', sub: 'Drag the timeline to compare pass pairs; this is not continuous footage.', next: 'Choose a place' }
      : { label: 'Explore', eyebrow: `Pass 1 · ${a}  →  Pass 2 · ${b}`, title: 'Explore <em>the change.</em>', sub: 'Compare the two radar passes; this is not continuous footage.', next: 'Choose a place' };
  if (series.length > 1 && s.kind === 'subsidence') explore.title = 'Month by month, <em>lower.</em>';
  if (series.length > 1 && s.kind === 'volcano') explore.title = 'Pass by pass, <em>new ground.</em>';

  let surface: Omit<Beat, 'cam'>, change: Omit<Beat, 'cam'>;
  if (s.kind === 'quake') {
    surface = { label: 'Surface', eyebrow: `Northern Venezuela · ${eventDate(s)}`, title: 'The ground<br><em>moved.</em>', sub: 'M7.2, then M7.5 — under a minute apart.', next: 'Look with radar' };
    change = { label: 'Unwrap', eyebrow: 'Line-of-sight displacement', title: 'Count the fringes.<br><em>Read the motion.</em>', sub: 'Colours show motion towards or away from the satellite. Relief is exaggerated.', next: 'Check the signal' };
  } else if (s.kind === 'quake-normal') {
    surface = { label: 'Surface', eyebrow: `Granada, Spain · ${eventDate(s)}`, title: 'Under the city,<br><em>a shallow rupture.</em>', sub: 'A M5.0 in the Vega opened a sequence of 600+ quakes.', next: 'Look with radar' };
    change = real
      ? { label: 'Unwrap', eyebrow: 'Line-of-sight displacement', title: 'A shallow M5.<br><em>A subtle signal.</em>', sub: 'No clear quake signal near Alhendín in this pair. The bright northern streak is likely atmospheric noise.', next: 'Check the signal' }
      : { label: 'Unwrap', eyebrow: 'Line-of-sight displacement', title: 'Centimetres,<br><em>under a city.</em>', sub: 'A shallow quake leaves a small, local fingerprint.', next: 'Check the signal' };
  } else if (s.kind === 'subsidence') {
    surface = { label: 'Surface', eyebrow: 'Mexico City · 2026', title: 'A megacity<br><em>is sinking.</em>', sub: 'Pumping water from under it compacts the old lakebed.', next: 'Look with radar' };
    change = { label: 'Unwrap', eyebrow: 'Line-of-sight displacement · summed', title: 'Four months,<br><em>added up.</em>', sub: 'Nine pass pairs show accumulated change. Relief is exaggerated.', next: 'Check the signal' };
  } else if (s.kind === 'volcano') {
    surface = { label: 'Surface', eyebrow: 'Kamchatka · erupting since August 2025', title: 'A volcano<br><em>woke up.</em>', sub: 'Krasheninnikov, silent for about 470 years.', next: 'Look with radar' };
    change = { label: 'Change', eyebrow: 'Coherence loss', title: 'A changing<br><em>volcanic surface.</em>', sub: 'Radar detects a persistent low-match area near the vent. Lava is an interpretation; the glow is illustrative.', next: 'Check the signal' };
  } else {
    surface = { label: 'Surface', eyebrow: `Rasuwa, Nepal · ${eventDate(s)}`, title: 'The mountain<br><em>let go.</em>', sub: 'A slab of rock and ice fell 1,200 m. The flood ran 72 km.', next: 'Look with radar' };
    change = { label: 'Change', eyebrow: 'Coherence loss', title: 'Where the ground<br><em>changed.</em>', sub: real ? 'The radar signal matched less along the flood-scoured valley; colours do not show water depth.' : 'A simulated loss of radar match follows the valley; colours do not show water depth.', next: 'Check the signal' };
  }
  const beats = [surface, acquire, interfere, change, trust, explore];
  const labels = ['The place', 'First pass', 'Compare', 'The change', 'Check', 'Explore'];
  return beats.map((beat, i) => ({ ...beat, label: labels[i], cam: s.cams?.[i] ?? CAMS[i], camP: s.camsP?.[i] ?? CAMS_P[i] }));
}

// Epochs: NISAR's 12-day repeat around the event (a model timeline, not the real acquisition list).
export function epochsFor(s: SiteDef) {
  const DAY = 86400000;
  const out: number[] = [];
  for (let t = s.date - 72 * DAY; t <= s.date + 100 * DAY; t += 12 * DAY) out.push(t);
  const pair = out.findIndex((t) => t > s.date);
  return { epochs: out, pairIndex: pair };
}

export function displacementFactor(t: number, eventDay: number) {
  if (t < eventDay) return 0;
  return 1 + 0.14 * Math.log1p((t - eventDay) / 86400000 / 15);
}
