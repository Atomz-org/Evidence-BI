# Should Evidence read OpenZL instead of parquet?

**No — and the reason is architectural, not a shortcoming of OpenZL.** Trained
OpenZL turns out to *beat* parquet's best compression while running 3.6x faster.
It still loses here, because compression ratio is not what makes Evidence's
queries fast.

| lever | worth |
|---|---|
| **Clustering rows on write** | **5.6x fewer bytes read** |
| Raising zstd from level 3 to 6 | 1.06x smaller |
| Swapping the codec for trained OpenZL | 1.12x smaller, **but forfeits range requests** |

The one thing that would make queries dramatically faster is free, already
supported, and currently unused. The proposed change is the smallest of the
three and would give up the mechanism the largest one depends on.

Reproduce with `tests/bench-openzl.mjs` and `tests/bench-layout.mjs`.

The proposal was to compress Evidence's data with [OpenZL](https://github.com/facebook/openzl)
and query it without decompressing, beating DuckDB's native parquet reader. Two
of those three things turn out not to be available, and the third is already
solved better by parquet.

## What OpenZL actually is

A compression library. Its README: *"OpenZL takes a description of your data and
builds from it a specialized compressor optimized for your specific format"* —
C/C++, BSD, a family of trained compressors sharing one universal decompressor.
Production-grade at Meta, genuinely clever, and used here as intended.

It documents no random access and no partial decode. There is no "query it
compressed" mode, because that is not what a compression framework does. Getting
a row means decompressing the frame that contains it.

## Why that matters more for Evidence than for most tools

