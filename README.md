# Invisible Earth

**Explore how Earth's surface changes, one place at a time.**

Invisible Earth is an interactive 3D experience built for NASA Space Apps Challenge 2026 and the **Dancing with the SARs** challenge. It brings NASA–ISRO NISAR radar observations together with terrain data, guided stories and interactive maps, so that people without specialist radar training can explore surface change.

**[Open the application](https://invisibleearth.tarenvis.com/)** · **[View the seven-slide project demonstration](https://invisible-earth-space-apps.vercel.app/)** · **[Space Apps team page](https://www.spaceappschallenge.org/2026/find-a-team/tarenvis/?tab=project)** · **[Downloadable data release](https://github.com/albertogalvez-dev/invisible-earth/releases/tag/invisible-earth-data-v1)**

## What you can explore

Choose one of five prepared areas, follow the guided chapters and then explore the map. Depending on the case, the app presents an estimate of displacement along the satellite's line of sight or a change in radar coherence. You can inspect a point, compare the available observation dates, and use the quality mask to identify less reliable areas.

| Area | What the experience explores |
| --- | --- |
| Venezuela | Changes across the northern coast in observations spanning the June 2026 earthquakes. |
| Granada, Spain | A local earthquake sequence and the challenge of interpreting a subtle radar signal. |
| Mexico City | Accumulated change over multiple observation pairs in an area affected by subsidence. |
| Nepal and Tibet | Changes in radar coherence along a valley affected by a flood and debris flow. |
| Krasheninnikov, Kamchatka | Persistent low-coherence areas around a changing volcanic surface. |

The **Point guide** is an interactive preview with prepared explanations based on the selected point; it does not generate answers with a live AI model. English spoken guidance is available when sound is enabled.

## How it works

NISAR's radar observations can be compared across acquisitions of the same area. The project prepares **NISAR L2 GUNW provisional products** distributed by ASF DAAC, extracts radar layers for each study area and combines them with elevation grids. The web application renders these layers over 3D terrain and provides guided navigation, point inspection, a timeline and signal-quality controls.

Mexico City's accumulated view combines multiple observation pairs; its displayed total should not be described as a single two-pass observation. The Nepal and Krasheninnikov experiences use coherence-based surface-change views rather than interpreting every colour as ground displacement.

## Run locally

**Requirements:** Node.js `20.19+` or `22.12+`, npm, and `tar` available on the command line. A browser with WebGL support is required.

```bash
git clone https://github.com/albertogalvez-dev/invisible-earth.git
cd invisible-earth
npm ci
npm run data
npm run dev
```

Open the local address printed by Vite. `npm run data` downloads the project's approximately 254 MiB data archive from the GitHub release, verifies its SHA-256 checksum and extracts it to `public/data`. Files with matching names in that directory are replaced. The archive contains radar, terrain and sound assets; it is kept outside the Git history.

To build and preview the production version:

```bash
npm run build
npm run preview
```

The data archive must be restored before building a complete distributable: Vite copies the contents of `public/data` into the production build. Tests can be run with `npm run test:e2e`; Playwright's Chromium browser and a suitable graphics environment are needed.

## Reading the maps responsibly

- Displacement values are **relative to a reference** and represent the component along the satellite's line of sight. A single viewing direction does not independently determine the full horizontal and vertical motion.
- Coherence is a signal-quality indicator, not a probability that a value is correct. Low-coherence and uncovered areas should not be interpreted as zero change.
- Observation pairs compare specific dates; animations do not provide continuous footage. Terrain, motion, radar sweeps and event effects may be exaggerated or illustrative.
- The app can use a **labelled simulated signal** when radar data is unavailable. Check the on-screen signal label before interpreting a case.
- The NISAR collection used is provisional. This project's processing, reference choices and case interpretations still require independent scientific review. Invisible Earth is an educational prototype, not a prediction, emergency-response or building-safety tool.

## Data and resources

- [NISAR L2 GUNW Provisional V1 — NASA Earthdata / ASF DAAC](https://cmr.earthdata.nasa.gov/search/concepts/C2854335566-ASF.html)
- [NISAR mission — NASA](https://science.nasa.gov/mission/nisar/) and [NASA's introduction to radar interferometry](https://science.nasa.gov/mission/nisar/interferometry/)
- [NISAR products overview — ASF](https://hyp3-docs.asf.alaska.edu/nisar-docs/products-overview/)
- [Mapzen Terrain Tiles — AWS Open Data](https://registry.opendata.aws/terrain-tiles/) and [terrain source attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- [Mexico City subsidence — NASA/JPL](https://www.jpl.nasa.gov/news/us-indian-space-mission-maps-extreme-subsidence-in-mexico-city/)
- [Venezuela earthquakes — NASA Earth Observatory](https://science.nasa.gov/earth/earth-observatory/where-venezuelas-earthquakes-shifted-the-ground/)
- [Krasheninnikov — Smithsonian Global Volcanism Program](https://volcano.si.edu/volcano.cfm?vn=300190)

Built with TypeScript, Vite, Three.js and WebGL; data preparation uses Python, earthaccess, h5py and NumPy. See [CREDITOS.txt](CREDITOS.txt) for additional tools, data, fonts and media credits. OpenAI Codex and ChatGPT supported development and writing; English narration uses an AI-generated synthetic voice. The team is responsible for reviewing the project and its claims.

Other tools and services used for the application and project demonstration include [Node.js](https://nodejs.org/), [FFmpeg](https://ffmpeg.org/), [Playwright](https://playwright.dev/), [Slidev](https://sli.dev/), [Vue.js](https://vuejs.org/), [Google Fonts](https://fonts.google.com/) and [Vercel](https://vercel.com/). Background references include [2026 Nepal–Tibet floods](https://en.wikipedia.org/wiki/2026_Nepal%E2%80%93Tibet_floods).

## Team

**Daniel García Ortega** and **Alberto Gálvez Aguado** · Tarenvis · Granada, Spain.
