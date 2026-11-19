# Market Data Sources — Deriv (XAU/USD)

## When to Use

Use when the chart needs a real live XAU/USD feed (not a simulated random walk)
and Deriv is the chosen provider — i.e. wiring/replacing a stream handler,
backfilling candles, or labelling price provenance.

## Connection

- Public market-data WebSocket, **no auth token required**:
  `wss://api.derivws.com/trading/v1/options/ws/public?app_id=<APP_ID>`
  (the public v3 endpoint; older documented hosts may not resolve in every
  network — probe the endpoint before wiring).
- `app_id` is free: register an application at developers.deriv.com. Pin your own
  in env (`DERIV_APP_ID`) so the app is attributable and not rate-limited as a
  shared id.
- REST account/trading endpoints use `Authorization: Bearer` + `Deriv-App-ID`;
  market data alone does not need it, so an unused token must not be attached.

## Symbol & endpoints

- Gold: `frxXAUUSD` (Gold/USD, metals/commodities market).
- `ticks` with `subscribe: 1` — realtime stream for a symbol.
- `ticks_history` with `style: "candles"` — candle aggregates. Working request
  shape: `{ ticks_history, adjust_start_time: 1, count, end: "latest",
  style: "candles", granularity: <seconds> }`.
- Response shape varies by endpoint: the public v3 endpoint puts `candles` at
  the **root** of the response; the legacy shape nests them under
  `history.candles`. A parser must accept both and reject anything else.
- `ohlc` — realtime candle stream for a symbol + granularity.
- `active_symbols` — list tradable symbols (confirm the code before wiring).

## Granularity / timeframe support

- `granularity` is seconds. Deriv accepts the standard ladder:
  `60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 43200,
  86400, 604800, 2592000`.
- Verify support empirically before exposing a timeframe: request candles and
  assert consecutive `epoch` diffs equal the requested granularity. A successful
  `count > 0` with uniform diffs is the only proof — docs and the ladder list do
  not guarantee a given symbol serves it.
- Chart switchers must only list timeframes the provider serves. If a timeframe
  is missing, drop it; a fallback derived from another timeframe (e.g. 30m
  subdivided from H1) is allowed only with an `estimated` label, never `real`.

## Caveats (must be surfaced in the UI/provenance)

- **CFD, not spot.** Deriv Gold/USD is a broker CFD; spread and rate differ
  slightly from interbank spot XAUUSD. If the model was trained on a different
  historical source, the live feed is a different instrument — label it
  (`source: deriv-cfd`, `isSimulated: false`) and never merge the two series
  silently.
- **Market hours.** Gold trades ~Sun 22:10–Fri 21:55 GMT with a daily break;
  outside those windows the stream is silent. Hold the last candle and show a
  `market closed` state instead of freezing the chart without explanation.
- **Tick sparsity.** Ticks are not institutional-frequency; expect gaps. Aggregate
  to 1m/5m/15m buckets client- or server-side rather than assuming a tick per
  second.
- **No bid/ask, no volume.** The public stream does not provide depth; `bid`/`ask`
  are `null` and candle `volume` is unknown. Persist `0`/`null` — never invent a
  number and never let a synthetic default overwrite a real CSV volume.

## Persistence path

- Live ticks are ephemeral: broadcast only, do not write per tick.
- Candles (15m/30m/1h/4h) belong on the warm path: worker fetches
  `ticks_history` per timeframe and upserts into `price_candles` with
  `id = <symbol>_<tf>_<epoch>` so re-syncs are idempotent (SKILL.md §1).
- The candle API is DB-first: `price_candles` (Deriv) then CSV fallback, and the
  response carries the `source` actually used.