Evidence serves parquet over HTTP and queries it in the browser with
duckdb-wasm. [`browser.js:135`](../vendor/evidence/packages/lib/universal-sql/src/client-duckdb/browser.js#L135)
registers each file as `DuckDBDataProtocol.HTTP`, which means DuckDB reads the
footer, works out which column chunks the query needs, and **range-requests only
those bytes**.

So parquet already does "don't decompress what you don't need" — at page
granularity, with an index. The competition for a whole-file codec is not "the
file"; it is "the handful of column chunks this query touches."

Measured on this project's real `needful_things/orders.parquet`:

| | bytes |
|---|---|
| whole file | 428,224 |
| footer + metadata | 7,061 |
| `order_month` + `category` + `sales` | 17,653 |
| **needed for `select month, category, sum(sales)`** | **24,714 — 5.8% of the file** |

A whole-file codec has to move 100% before the first row is readable. Even a
codec that halved the file would move 50% where parquet moves 5.8% — roughly
**8.6x more bytes for the same query**. Compression ratio cannot win an argument
against not reading the data at all.

This is the crux, so it is worth stating plainly: the trained OpenZL result
below is *better than parquet's best compression*. It still loses here, by a
wide margin, because a 12% smaller artifact that must be fetched whole cannot
beat a larger artifact that is 94% skipped.

## Compression, measured fairly

OpenZL's parquet profile wants *canonical* parquet: PLAIN encoding, no
dictionary, no compression. DuckDB writes `RLE_DICTIONARY` for every
low-cardinality column even at `COMPRESSION uncompressed`, and OpenZL rejects
that outright — so the benchmark writes the canonical form with pyarrow to give
OpenZL the input it asks for.

2,000,000 rows x 15 columns, shaped like the orders mart:

| variant | size | vs parquet+zstd | compress | decompress |
|---|---|---|---|---|
| **openzl: trained** | **31.76 MB** | **−11.8%** | **1415 ms** | 159 ms |
| parquet: zstd level 19 | 31.82 MB | −11.6% | 5086 ms | — (streams) |
| zstd −19 over whole file | 32.69 MB | −9.2% | 64789 ms | — |
| openzl: untrained profile | 34.14 MB | −5.2% | 3647 ms | 842 ms |
| parquet: zstd (default) | 36.00 MB | — | 430 ms | — |
| parquet: snappy | 59.27 MB | +64.6% | 422 ms | — |
| parquet: canonical PLAIN | 288.06 MB | — | — | — |

**Trained OpenZL is a genuinely good compressor.** It edges out parquet's best
setting on size (by 0.2% — call it a draw) while compressing **3.6x faster**,
decompresses at 1.8 GB/s, and round-trips byte-identically. Training is what
makes the difference: it is worth ~7%, which is the gap between losing to
`zstd:19` and drawing with it. An evaluation that skips training — as the first
run of this one did — understates OpenZL badly.

Two silent traps on the way there, both of which look like "training does
nothing":

- `zli train` takes a sample **directory**. Given a single file it reports
  `Picked 1 samples out of 1 samples` and fails.
- The trained compressor is applied with `-c`, **not** `--profile-arg`.
  `--profile-arg` is accepted, ignored, and returns a byte-identical result to
  the untrained run.

So the compression case is a draw on size and a win on speed. It still does not
change the recommendation, because size was never the constraint.

### A number worth distrusting

An earlier run of this benchmark reported OpenZL at **328x**. That was a bug in
the *generator*, not a result: every column was derived from `i % N`, making the
table a periodic function of the row index, which delta plus RLE flattens to
nothing. Realistic entropy collapsed the advantage to 5.2%.

Worth recording because 328x is exactly the kind of number that ends an
evaluation early in the wrong direction. The generator now draws values at
random from a fixed seed, preserving cardinality and type while carrying real
entropy.

## Where OpenZL would genuinely pay

Not in the query path — at rest and in transit, for data nobody is querying:

- **Source archives.** Raw extracts kept for replay, read rarely and whole.
- **Cold partitions** aged out of the served set.
- **CI artifacts** between pipeline stages.

The pattern is *always read in full, never queried in place*. That is where a
5% edge over zstd is free and the decompression cost is already being paid.
Nothing in Evidence's served path fits that description.

## The version that would actually work

If reading OpenZL-compressed data in place is the goal, the honest design is a
**DuckDB extension** exposing `read_openzl()` over a container format that keeps
per-column-chunk framing — so selective decode survives:

```
[header][chunk index: column -> offset, length, row range][zl frame][zl frame]...
```

One OpenZL frame per column chunk, an index in the footer, and the reader
decodes only addressed frames. That preserves the property that makes parquet
fast, while substituting OpenZL for its codec.

Honest cost:

| | |
|---|---|
| Container format + reader + writer | 2–3 weeks |
| DuckDB extension (C++, `read_openzl` table function, projection/filter pushdown) | 3–4 weeks |
| duckdb-wasm build with a custom extension, plus range-request plumbing | 2–4 weeks, highest risk |
| Evidence integration and correctness tests against a parquet control | 1–2 weeks |

Call it **2–3 months**, and at the end of it the artifact is ~5% smaller than
`parquet + zstd:19` while being a format only this stack can read. The submodule
at `vendor/duckdb` (pinned to v1.4.2, matching the engine actually in use) is
there if that is the road taken.

## What to do instead

The goal was "query faster." The codec is the wrong lever for that, and the
right one is already available and unused.

### 1. Cluster on write — worth 5.6x, measured

Parquet keeps min/max statistics per row group, so a reader skips groups that
cannot satisfy a filter. Whether that works depends entirely on the order rows
were written in, which is currently left to chance.

`node tests/bench-layout.mjs`, 2M rows, filter `category = 'Tools'`:

| layout | file | row groups hit | bytes read | |
|---|---|---|---|---|
| as-is (insertion order) | 26.07 MB | 20 of 20 | 7.010 MB | 1.0x |
| sorted by month | 26.06 MB | 20 of 20 | 7.009 MB | 1.0x |
| **clustered: category, month** | 29.85 MB | **4 of 20** | **1.253 MB** | **5.6x** |
| clustered: month, category | 29.43 MB | 20 of 20 | 6.243 MB | 1.1x |

**5.6x from ordering rows differently**, against 1.12x for the best codec swap
available. Note the last row: clustering only helps when the *leading* column is
the one being filtered — `month, category` buys almost nothing for a category
filter.

The tradeoff is real and should be stated: clustering by `category` de-clusters
everything else (a month-window filter goes from 1 row group to 10) and the file
grows ~15%, because sorting one column scrambles the locality the others had.
Cluster by what is filtered on most, not by what sorts most naturally.

### 2. Raise the zstd level — worth 6% for free

[`build-parquet.js:203`](../vendor/evidence/packages/lib/universal-sql/src/build-parquet.js#L203)
writes `CODEC 'ZSTD'`, which is level 3. Measured on the same 2M rows (warm, best
of two):

| level | size | vs level 3 | write |
|---|---|---|---|
| 3 (current) | 35.99 MB | — | 165 ms |
| **6** | **33.84 MB** | **−6.0%** | 254 ms |
| 9 | 33.40 MB | −7.2% | 373 ms |
| 12 | 33.19 MB | −7.8% | 685 ms |
| 15 | 33.12 MB | −8.0% | 1689 ms |
| 19 | 31.80 MB | −11.6% | 4609 ms |

Level 6 takes half the available gain for 90 ms per 2M rows. Past 12 the curve
is flat and the cost is not.

*(An earlier run of this appeared to show level 6 as both smaller **and** faster
than level 3 — that was first-iteration warm-up, and it disappears once the
writer is warmed and each level is run twice. Worth noting because "free
improvement" is exactly the shape of result that deserves a second run.)*

### 3. Revisit OpenZL if it ships chunk-addressable frames

The blocker is the container, not the compressor. Trained OpenZL already matches
parquet's best compression at 3.6x the speed; if a frame ever becomes partially
decodable, the calculation changes.

## Reproducing

```bash
git clone --depth 1 https://github.com/facebook/openzl && cd openzl
git submodule update --init --recursive && make zli   # needs cmake

python3 -m venv .venv && .venv/bin/pip install pyarrow   # canonical parquet writer

BENCH_PYTHON=.venv/bin/python node tests/bench-openzl.mjs \
    --rows 2000000 --zli /path/to/openzl/zli
```

Writes to `.bench/` (gitignored, a few hundred MB). `--rows` scales it; the
ranking is stable from about 500k rows up.
