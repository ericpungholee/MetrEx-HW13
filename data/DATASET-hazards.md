# Multi-peril datasets (scenarios 2–4)

These files were retrieved on 2026-11-21. `scripts/normalize-hazards.ts` rebuilds each normalized file from the raw bytes in `data/raw/`, refusing any raw file whose SHA-256 differs from the pins below. `--check` rebuilds the files in memory and compares them with the committed ones. Each normalized file pins its rule and coverage window in `metrex.rule` (see [docs/spec-multiperil.md](../docs/spec-multiperil.md) §4).

```bash
pnpm tsx scripts/normalize-hazards.ts --check
```

| Scenario | File | SHA-256 |
|---|---|---|
| 2 Hurricane | `atlantic-hurricanes-2017-09.geojson` | `49472d1dd7278f983cedf004146e1694ae6d339d7e6af728608dd653ec1ceacf` |
| 3 Earthquake | `south-napa-2014-08.json` | `49a127e836c37b74db4e0f1f60b81600d55c2b7c99cc501cc5ea8661cd172e3e` |
| 4 Tornado | `central-iowa-tornadoes-2024-05.geojson` | `ab76b21d4f7f1b631adbc1ba44712e489e3f00c31363886149ab40769f9bfc96` |

As with the wildfire file, the private oracle copy lives in `METREX_ORACLE_DATA_DIR`. Bots, the keeper and the trading app never read it.

## Hurricane: Atlantic hurricanes, September 2017

- **Source:** NOAA National Hurricane Center best-track GIS, `https://www.nhc.noaa.gov/gis/best_track/<id>_best_track.zip` for `al112017` (Irma), `al122017` (Jose), `al132017` (Katia), `al142017` (Lee) and `al152017` (Maria).
- **Used:**
  - the 64-kt `*_windswath` polygons of every storm whose track overlaps the month;
  - Irma's `al112017_radii`, used only to check that the 64-kt radii issued before September 1 lie east of 60° W, so no August swath reaches the demo property.
- **Rule:** the property is inside any 64-kt swath piece (`inside_footprint`). Points inside a hole are outside. Coverage is 2017-09-01T04:00Z → 2017-10-01T04:00Z (America/New_York).
- **Limitation:** a best-track swath covers a storm's whole life. Swaths of storms that overlap the month are included whole, and the radii check above guards the one storm (Irma) that began in August.

| Raw file | SHA-256 |
|---|---|
| `nhc-2017/al112017_windswath.shp` | `7ecc3350b758d37c50255dcb825ec31456ff201ea31db31f8170834817abfd6a` |
| `nhc-2017/al112017_windswath.dbf` | `73d63b2ba26bc909e06cb08ad5bac788a43ccdbd4cf39269d47b21714a93607a` |
| `nhc-2017/al122017_windswath.shp` | `463146a7599a4441a0c6d3d040983387f4cc5819442e2bc6feaba17df7bd6405` |
| `nhc-2017/al122017_windswath.dbf` | `7a59088f431c6219dbbe4c90ba14cfe20ae49bb48edafb42c2f89460a016f74a` |
| `nhc-2017/al132017_windswath.shp` | `3a4682a22972d6fcb5f63b6c431472f590b7fece2244d40e577b63cfc61fbeeb` |
| `nhc-2017/al132017_windswath.dbf` | `48897efc57828bd37dfef93f4f1357c46bb0fa139f685a544f192aa26d8b0c67` |
| `nhc-2017/al142017_windswath.shp` | `7e6220f46c8cf9f1f04171f58ff884d181d338ab8610b016de9eaf06ded90ab5` |
| `nhc-2017/al142017_windswath.dbf` | `50e360552179726eb1c785e96ceac6816590bdb4e3c1241952dbc0f68df759a6` |
| `nhc-2017/al152017_windswath.shp` | `70cc01395decf5517f59fbb8761b878e360210d2127e4cee95a7a1c8e9849df0` |
| `nhc-2017/al152017_windswath.dbf` | `2cabb80095f8b91f2cf4b7ca063d9c055be78b6c091273d07d76d9158cfe75fc` |
| `nhc-2017/al112017_radii.shp` | `b2bba6b7353964bf7cad0baf8a40c718297471e219e761a487ec01fab7ef1efd` |
| `nhc-2017/al112017_radii.dbf` | `62d68e668c294795028492a1db6309a749571851651f0b713dccbda6ab987be0` |

## Earthquake: South Napa M6.0, 24 August 2014

