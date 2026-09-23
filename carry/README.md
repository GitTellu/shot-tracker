# Carry

A second app next to Shot Tracker, built from the Claude Design prototype "Carry Prototype". It runs at `./carry/`, keeps its own data (IndexedDB database `carry`) and has its own service worker. Shot Tracker's worker skips `/carry/`.

## Where the numbers come from

| Shown | Source |
|---|---|
| Hole layout, greens, fairways, bunkers, water, par | OpenStreetMap through Overpass, using Shot Tracker's `osmConvert` |
| Course search by name | Nominatim (OpenStreetMap) |
| Yardages, front/back | Phone GPS against the mapped green outline |
| Ball positions | GPS fixes averaged for 3 s after each tap |
| Wind | Open-Meteo current 10 m wind (free, no key) |
| Map imagery | USGS National Map (US only), with OpenStreetMap underneath |
| Club distances | Stock numbers until a club has 5 measured full shots over 3 rounds. After that, the median GPS total distance |
| Strokes gained | `baseline.js`: expected strokes by lie and distance. **Empty until a published table is added** |
| Friends | Share links that carry your averages. There is no server |

## Adding the strokes-gained baseline

Fill in `baseline.js` in the format described there, from a published source, and name that source in `source`. Rounds already played are scored as soon as the table exists. Two mappings are Carry's own choice and are not part of the source table: the Fringe lie is scored as fairway, and Other is scored as recovery.
