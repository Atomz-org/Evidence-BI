# Deploying on a 2 GB server

Everything in this project runs on one small machine, with no managed database,
no hosted semantic layer, no object store and no CDN. Nothing here is a reduced
edition: every page, every connector, the semantic layer, the Rill explore, the
notebook pages and the runtime dashboard builder are all present.

The reason that is possible is a property the project already had, which this
directory makes explicit and then protects.

## The stack is already mostly weightless

`evidence build` emits a **static site** (`@sveltejs/adapter-static`), and every
query on every page runs in the reader's browser on duckdb-wasm over parquet.
The server executes no SQL, holds no session, and keeps no query state. Ten
readers cost the same as one.

So the serve plane is a file server, and the interesting problem is somewhere
else entirely.

## The measurement

`/usr/bin/time -l`, cold builds (`build/` and `.svelte-kit` removed first):

| Heap cap | Peak RSS | Outcome |
|---|---|---|
| default (~1 GB on a 2 GB box) | — | ❌ OOM |
| `--max-old-space-size=896` | 1.57 GB | ❌ OOM |
| `--max-old-space-size=1408` | 1.95 GB | ❌ OOM |
| `--max-old-space-size=1792` | 2.06 GB | ❌ OOM |
| `--max-old-space-size=2048` | **2.82 GB** | ✅ |
| `--max-old-space-size=2560` | 2.74 GB | ✅ |
| `--max-old-space-size=3072` | 3.36 GB | ✅ |
| `evidence sources` | 281 MB | ✅ (needs the ADBC fixtures up) |

Three things follow.

**The build does not fit in 2 GB.** It needs somewhere between 1792 and 2048 MB
of JavaScript heap, and peaks near 2.8 GB resident — against about 1.85 GB
usable. No configuration closes that gap: the build is already minified with no
sourcemaps, and what is large is Vite's module graph, the minifier, and
SvelteKit prerendering fourteen pages. There is nothing switched on that should
be off.

**Node's default is a trap.** V8 sizes its default heap from visible RAM, so on
a 2 GB box it picks roughly 1 GB and the build dies at `Ineffective
mark-compacts near heap limit` — *before swap is ever touched*. Adding swap
without also raising the cap fixes nothing, which is the single most
counter-intuitive thing about deploying this.

**More headroom is not better.** Peak RSS plateaus around 2.8 GB across
2048–2560, then climbs to 3.36 GB at 3072 as V8 stops bothering to collect.
On this box that is half a gigabyte of extra paging for nothing, so the default
is 2048.

> Measured on macOS/arm64. Linux/x86-64 allocator behaviour differs — expect the
> same shape and the same conclusions, but re-measure with `/usr/bin/time -v` on
> the actual server before tuning `EVIDENCE_BUILD_HEAP_MB` finely.

## Two ways to run this

**Mode A — build elsewhere, serve here (recommended).** The build's *output* is
97 MB of static files and nothing about producing them has to happen on the
server. `deploy/publish.sh user@host` builds on your own machine, precompresses,
rsyncs with `--link-dest` so unchanged wasm binaries cost nothing, and flips the
symlink. The server then needs no node, no `node_modules`, no dbt, no Postgres
and no ClickHouse — just Caddy and Cube, **~420 MB steady**, and the 2 GB
constraint stops being interesting. This is still fully self-hosted: one rsync
over ssh between two machines you own.

**Mode B — build on the server.** `deploy/build.sh`, driven by
`evidence-build.timer`. Genuinely works, and pages hard while it does. Fine for
a nightly batch job; the rest of this document is mostly about making it safe.

Mode B is what `install.sh` sets up, because it is the self-contained answer to
the question as asked. Switch to Mode A by disabling the timer:
`systemctl disable --now evidence-build.timer`.

## The design

Two planes that never share the box.

### Serve plane — always on, ~500 MB