- **Source:** USGS ShakeMap for event `nc72282711` (atlas version), `https://earthquake.usgs.gov/product/shakemap/nc72282711/atlas/1624995941193/download/grid.xml`. The dataset also lists the FDSN event-catalog query for M4+ events within 150 km during the window. It is recorded as a source only. The rule is explicitly scoped to this single ShakeMap. The catalog query is supplementary: `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2014-07-31&endtime=2014-09-02&latitude=38.225&longitude=-122.308&maxradiuskm=150&minmagnitude=4`.
- **Raw file:**
  - `usgs-napa-2014/grid.xml`, SHA-256 `f78b652c0de85368d43dc80c43c394973c6e5462c46e331d7df033a5e22c06ec`;
  - 10 MB, gitignored. Download it to `data/raw/usgs-napa-2014/grid.xml` before running the script.
- **Normalized:**
  - MMI cropped to lat 38.05–38.45 and lon −122.55 to −122.05;
  - each node stored as integers (`lat_e4`, `lon_e4`, `mmi_x10`), with the decimal-to-integer conversion exact.
- **Rule:** MMI × 10 at the nearest node ≥ 80 (MMI VIII). A property more than 1,000 m from every node is not covered, and the oracle refuses it (§4.3). Coverage is 2014-08-01T07:00Z → 2014-09-01T07:00Z (America/Los_Angeles).

## Tornado: central Iowa EF2+ tracks, May 2024

- **Source:** NOAA NWS Damage Assessment Toolkit, layer 1 (surveyed tracks), `https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/FeatureServer/1/query`, queried with `efnum >= 2`, storm dates 2024-04-30 to 2024-06-02, envelope −94.8, 40.9, −92.4, 42.6, and `outSR 4326`.
- **Raw file:** `nws-dat-iowa-2024-05-ef2.geojson`, SHA-256 `e9e3cc43fc482461099496442d6984335283b506d7358e11f698822e599a0d1d`.
- **Normalized:** EF2+ centerlines that start inside the month. There are four tracks, all on 2024-05-21.
- **Rule:** the geodesic distance from the property to any centerline is at most `trigger_distance_m` (500 m) (`track_proximity`). Coverage is 2024-05-01T05:00Z → 2024-06-01T05:00Z (America/Chicago).

## Real property addresses: OpenStreetMap

Coral Gables uses OSM way 1046022736 at 4835 University Drive, tagged as a house. The previous address was the University of Miami Dooly Memorial Classroom Building. [University building inventory](https://space.miami.edu/_assets/pdf/documents/bldg_list.pdf).

Napa uses OSM node 11686888530 at 214 Auberge Path. Napa County’s parcel query returned 047420014000 at that coordinate with residential use and one dwelling. The previous coordinate fell on a vacant parcel. [Napa County Public Parcels](https://www.arcgis.com/home/item.html?id=eef5363332e04774a6f52dfd40a04062&sublayer=1).

`raw/napa-residential-parcels.json` pins the county query, SHA-256 `3eeebc23a5109c8587c9b78724134dce17a51d8867b39808a9790b6d0d6f3bda`. The query requested only parcel IDs, situs and use fields, and dwelling counts. It selected positive dwelling counts in the Napa OSM bounding box using `inSR=4326`. The selector joins canonicalized street addresses and independently checks the ShakeMap threshold.

- **Source:** the OpenStreetMap Overpass API, `nwr["addr:housenumber"]["addr:street"](bbox); out tags center;`, retrieved 2026-11-21. Map data © OpenStreetMap contributors, under the Open Database License (ODbL).
- **Selection:** `scripts/find-real-properties.ts` (rules in [docs/spec-multiperil.md](../docs/spec-multiperil.md) §3), output to `data/market-properties.json`.
- **Rerunning:** `pnpm tsx scripts/find-real-properties.ts` repeats the selection offline from these files. `--fetch --refetch` downloads again; OSM changes over time, so new bytes need new pins.

| Raw file (`data/raw/osm-addresses/`) | Bounding box (S, W, N, E) | SHA-256 |
|---|---|---|
| `pacific-palisades.json` | 34.03, −118.57, 34.08, −118.50 | `dc754f97e4b78eab8dc7e564242e01592d04d89def4e86868bf4f4cd595182ee` |
| `miami.json` | 25.70, −80.30, 25.75, −80.26 | `e05baca343ea6337c887ab7d1a521c65709f665296ae587098b4ce351f815ddd` |
| `napa.json` | 38.21, −122.33, 38.27, −122.28 | `a097e53a065c3075b94538a635076ee0213dae4bea10a20faf49906dd430f7de` |
| `johnston-des-moines.json` | 41.68, −93.75, 41.72, −93.70 | `8fef59fc75f25a2f525d49eba0f4826348dc29667475b294e9bc24f2e0fbbd4e` |
