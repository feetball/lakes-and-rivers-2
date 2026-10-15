Real NWPS (https://api.water.noaa.gov/nwps/v1) responses captured on 2026-10-02,
used by tests/gaugeStatus.test.mjs and tests/gaugeDetail.test.mjs.

| File | Source | Notes |
| --- | --- | --- |
| list-sample.json | `GET /gauges?state=TX`, selected rows | `{gauges: [...]}`; includes AMAT2 (forecast), HNFT2/GRHT2/LNXT2 (no flood stages), -999 "no reading" rows |
| gauges-meta-sample.json | public/data/gauges-meta.json as shipped, matching rows | before the honest-gray fix |
| AMAT2-record.json | `GET /gauges/AMAT2` | Canadian River at Amarillo: impacts, crests |
| AMAT2-forecast.json | `GET /gauges/AMAT2/stageflow/forecast` | 20 points, crest 7.5 ft 2026-10-03 06Z |
| AMAT2-observed-tail.json | `GET /gauges/AMAT2/stageflow/observed` | last 60 h of the 30-day series (the full one is 430 KB) |
| BKCT2-observed-tail.json | `GET /gauges/BKCT2/stageflow/observed` | last 60 h, falling |
| BOQT2-observed-tail.json | `GET /gauges/BOQT2/stageflow/observed` | from 2026-09-26: gappy, contains a -9999 row |
| HNFT2-observed-tail.json | `GET /gauges/HNFT2/stageflow/observed` | last 60 h, steady 1.55-1.95 ft |
| HNFT2-record.json | `GET /gauges/HNFT2` | Guadalupe at Hunt: no flood stages, no impacts |
| ABIT2-record.json | `GET /gauges/ABIT2` | Lake Abilene: elevation-style stages |
| no-forecast.json | `GET /gauges/HNFT2/stageflow/forecast` | NWPS's answer for "no forecast": 200, empty data, year-1 issuedTime |

The observed series are cut to a tail only to keep the repo small; every row is as NWPS sent it.
