# Portable replay/recovery runner

Keep the four runner modules in this bench directory together. The evidence handoff contains the frozen public inputs and exact source archive. The runner imports the repository's normal `pg` dependency. It executes production backend modules from the exact repository root supplied as its first argument; it does not contain a decoder/projector fork.

Supply recorded public inputs and an installed local PostgreSQL18.6 binary directory. The runner creates a **new** loopback-only disposable cluster with an independently generated password, writes that password only in mode0600 files inside a mode0700 scratch directory, stops only that cluster, and never prints its credentials. It performs real process kill/restart and custom logical dump/restore. It never contacts a live chain endpoint. The recorded adapter throws for uncaptured ranges/class observations rather than inventing history.

Required inputs for portable use:

- CLI: `<frozen-repository-root> <exact-full-source-SHA> [label]`.
- `MEASUREMENT_CAPTURE_DIR`: contains historical.json, recent.json, registry.json and sampled historical/recent class JSON.
- `MEASUREMENT_STATE_DIR`: contains state.json with actual per-block class observations.
- `MEASUREMENT_WITH_LIVE=1` and `MEASUREMENT_LIVE_DIR` optionally add captured live.json.
- `MEASUREMENT_PG_BIN_DIR`: local PostgreSQL18.6 binaries (postgres,initdb,pg_ctl,createdb,pg_dump,pg_restore).
- `MEASUREMENT_SCRATCH_DIR`: task-local scratch for the isolated cluster/password, outside source control.
- `MEASUREMENT_OUTPUT_DIR`: result/dump directory, outside source control.
- `MEASUREMENT_PG_MODULE`: optional explicit module specifier for a separately verified task-local pg runtime; normal installed `pg` is the default.

An archive must have SOURCE-PROVENANCE.json with the exact SHA. A Git checkout's HEAD and executed tracked backend/registry/SDK sources must match the supplied SHA. Both conditions are checked before database creation. A caller is responsible for giving trusted source code, not an arbitrary untrusted archive.

```sh
MEASUREMENT_CAPTURE_DIR=/absolute/public-capture \
MEASUREMENT_STATE_DIR=/absolute/public-state \
MEASUREMENT_WITH_LIVE=1 \
MEASUREMENT_LIVE_DIR=/absolute/public-live \
MEASUREMENT_PG_BIN_DIR=/absolute/postgresql18.6/bin \
MEASUREMENT_SCRATCH_DIR=/absolute/ignored/measurement-scratch \
MEASUREMENT_OUTPUT_DIR=/absolute/ignored/measurement-results \
node services/marketplace-backend/bench/portable-run-replay.mjs \
  /absolute/frozen-repository 6a5caf2db4b8a72d411ad7c7e8b61345fc65e43a candidate_final
```

Results explicitly report partial sample starts, blocked strict original-registry preflight, offline RPC timing, synthetic application/media preservation fixtures, and controlled fork/outage cases. This portable runner is validated against the exact final archive with explicit capture/state/live/binary/output paths. The five-second HTTP/metadata experiments remain separate packet scripts; do not represent replay throughput as network or production throughput.