| Process | RSS | Why |
|---|---|---|
| Caddy | 31 MB (measured) | static files, precompressed |
| Cube | 483 MB as shipped (measured), capped at 384 MB here | `/noodle-cube` is genuinely live |
| systemd, sshd, journald | ~80 MB (estimate) | |

That still leaves roughly 1.2 GB of page cache — more than enough to hold the
entire 97 MB site in RAM, so the disk is read approximately once after a build.

**Cube is the only always-on service besides the web server.** Nothing else
needs a process: `/rill` compiles `rill/` to duckdb-wasm and renders with no
Rill server running, and every other page is parquet in the browser.

`cubejs/cube:v1.7.17` in dev mode — what `cube/up.sh` starts — measures **483 MB**
for a model of two cubes and twelve members with **no pre-aggregations**. Most of
that is the playground, the model watcher and Cube Store, none of which a server
needs. `deploy/cube/cube.js` runs the server alone with `CUBEJS_DEV_MODE=false`
on loopback, and `evidence-cube.service` holds it to a 256 MB V8 heap with a
384 MB cgroup ceiling. The model files are the same ones `cube/up.sh` uses
locally, read in place.

> The 483 MB is measured; the native figure is bounded by the cgroup rather than
> measured, because these numbers come from a dev machine. Check it with
> `systemctl show -p MemoryCurrent evidence-cube` on the real server and lower
> `MemoryMax` if it settles well under.

### Build plane — transient, exclusive, ~2 GB

`deploy/build.sh` sequences it so the build gets the whole machine:

1. **Stop Cube** — returns up to 384 MB (its cgroup ceiling). `Conflicts=` in the unit makes this
   structural rather than polite.
2. **Start Postgres + ClickHouse, run `evidence sources`, stop them again** —
   they are needed for seconds and cost ~390 MB while up.
3. **`evidence build`** alone, with an explicit `--max-old-space-size=2048`.
4. **Precompress**, then flip a symlink.

The shortfall between ~1.85 GB usable and ~2.8 GB needed is covered by **zram**
(`deploy/zram-setup.sh`): a compressed swap device in RAM. What overflows is a
V8 heap — objects, ASTs, strings — which compresses roughly 3:1 under zstd, so
about a gigabyte of cold heap can be held in a few hundred megabytes of real
memory. A 2 GB disk swapfile sits behind it at lower priority as genuine
overflow, and `OOMScoreAdjust=800` on the build unit means that if the box is
truly exhausted the kernel takes the build rather than sshd.

Be clear-eyed about what this buys: it makes a ~2.8 GB build *complete* on a
2 GB box, not run well. Expect heavy paging, and a build measured in many
minutes rather than the ~45 s it takes on a developer machine. That is a fine
trade for a nightly job and a poor one for an interactive loop — which is the
real argument for Mode A.

This is why `evidence-build.service` deliberately sets **no** `MemoryMax`.
Capping the cgroup would reintroduce exactly the failure being engineered
around.

### The site is never down

The build writes to `/srv/evidence/releases/<timestamp>` and flips
`/srv/evidence/current` at the end. Caddy only ever reads `current`. A failed
build changes nothing, and a rollback is one symlink:

```bash
ln -sfn /srv/evidence/releases/<older> /srv/evidence/current
```

## What made deployment fail before this

Two things, both found by trying to run it on a server rather than a laptop.

**`/noodle-cube` hard-coded `http://localhost:4000`.** Those `fetch` calls are
made by the *browser*, so on any real host `localhost` is the reader's own
machine, not the server. The page worked only for the person who ran
`npm run dev`. It now calls `/cubejs-api/...` on its own origin and Caddy proxies
that to Cube on loopback — which additionally means Cube never binds a public
port. `VITE_CUBE_API_URL` restores the split-port arrangement for local dev,
where Evidence is on :3000 and Cube on :4000 with no proxy between them.
`tests/static-server.mjs` proxies the same path, so the browser suites now
exercise the topology that ships.

