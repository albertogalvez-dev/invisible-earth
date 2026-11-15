#!/usr/bin/env python3
"""Extract a real NISAR GUNW pair over a site's AOI into public/data/<site>/gunw.{bin,json}.

The app uses this raster instead of its synthetic signal as soon as the files exist.

    pip install -r scripts/requirements-gunw.txt
    python scripts/fetch-gunw.py venezuela --dry-run     # search only, no login, nothing downloaded
    python scripts/fetch-gunw.py venezuela               # extract (asks for your Earthdata login once)

Credentials: NASA Earthdata Login is required to read the granule. Put them in ~/.netrc (Windows: %USERPROFILE%\\_netrc)
yourself, or let earthaccess prompt in the terminal. They are never written by this script.

Only the two layers the app needs (unwrappedPhase, coherenceMagnitude) and only the AOI window are read from the
~2 GB HDF5 through HTTP range requests, so the transfer is tens of MB, not GB.

Flood sites (Nepal) also need a pre-event pair to measure how much coherence was lost:
    python scripts/fetch-gunw.py nepal       # the pre-event pair (14 → 26 Jul) is built in; override with --pre-ref/--pre-sec

Output layout (matches src/main.ts loadReal): float32 los[H*W] (metres, + toward the satellite), then uint8 coh[H*W],
then optionally uint8 dcoh[H*W]; all on the terrain grid of public/data/<site>/terrain.json.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

for _s in (sys.stdout, sys.stderr):  # Windows consoles default to cp1252 and choke on arrows
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

SHORT_NAME = "NISAR_L2_GUNW_PROVISIONAL_V1"
L_BAND_WAVELENGTH_M = 299792458.0 / 1.239e9  # 0.2420 m; fallback only, the granule's centerFrequency is used when found

# Pair per site. Venezuela's is the event-spanning pair documented by openSEPPO
# (track 162 ascending, frame 007). The others are to be confirmed from the CMR search (see --dry-run).
PAIRS = {
    # Each pair spans the event and was chosen by AOI coverage from the public CMR footprints (2026-09-28); two adjacent
    # frames cover most AOIs and are mosaicked. Nepal also needs a pre-event pair of the same track and baseline for coherence loss.
    # refbox: stable ground far from the rupture used as the zero of the line-of-sight map (west, south, east, north).
    "venezuela": {"ref": "2026-06-13", "sec": "2026-06-25", "track": 162, "orbit": "A", "refbox": (-68.2, 9.98, -66.8, 10.12)},
    "nepal": {"ref": "2026-08-19", "sec": "2026-08-31", "track": 98, "orbit": "A", "pre": ("2026-07-14", "2026-07-26")},
    "granada": {"ref": "2026-07-26", "sec": "2026-08-19", "track": 87, "orbit": "A"},
    # Continuing processes (series only): Mexico City's pairs are summed into a record of the sinking, referenced to the
    # stable volcanic ranges to the west; at Krasheninnikov the lava is the ground near the vent that never holds coherence.
    "mexico": {"ref": "2026-05-22", "sec": "2026-06-03", "track": 19, "orbit": "A", "cumulative": True,
               "refbox": (-99.34, 19.2, -99.26, 19.42)},
    "krasheninnikov": {"ref": "2026-06-19", "sec": "2026-07-01", "track": 80, "orbit": "A", "lava": True,
                       "vent": (160.273, 54.593), "radiusM": 6000},
}


# ---------- geometry ----------
def utm_forward(lon: np.ndarray, lat: np.ndarray, zone: int, north: bool = True):
    """WGS84 lon/lat (degrees) → UTM easting/northing (Krüger series, sub-millimetre)."""
    a, f = 6378137.0, 1 / 298.257223563
    n = f / (2 - f)
    A = a / (1 + n) * (1 + n**2 / 4 + n**4 / 64)
    alpha = [
        n / 2 - 2 * n**2 / 3 + 5 * n**3 / 16,
        13 * n**2 / 48 - 3 * n**3 / 5,
        61 * n**3 / 240,
    ]
    k0 = 0.9996
    lam = np.radians(lon - ((zone - 1) * 6 - 180 + 3))
    phi = np.radians(lat)
    e = math.sqrt(f * (2 - f))
    t = np.sinh(np.arctanh(np.sin(phi)) - e * np.arctanh(e * np.sin(phi)))
    xi = np.arctan2(t, np.cos(lam))
    eta = np.arctanh(np.sin(lam) / np.sqrt(1 + t**2))
    x = eta.copy()
    y = xi.copy()
    for j, al in enumerate(alpha, start=1):
        y += al * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        x += al * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    return 500000.0 + k0 * A * x, (0.0 if north else 10000000.0) + k0 * A * y


def mercator_lat(v: np.ndarray, north: float, south: float) -> np.ndarray:
    """Latitude of terrain rows (the terrain grid is Web-Mercator in y). v = 0 at the north edge, 1 at the south."""
    my = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    y = my(north) + v * (my(south) - my(north))
    return np.degrees(2 * np.arctan(np.exp(y)) - math.pi / 2)


def bilinear(src: np.ndarray, valid: np.ndarray, fx: np.ndarray, fy: np.ndarray):
    """Mask-aware bilinear sampling of src at fractional (col, row) positions. Returns (value, weight)."""
    h, w = src.shape
    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    tx, ty = fx - x0, fy - y0
    acc = np.zeros(fx.shape, np.float64)
    wsum = np.zeros(fx.shape, np.float64)
    for dx, dy, wt in ((0, 0, (1 - tx) * (1 - ty)), (1, 0, tx * (1 - ty)), (0, 1, (1 - tx) * ty), (1, 1, tx * ty)):
        xi, yi = x0 + dx, y0 + dy
        ok = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
        xi = np.clip(xi, 0, w - 1)
        yi = np.clip(yi, 0, h - 1)
        m = ok & valid[yi, xi]
        wt = wt * m
        acc += np.where(m, src[yi, xi], 0.0) * wt
        wsum += wt
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(wsum > 1e-6, acc / wsum, np.nan), wsum


# ---------- granule access ----------
def find_dataset(h5, name: str, prefer: str = "unwrappedInterferogram"):
    hits = []
    h5.visititems(lambda p, o: hits.append(p) if p.split("/")[-1] == name and hasattr(o, "shape") else None)
    if not hits:
        raise SystemExit(f"dataset '{name}' not found in the granule (paths differ from the expected GUNW layout)")
    hits.sort(key=lambda p: (prefer not in p, len(p)))
    return h5[hits[0]], hits[0]


def granule_wavelength(h5) -> float:
    """Wavelength from the granule: c / centerFrequency (1239 MHz → 24.2 cm), or a 'wavelength' dataset if there is one."""
    found = []
    h5.visititems(lambda p, o: found.append(p) if p.split("/")[-1] in ("centerFrequency", "wavelength", "radarWavelength") and hasattr(o, "shape") else None)
    for p in found:
        try:
            v = float(np.array(h5[p]).ravel()[0])
            if 0.1 < v < 0.5:
                return v
            if 1e9 < v < 3e9:
                return 299792458.0 / v
        except Exception:
            pass
    print(f"  centerFrequency not found in the granule, using {L_BAND_WAVELENGTH_M:.4f} m")
    return L_BAND_WAVELENGTH_M


def epsg_of(h5, x_mid: float, y_mid: float, aoi_lon: float, aoi_lat: float) -> int:
    found = []
    h5.visititems(lambda p, o: found.append(p) if p.split("/")[-1] == "projection" and hasattr(o, "shape") else None)
    for p in found:
        try:
            v = int(np.array(h5[p]).ravel()[0])
            if 1024 <= v <= 60000:
                return v
        except Exception:
            pass
        for k in ("epsg_code", "epsg", "EPSG"):
            if k in h5[p].attrs:
                return int(np.array(h5[p].attrs[k]).ravel()[0])
    zone = int((aoi_lon + 180) // 6) + 1
    guess = (32600 if aoi_lat >= 0 else 32700) + zone
    print(f"  projection EPSG not found, assuming UTM zone {zone} (EPSG:{guess})")
    return guess


NAME = re.compile(
    r"GUNW_(\d+)_(\d+)_([AD])_(\d+)_(\d+)_.*?_(20\d{6})T\d{6}_(20\d{6})T\d{6}_(20\d{6})T\d{6}_(20\d{6})T\d{6}_([A-Z])\d+"
)


def pick_granule(results, ref: str, sec: str, track: int | None = None, orbit: str | None = None):
    """All frames of the pair ref→sec (names carry: ref start, ref end, sec start, sec end). Production (P) beats experimental (X)."""
    want = (ref.replace("-", ""), sec.replace("-", ""))
    by_frame: dict[str, tuple[int, dict]] = {}
    for g in results:
        m = NAME.search(g["umm"]["GranuleUR"])
        if not m:
            continue
        _, trk, orb, frame, _, ref0, _, sec0, _, ver = m.groups()
        if (ref0, sec0) != want or (track and int(trk) != track) or (orbit and orb != orbit):
            continue
        rank = 0 if ver == "P" else 1
        if frame not in by_frame or rank < by_frame[frame][0]:
            by_frame[frame] = (rank, g)
    return [by_frame[f][1] for f in sorted(by_frame)]


def extract(g, files, terrain: dict, wanted_phase: bool):
    """Read the AOI window of one granule and resample it onto the terrain grid. Returns dict of arrays."""
    import h5py

    W, H, aoi = terrain["width"], terrain["height"], terrain["aoi"]
    with h5py.File(files, "r") as h5:
        coh_ds, coh_path = find_dataset(h5, "coherenceMagnitude")
        xs, _ = find_dataset(h5, "xCoordinates")
        ys, _ = find_dataset(h5, "yCoordinates")
        xs, ys = np.array(xs[:], dtype=np.float64), np.array(ys[:], dtype=np.float64)
        epsg = epsg_of(h5, xs.mean(), ys.mean(), (aoi["west"] + aoi["east"]) / 2, (aoi["north"] + aoi["south"]) / 2)
        if not (32601 <= epsg <= 32660 or 32701 <= epsg <= 32760):
            raise SystemExit(f"granule grid is EPSG:{epsg}; only UTM granules are handled by this script")
        zone, north = epsg % 100, epsg < 32700
        print(f"  grid EPSG:{epsg}, {xs.size}×{ys.size} samples, wavelength window from {coh_path}")

        # Target pixels → granule coordinates.
        jj, ii = np.mgrid[0:H, 0:W]
        lon = aoi["west"] + (ii + 0.5) / W * (aoi["east"] - aoi["west"])
        lat = mercator_lat((jj + 0.5) / H, aoi["north"], aoi["south"])
        ex, ny = utm_forward(lon, lat, zone, north)
        dx, dy = xs[1] - xs[0], ys[1] - ys[0]
        fx, fy = (ex - xs[0]) / dx, (ny - ys[0]) / dy  # fractional column / row (y usually decreases)

        c0, c1 = int(max(0, math.floor(np.nanmin(fx)) - 2)), int(min(xs.size, math.ceil(np.nanmax(fx)) + 3))
        r0, r1 = int(max(0, math.floor(np.nanmin(fy)) - 2)), int(min(ys.size, math.ceil(np.nanmax(fy)) + 3))
        if c1 <= c0 or r1 <= r0:
            raise SystemExit("the granule does not overlap the AOI")
        print(f"  reading window rows {r0}:{r1}, cols {c0}:{c1}")
        out = {"lam": granule_wavelength(h5)}

        coh = np.array(coh_ds[r0:r1, c0:c1], dtype=np.float32)
        cvalid = np.isfinite(coh) & (coh >= 0) & (coh <= 1.0001)
        v, wt = bilinear(np.where(cvalid, coh, 0), cvalid, fx - c0, fy - r0)
        out["coh"] = np.where(np.isfinite(v), v, 0.0).astype(np.float32)
        out["cover"] = np.isfinite(v)

        if wanted_phase:
            ph_ds, _ = find_dataset(h5, "unwrappedPhase")
            ph = np.array(ph_ds[r0:r1, c0:c1], dtype=np.float32)
            valid = np.isfinite(ph) & (ph != 0)
            try:
                cc_ds, _ = find_dataset(h5, "connectedComponents")
                valid &= np.array(cc_ds[r0:r1, c0:c1]) > 0
            except SystemExit:
                pass
            v, _ = bilinear(np.where(valid, ph, 0), valid, fx - c0, fy - r0)
            out["phase"] = v  # NaN where the pixel has no unwrapped phase
            try:  # the product's own estimate of the ionospheric phase, on the same grid
                io_ds, _ = find_dataset(h5, "ionospherePhaseScreen")
                if io_ds.shape == ph_ds.shape:
                    io = np.array(io_ds[r0:r1, c0:c1], dtype=np.float32)
                    iv = np.isfinite(io)
                    out["iono"], _ = bilinear(np.where(iv, io, 0), iv, fx - c0, fy - r0)
            except SystemExit:
                pass
    return out



# ---------- time series: every consecutive pair of the same track around the event ----------
SERIES_WINDOW = {
    "venezuela": ("2026-05-15", "2026-07-25"),
    "nepal": ("2026-07-10", "2026-09-15"),
    "granada": ("2026-07-10", "2026-09-15"),
    "mexico": ("2026-05-20", "2026-09-21"),
    "krasheninnikov": ("2026-06-17", "2026-09-25"),
}
EVENT_AT = {
    "venezuela": "2026-06-24T22:04:33",
    "nepal": "2026-08-26T02:52:00",
    "granada": "2026-08-14T23:04:00",
    "mexico": None,  # no event: the last pair carries the whole record
    "krasheninnikov": None,  # no event: the pair with the most change is shown in the chapters
}


def compute_pair(a, pair, terrain, earthaccess, picks, baseline):
    """The same steps as the single-pair run, returned as arrays: los (m, + toward the satellite), coh, dcoh, stats."""
    aoi = terrain["aoi"]
    evs = [extract(g, earthaccess.open([g])[0], terrain, wanted_phase=True) for g in picks]
    shape = evs[0]["coh"].shape
    los = np.full(shape, np.nan)
    coh = np.zeros(shape, np.float32)
    cover = np.zeros(shape, bool)
    for e in evs:
        phase = e["phase"]
        if not a.no_iono and "iono" in e:
            phase = phase - np.nan_to_num(e["iono"])
        l = phase * (e["lam"] / (4 * math.pi)) * (1 if a.flip_sign else -1)
        ok = np.isfinite(l)
        overlap = ok & np.isfinite(los)
        if overlap.sum() > 500:
            l = l + np.nanmedian(los[overlap] - l[overlap])
        else:
            coherent = ok & (e["coh"] > 0.7)
            l = l - np.nanmedian(l[coherent if coherent.sum() > 1000 else ok])
        fill = ~np.isfinite(los) & np.isfinite(l)
        los[fill] = l[fill]
        better = e["cover"] & (e["coh"] > coh)
        coh[better] = e["coh"][better]
        cover |= e["cover"]
    W_, H_ = terrain["width"], terrain["height"]
    lons = aoi["west"] + (np.arange(W_) + 0.5) / W_ * (aoi["east"] - aoi["west"])
    lats = mercator_lat((np.arange(H_) + 0.5) / H_, aoi["north"], aoi["south"])
    sane = np.isfinite(los) & (coh > 0.5)
    box = pair.get("refbox")
    if box:
        inbox = (lons[None, :] >= box[0]) & (lons[None, :] <= box[2]) & (lats[:, None] >= box[1]) & (lats[:, None] <= box[3])
        if (sane & inbox).sum() > 500:
            sane = sane & inbox
    if sane.sum() < 500:
        sane = np.isfinite(los) & (coh > 0.3)
    los = los - np.nanmedian(los[sane])
    los = np.where(np.isfinite(los), los, 0.0).astype(np.float32)
    dcoh = None
    if baseline is not None:
        pcoh, pcover = baseline
        dcoh = np.clip(pcoh - coh, 0, 1) * (pcover & cover)
    masked = (coh > 0.3) & np.isfinite(los)
    stats = {
        "coverage": float(cover.mean()),
        "coherentShare": float(masked.mean()),
        "losMinCm": float(np.percentile(los[masked], 0.5) * 100) if masked.any() else None,
        "losMaxCm": float(np.percentile(los[masked], 99.5) * 100) if masked.any() else None,
        "wavelengthM": evs[0]["lam"],
        "ionosphereRemoved": bool((not a.no_iono) and all("iono" in e for e in evs)),
        "granule": ", ".join(g["umm"]["GranuleUR"] for g in picks),
    }
    return los, coh, dcoh, stats


def run_series(a, pair, terrain, folder):
    import earthaccess

    aoi = terrain["aoi"]
    w0, w1 = SERIES_WINDOW[a.site]
    res = earthaccess.search_data(
        short_name=SHORT_NAME, bounding_box=(aoi["west"], aoi["south"], aoi["east"], aoi["north"]),
        temporal=(w0, w1), count=400,
    )
    found = set()
    for g in res:
        m = NAME.search(g["umm"]["GranuleUR"])
        if not m:
            continue
        _, trk, orb, _, _, r0, _, s0, _, ver = m.groups()
        if int(trk) != pair["track"] or orb != pair["orbit"]:
            continue
        ref, sec = dt.datetime.strptime(r0, "%Y%m%d").date(), dt.datetime.strptime(s0, "%Y%m%d").date()
        if ref >= dt.date.fromisoformat(w0) and sec <= dt.date.fromisoformat(w1) + dt.timedelta(days=4):
            found.add((ref, sec))
    pairs = sorted(found)
    print(f"{a.site}: {len(pairs)} consecutive pairs on track {pair['track']}{pair['orbit']}:", ", ".join(f"{r:%d %b}→{s:%d %b}" for r, s in pairs))
    if a.dry_run:
        return
    earthaccess.login(strategy="netrc") if _has_netrc() else earthaccess.login()

    baseline = None
    pre = pair.get("pre")
    if pre:
        pres = pick_granule(
            earthaccess.search_data(
                short_name=SHORT_NAME, bounding_box=(aoi["west"], aoi["south"], aoi["east"], aoi["north"]),
                temporal=((dt.date.fromisoformat(pre[0]) - dt.timedelta(days=2)).isoformat(), (dt.date.fromisoformat(pre[1]) + dt.timedelta(days=2)).isoformat()), count=200),
            pre[0], pre[1], pair.get("track"), pair.get("orbit"),
        )
        pcoh = np.zeros((terrain["height"], terrain["width"]), np.float32)
        pcover = np.zeros(pcoh.shape, bool)
        for g in pres:
            print(f"  baseline {g['umm']['GranuleUR'][:60]} …", flush=True)
            e = extract(g, earthaccess.open([g])[0], terrain, wanted_phase=False)
            better = e["cover"] & (e["coh"] > pcoh)
            pcoh[better] = e["coh"][better]
            pcover |= e["cover"]
        baseline = (pcoh, pcover)

    ev_at = dt.datetime.fromisoformat(EVENT_AT[a.site]) if EVENT_AT.get(a.site) else None
    series = []
    arrays = []  # (los, coh, dcoh) per pair, written once every pair is in
    for ref, sec in pairs:
        picks = pick_granule(res, ref.isoformat(), sec.isoformat(), pair["track"], pair["orbit"])
        if not picks:
            print(f"  {ref}→{sec}: no granule, skipped")
            continue
        print(f"  {ref:%d %b} → {sec:%d %b}: reading {len(picks)} frame(s) …", flush=True)
        is_base = bool(pre) and (ref.isoformat(), sec.isoformat()) == tuple(pre)
        # Each pair is cached as soon as it is read, and retried on network trouble: a long series survives a dropped line.
        cache = Path(".cache/gunw-raw") / a.site / f"{ref:%Y%m%d}_{sec:%Y%m%d}.npz"
        if cache.exists():
            z = np.load(cache, allow_pickle=True)
            los, coh = z["los"], z["coh"]
            dcoh = z["dcoh"] if "dcoh" in z.files else None
            stats = json.loads(str(z["stats"]))
            print("     (cached)", flush=True)
        else:
            for attempt in range(3):
                try:
                    los, coh, dcoh, stats = compute_pair(a, pair, terrain, earthaccess, picks, None if is_base and baseline is None else baseline)
                    break
                except Exception as err:  # timeouts, dropped connections
                    if attempt == 2:
                        raise
                    print(f"     retrying after: {type(err).__name__}", flush=True)
            cache.parent.mkdir(parents=True, exist_ok=True)
            extra = {"dcoh": dcoh} if dcoh is not None else {}
            np.savez_compressed(cache, los=los, coh=coh, stats=json.dumps(stats), **extra)
        if is_base and dcoh is not None:
            dcoh = np.zeros_like(dcoh)  # the baseline pair is the reference: nothing lost against itself
        fname = f"gunw_{ref:%Y%m%d}_{sec:%Y%m%d}.bin"
        span_start = dt.datetime.combine(ref, dt.time(12))
        span_end = dt.datetime.combine(sec, dt.time(12))
        arrays.append((los, coh, dcoh))
        series.append({"ref": ref.isoformat(), "sec": sec.isoformat(), "file": fname, "hasDcoh": dcoh is not None,
                       "event": bool(ev_at and span_start <= ev_at <= span_end), **stats})
        print(f"     {stats['losMinCm']:.1f} … {stats['losMaxCm']:.1f} cm, {stats['coherentShare'] * 100:.0f}% coherent → {fname}", flush=True)

    if pair.get("cumulative") and arrays:
        # Each pair is referenced to the same stable ground, so their sum is the motion since the first pass.
        total = np.zeros_like(arrays[0][0])
        cohs = []
        for i, (los, coh, _) in enumerate(arrays):
            total = total + los
            cohs.append(coh)
            mean_coh = np.mean(cohs, axis=0).astype(np.float32)
            arrays[i] = (total.astype(np.float32).copy(), mean_coh, None)
            masked = mean_coh > 0.3
            series[i].update(cumulative=True, losMinCm=float(np.percentile(total[masked], 0.5) * 100),
                             losMaxCm=float(np.percentile(total[masked], 99.5) * 100), coherentShare=float(masked.mean()))
            print(f"  since {pairs[0][0]:%d %b} to {pairs[i][1]:%d %b}: {series[i]['losMinCm']:.1f} … {series[i]['losMaxCm']:.1f} cm")
        series[-1]["event"] = True  # the whole record: what the chapters show
    if pair.get("lava") and arrays:
        # Snow and melt scramble early-summer pairs everywhere, so the change a lava flow makes is read from the clean
        # pairs: ground near the vent that stays incoherent in every one of them, while the slopes around it hold.
        # Only connected patches of a useful size count; isolated pixels are steep gullies, shadow or noise.
        W_, H_, aoi = terrain["width"], terrain["height"], terrain["aoi"]
        heights = np.fromfile(folder / "terrain.bin", dtype=np.int16).reshape(H_, W_)
        mpp = terrain["metersPerPixel"]
        clean = [i for i, m in enumerate(series) if m["coherentShare"] >= 0.85] or list(range(len(series)))
        best_coh = np.max(np.stack([arrays[i][1] for i in clean]), axis=0)
        vx = (pair["vent"][0] - aoi["west"]) / (aoi["east"] - aoi["west"]) * W_
        vy = (aoi["north"] - pair["vent"][1]) / (aoi["north"] - aoi["south"]) * H_
        yy, xx = np.mgrid[0:H_, 0:W_]
        near = np.hypot(xx - vx, yy - vy) * mpp < pair["radiusM"]
        raw = (best_coh < 0.35) & near & (heights > 0)
        lava = np.zeros_like(raw)
        seen = np.zeros_like(raw)
        min_px = max(8, int(40_000 / (mpp * mpp)))  # 0.04 km²
        for y0, x0 in zip(*np.nonzero(raw)):
            if seen[y0, x0]:
                continue
            stack, blob = [(y0, x0)], []
            seen[y0, x0] = True
            while stack:
                y, x = stack.pop()
                blob.append((y, x))
                for dy_, dx_ in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                    ny_, nx_ = y + dy_, x + dx_
                    if 0 <= ny_ < H_ and 0 <= nx_ < W_ and raw[ny_, nx_] and not seen[ny_, nx_]:
                        seen[ny_, nx_] = True
                        stack.append((ny_, nx_))
            if len(blob) >= min_px:
                for y, x in blob:
                    lava[y, x] = True
        lava_km2 = float(lava.sum() * mpp * mpp / 1e6)
        print(f"  never coherent near the vent in {len(clean)} clean pairs: {lava_km2:.2f} km²")
        for i, (los, coh, _) in enumerate(arrays):
            ambient = float(np.median(coh[near & ~lava & (heights > 0)]))
            dcoh = np.where(lava, np.clip(ambient - coh, 0, 1), 0).astype(np.float32)
            arrays[i] = (los, coh, dcoh)
            series[i].update(hasDcoh=True, lavaKm2=lava_km2, cleanPair=i in clean)
        # The chapters show the flow on the calmest clean pair: the tightest line-of-sight spread, so that no
        # atmosphere or unwrapping jump elsewhere in the scene steals the colour scale.
        lead = min(clean, key=lambda i: series[i]["losMaxCm"] - series[i]["losMinCm"])
        series[lead]["event"] = True
    for (los, coh, dcoh), meta_i in zip(arrays, series):
        payload = [los.astype(np.float32).tobytes(), np.round(np.clip(coh, 0, 1) * 255).astype(np.uint8).tobytes()]
        if dcoh is not None:
            payload.append(np.round(np.clip(dcoh, 0, 1) * 255).astype(np.uint8).tobytes())
        (folder / meta_i["file"]).write_bytes(b"".join(payload))

    meta_path = folder / "gunw.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"width": terrain["width"], "height": terrain["height"]}
    if pair.get("cumulative") or pair.get("lava"):
        # No separate event pair for these: the leading pair of the series is also the chapters' raster.
        lead = next(i for i, m in enumerate(series) if m["event"])
        (folder / "gunw.bin").write_bytes((folder / series[lead]["file"]).read_bytes())
        m = series[lead]
        meta.update({"width": terrain["width"], "height": terrain["height"], "hasDcoh": m["hasDcoh"], "granule": m["granule"],
                     "pair": {"ref": series[0]["ref"] if pair.get("cumulative") else m["ref"], "sec": m["sec"]},
                     "wavelengthM": m["wavelengthM"], "signFlipped": a.flip_sign, "ionosphereRemoved": m["ionosphereRemoved"],
                     "coverage": m["coverage"], "track": pair["track"], "orbit": pair["orbit"], "coherentShare": m["coherentShare"],
                     "losMinCm": m["losMinCm"], "losMaxCm": m["losMaxCm"], "cumulative": bool(pair.get("cumulative")),
                     "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                     "source": "NISAR L2 GUNW (provisional) via ASF DAAC / NASA Earthdata"})
    meta["series"] = series
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f"\nWrote {len(series)} pairs and updated {meta_path}")


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("site", choices=sorted(PAIRS))
    ap.add_argument("--ref", help="reference acquisition date YYYY-MM-DD")
    ap.add_argument("--sec", help="secondary acquisition date YYYY-MM-DD")
    ap.add_argument("--pre-ref", help="pre-event pair reference date (Nepal defaults to 2026-07-14 → 2026-07-26)")
    ap.add_argument("--pre-sec", help="pre-event pair secondary date")
    ap.add_argument("--track", type=int, help="relative orbit (track) number, e.g. 87")
    ap.add_argument("--orbit", choices=["A", "D"], help="ascending or descending")
    ap.add_argument("--granule", help="force a granule id instead of matching dates")
    ap.add_argument("--no-iono", action="store_true", help="keep the ionospheric phase (by default the product's ionospherePhaseScreen is subtracted)")
    ap.add_argument("--flip-sign", action="store_true", help="flip the phase→LOS sign (the default is verified for Venezuela; keep it)")
    ap.add_argument("--series", action="store_true", help="extract every consecutive pair of the track around the event (time series for Explore)")
    ap.add_argument("--dry-run", action="store_true", help="search only")
    ap.add_argument("--data", default="public/data", help="app data folder (default: public/data)")
    a = ap.parse_args()

    pair = dict(PAIRS[a.site])
    if a.track:
        pair["track"] = a.track
    if a.orbit:
        pair["orbit"] = a.orbit
    ref, sec = a.ref or pair.get("ref"), a.sec or pair.get("sec")
    if not ref or not sec:
        raise SystemExit(f"no default pair for {a.site}: pass --ref and --sec (run with --dry-run to list what exists)")
    folder = Path(a.data) / a.site
    terrain = json.loads((folder / "terrain.json").read_text())
    aoi = terrain["aoi"]
    if a.series:
        return run_series(a, pair, terrain, folder)

    import earthaccess

    d0 = dt.date.fromisoformat(ref) - dt.timedelta(days=2)
    d1 = dt.date.fromisoformat(sec) + dt.timedelta(days=2)
    print(f"Searching {SHORT_NAME} for {ref} → {sec} over {aoi} …")
    res = earthaccess.search_data(
        short_name=SHORT_NAME,
        bounding_box=(aoi["west"], aoi["south"], aoi["east"], aoi["north"]),
        temporal=(d0.isoformat(), d1.isoformat()),
        count=200,
    )
    print(f"  {len(res)} granules in the window")
    picks = [g for g in res if a.granule and a.granule in g["umm"]["GranuleUR"]] or pick_granule(
        res, ref, sec, pair.get("track"), pair.get("orbit")
    )
    for g in (picks or res)[:12]:
        print("   ", g["umm"]["GranuleUR"])
    if a.dry_run:
        return
    if not picks:
        raise SystemExit("no granule matches that pair; re-run with --dry-run and pass --ref/--sec or --granule")

    earthaccess.login(strategy="netrc") if _has_netrc() else earthaccess.login()
    evs = []
    for g in picks:
        print(f"Reading {g['umm']['GranuleUR']} (window only) …")
        evs.append(extract(g, earthaccess.open([g])[0], terrain, wanted_phase=True))

    # Phase → line-of-sight metres, positive toward the satellite. The sign is a convention: check it against the
    # published maps (NASA's Venezuela figure) and use --flip-sign if the lobes are mirrored.
    # Frames are referenced to the median of their coherent ground; later frames are aligned to the mosaic so far
    # through their overlap, so a constant offset between frames does not leave a seam.
    shape = evs[0]["coh"].shape
    los = np.full(shape, np.nan)
    coh = np.zeros(shape, np.float32)
    cover = np.zeros(shape, bool)
    for e in evs:
        phase = e["phase"]
        if not a.no_iono and "iono" in e:
            phase = phase - np.nan_to_num(e["iono"])
        l = phase * (e["lam"] / (4 * math.pi)) * (1 if a.flip_sign else -1)
        ok = np.isfinite(l)
        overlap = ok & np.isfinite(los)
        if overlap.sum() > 500:
            l = l + np.nanmedian(los[overlap] - l[overlap])
        else:
            coherent = ok & (e["coh"] > 0.7)
            l = l - np.nanmedian(l[coherent if coherent.sum() > 1000 else ok])
        fill = ~np.isfinite(los) & np.isfinite(l)
        los[fill] = l[fill]
        better = e["cover"] & (e["coh"] > coh)
        coh[better] = e["coh"][better]
        cover |= e["cover"]
    # Zero of the map: the median of coherent ground inside the site's reference box, or of all coherent ground.
    W_, H_ = terrain["width"], terrain["height"]
    lons = aoi["west"] + (np.arange(W_) + 0.5) / W_ * (aoi["east"] - aoi["west"])
    lats = mercator_lat((np.arange(H_) + 0.5) / H_, aoi["north"], aoi["south"])
    sane = np.isfinite(los) & (coh > 0.5)
    box = pair.get("refbox")
    if box:
        inbox = (lons[None, :] >= box[0]) & (lons[None, :] <= box[2]) & (lats[:, None] >= box[1]) & (lats[:, None] <= box[3])
        if (sane & inbox).sum() > 500:
            sane = sane & inbox
            print(f"  zero reference: {int(sane.sum())} coherent pixels in the reference box")
    if sane.sum() < 500:
        sane = np.isfinite(los) & (coh > 0.3)
    los = los - np.nanmedian(los[sane])
    los = np.where(np.isfinite(los), los, 0.0).astype(np.float32)
    ev = {"lam": evs[0]["lam"], "cover": cover}

    dcoh = None
    pre_pair = (a.pre_ref, a.pre_sec) if (a.pre_ref and a.pre_sec) else pair.get("pre")
    if pre_pair:
        pre_ref, pre_sec = pre_pair
        pres = pick_granule(
            earthaccess.search_data(
                short_name=SHORT_NAME, bounding_box=(aoi["west"], aoi["south"], aoi["east"], aoi["north"]),
                temporal=((dt.date.fromisoformat(pre_ref) - dt.timedelta(days=2)).isoformat(),
                          (dt.date.fromisoformat(pre_sec) + dt.timedelta(days=2)).isoformat()), count=200),
            pre_ref, pre_sec, pair.get("track"), pair.get("orbit"),
        )
        if not pres:
            raise SystemExit("no pre-event granule matches the pre-event pair")
        pcoh = np.zeros(shape, np.float32)
        pcover = np.zeros(shape, bool)
        for g in pres:
            print(f"Reading pre-event {g['umm']['GranuleUR']} …")
            pre = extract(g, earthaccess.open([g])[0], terrain, wanted_phase=False)
            better = pre["cover"] & (pre["coh"] > pcoh)
            pcoh[better] = pre["coh"][better]
            pcover |= pre["cover"]
        dcoh = np.clip(pcoh - coh, 0, 1) * (pcover & ev["cover"])

    W, H = terrain["width"], terrain["height"]
    payload = [los.astype(np.float32).tobytes(), np.round(np.clip(coh, 0, 1) * 255).astype(np.uint8).tobytes()]
    if dcoh is not None:
        payload.append(np.round(np.clip(dcoh, 0, 1) * 255).astype(np.uint8).tobytes())
    (folder / "gunw.bin").write_bytes(b"".join(payload))
    masked = (coh > 0.3) & np.isfinite(los)
    stats = {
        "width": W,
        "height": H,
        "hasDcoh": dcoh is not None,
        "granule": ", ".join(g["umm"]["GranuleUR"] for g in picks),
        "pair": {"ref": ref, "sec": sec},
        "wavelengthM": ev["lam"],
        "signFlipped": a.flip_sign,
        "ionosphereRemoved": bool((not a.no_iono) and all("iono" in e for e in evs)),
        "coverage": float(ev["cover"].mean()),
        "track": pair.get("track"),
        "orbit": pair.get("orbit"),
        "coherentShare": float(masked.mean()),
        "losMinCm": float(los[masked].min() * 100) if masked.any() else None,
        "losMaxCm": float(los[masked].max() * 100) if masked.any() else None,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "NISAR L2 GUNW (provisional) via ASF DAAC / NASA Earthdata",
    }
    (folder / "gunw.json").write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats, indent=2))
    print(f"\nWrote {folder / 'gunw.bin'} — reload the app: the signal chip now reads 'NISAR GUNW'.")
    if a.site == "venezuela":
        print("Sanity check (openSEPPO reference, different AOI/version): about −43 to +48 cm after coherence > 0.3, ~50% retained.")


def _has_netrc() -> bool:
    return (Path.home() / ".netrc").exists() or (Path.home() / "_netrc").exists()


if __name__ == "__main__":
    sys.exit(main())