**`evidence sources` aborts on the first unreachable datasource.** This project
has two ADBC sources pointed at a local Postgres and ClickHouse, and
`adbc_clickhouse` sorts first — so with those servers down, a rebuild fails
before extracting anything, silently leaving every other source's parquet stale.
`build.sh` starts them, waits for ClickHouse's `/ping`, and treats a timeout as
fatal rather than as a warning.

## Disk

| Path | Size | Mode A | Mode B |
|---|---|---|---|
| `node_modules` | 1.0 GB | no | yes — needed to rebuild |
| `vendor/` | 527 MB | no | **292 KB of it** — see below |
| `build/` (per release) | 97 MB | yes, ×3 | yes, ×3 |
| parquet | 520 KB | yes | yes |

`vendor/` is four git submodules — the Evidence, Cube and DuckDB sources. It
looks like pure development weight and is *almost* entirely excludable, with one
trap: `npm ci` runs postinstall, which runs `scripts/apply-notebook-core.mjs`,
which copies two payloads out of the vendored monorepo into `node_modules`:

```
packages/evidence/{cli.js,notebook}      .ipynb as a native page format
packages/lib/universal-sql/src/...       parquet written at zstd 6, not 3
```

Excluding the directory wholesale does not fail loudly — it silently drops the
notebook page format and inflates every parquet file. So `install.sh` ships
exactly those two paths (292 KB) and leaves the other 527 MB at home.

Of the 97 MB build, 71 MB is the duckdb-mvp and duckdb-eh wasm pair — both
shipped because the browser picks one at load. `precompress.sh` brotli's them to
roughly 15 MB once, at build time, so Caddy `sendfile()`s a precompressed file
and never spends CPU or a per-request buffer on compression.

## Running the compressed build locally

```bash
npx evidence build                 # -> ./build
deploy/precompress.sh build        # writes .br/.gz siblings (~3 min)
deploy/serve-local.sh              # http://localhost:8080
```

`deploy/serve-local.sh` runs **`deploy/Caddyfile` itself**, pointed at `./build`
on a high port, so content negotiation, cache headers and the `/cubejs-api`
proxy behave exactly as they will on the server.

Do not reach for `node tests/static-server.mjs build 4321` here. It works, but it
serves raw files and never looks at the `.br`/`.gz` siblings — so the 71 MB wasm
pair crosses the wire uncompressed and you are not testing what a reader gets.

For `/noodle-cube`, start Cube first — `./cube/up.sh`. The proxy points at
`127.0.0.1:4000` just as in production, so no `VITE_CUBE_API_URL` is needed;
that variable is only for `npm run dev`, where Evidence is on :3000 and nothing
proxies.

Verified end to end on this build:

| Check | Result |
|---|---|
| all 13 pages | 200 |
| `duckdb-mvp.wasm`, `Accept-Encoding: br` | 5.4 MB, `Content-Encoding: br` |
| same file, `gzip` | 8.3 MB |
| same file, `identity` | 37.5 MB, `Content-Type: application/wasm` |
| `/cubejs-api/v1/load` through the proxy | EMEA 188,937.71 under `not_cancelled` — the figure `pages/noodle-cube.md` documents |

## Install

On the server, once:

```bash
sudo deploy/install.sh
```

It installs zram first (everything after it would page without it), then Node,
Caddy, the two ADBC fixtures — sized down by the drop-ins in
`deploy/datasources/` and left **disabled at boot** — then the app, Cube, the
systemd units, and a first build.

Day to day:

```bash
# Mode B — rebuild on the server (nightly at 03:15 via the timer)
systemctl start evidence-build
journalctl -u evidence-build -f

# Mode A — build on your machine, ship the artifact
deploy/publish.sh user@server

systemctl status evidence-cube
free -m
```

Rolling back is moving one symlink; see above.

## Running Rill for real

`/rill` needs no Rill process. `./rill/up.sh` starts the real thing at :9009 to
check that the compiled model and the YAML still agree — a parity check, not a
service. It is heavy (Go plus its own DuckDB) and should be run when the build
is not, then stopped. Nothing on the deployed site depends on it.
