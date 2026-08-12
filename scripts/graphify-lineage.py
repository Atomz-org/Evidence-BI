#!/usr/bin/env python3
"""Inject Evidence-aware lineage into graphify-out/graph.json.

graphify's AST pass cannot see Evidence's conventions: page frontmatter
`queries:` lists, `${query_id}` chaining, and SQL column derivations. This
script parses those deterministically (every edge is EXTRACTED — literal file
content, no inference) and merges them into the graph:

  loads_query       page  -> query file           (frontmatter `queries:`)
  references_query  page  -> query file           (${metrics_x} in page SQL)
  reads_table       query -> source extract       (dbt_semantic.<table>)
  derived_from      source extract -> dbt mart    (marts.<table>)
  has_column        file  -> column node          (outer SELECT projections)
  derives_from      column -> upstream column     (sqlglot column lineage;
                                                   context = SQL expression)
  uses_column       page  -> metric column        (column referenced in page)
  writes            sync script -> source db      (sync-dbt.sh copies duckdb)

Convergent: every record this script writes is stamped `_origin: "lineage"`, and
each run drops the previous generation of those records before re-deriving them
from the files as they stand now. So a renamed column, a deleted query or an
edited SQL expression leaves nothing stale behind, and descriptions and contexts
are rewritten rather than frozen at whatever the first run happened to see.
Records from graphify's own passes (`_origin: "ast"` / `"semantic"`) are never
touched. Re-run after any /graphify rebuild or after editing pages/queries:

    $(cat graphify-out/.graphify_python) scripts/graphify-lineage.py
"""

import json
import re
import sys
from pathlib import Path

import sqlglot
from sqlglot import exp
from sqlglot.lineage import lineage

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "graphify-out" / "graph.json"

DBT_PROJECT = "code-skills/skill-packs/dbt-skills/use-cases/example-order-revenue-mart/dbt_project"
MART_MODELS = {
    "fct_orders": "models/marts/finance/fct_orders.sql",
    "dim_customers": "models/marts/finance/dim_customers.sql",
    "metricflow_time_spine": "models/marts/metricflow_time_spine.sql",
}


def file_node_id(path: str, existing: dict) -> str | None:
    return existing.get(path)


def col_id(owner_id: str, column: str) -> str:
    return f"col__{owner_id}__{column}"


def edge_key(src: str, tgt: str, relation: str | None):
    """Dedupe key for an edge.

    graph.json declares `directed: false` and the writer does not preserve the
    endpoint order it was given — an edge added as (page, query) can come back
    as (query, page). Keying on an ordered pair would therefore miss the stored
    edge on the next run and append a duplicate every time, so the endpoints go
    into a frozenset and only the relation stays positional.
    """
    return (frozenset((src, tgt)), relation)


def write_report(g: dict) -> None:
    """Rewrite GRAPH_REPORT.md from the graph as it now stands.

    graphify writes its own report during clustering, which is necessarily
    before this script runs — so that report describes a graph that no longer
    exists by the time anyone reads it, and its community sizes cannot add up
    to the node count. Deriving every figure here instead keeps the report and
    the artifact beside it in agreement. Nothing is timestamped: the report is
    a pure function of the graph, so an unchanged graph rewrites byte-for-byte.
    """
    nodes, links = g["nodes"], g["links"]
    degree = {}
    for e in links:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1
    label_of = {n["id"]: n.get("label", n["id"]) for n in nodes}

    confidence = {}
    for e in links:
        c = e.get("confidence", "UNKNOWN")
        confidence[c] = confidence.get(c, 0) + 1
    relations = {}
    for e in links:
        r = e.get("relation", "?")
        relations[r] = relations.get(r, 0) + 1

    communities = {}
    for n in nodes:
        cid = n.get("community")
        if cid is None:
            continue
        communities.setdefault(cid, {"name": n.get("community_name") or f"Community {cid}",
                                     "members": []})["members"].append(n.get("label", n["id"]))
    unassigned = [n for n in nodes if n.get("community") is None]
    files = sorted({n["source_file"] for n in nodes if n.get("source_file")})

    out = ["# Graph Report — Evidence BI", ""]
    out += ["Generated from `graphify-out/graph.json` by `scripts/graphify-lineage.py`,",
            "after lineage injection — so every figure below describes the graph as shipped.", ""]
    out += ["## Summary",
            f"- {len(nodes)} nodes · {len(links)} edges · {len(communities)} communities",
            f"- {len(files)} source files referenced",
            "- Extraction: " + " · ".join(f"{n} {c}" for c, n in sorted(confidence.items())),
            f"- Built from commit: `{g.get('built_at_commit', 'unknown')}`", ""]

    out += ["## Edges by relation"]
    for r, n in sorted(relations.items(), key=lambda kv: (-kv[1], kv[0])):
        out.append(f"- `{r}` — {n}")
    out.append("")

    out += ["## God Nodes (most connected — the core abstractions)"]
    ranked = sorted(degree.items(), key=lambda kv: (-kv[1], label_of.get(kv[0], "")))
    for i, (nid, deg) in enumerate(ranked[:10], start=1):
        out.append(f"{i}. `{label_of.get(nid, nid)}` — {deg} edges")
    out.append("")

    out += [f"## Communities ({len(communities)} total)"]
    for cid, c in sorted(communities.items(), key=lambda kv: (-len(kv[1]["members"]), kv[0])):
        size = len(c["members"])
        # Distinct labels: several nodes can share one label, and listing it
        # twice reads as a duplicate rather than as two members.
        members = sorted(set(c["members"]))
        shown = ", ".join(members[:8])
        more = f" (+{len(members) - 8} more)" if len(members) > 8 else ""
        out += [f"", f"### Community {cid} — \"{c['name']}\"",
                f"Nodes ({size}): {shown}{more}"]
    out.append("")

    if g.get("hyperedges"):
        out += ["## Hyperedges (group relationships)"]
        for h in g["hyperedges"]:
            score = h.get("confidence_score", 0)
            out.append(f"- **{h.get('label', h['id'])}** — {', '.join(h.get('nodes', []))} "
                       f"[{h.get('confidence', '?')} {score:.2f}]")
        out.append("")

    isolated = sorted((label_of[n["id"]] for n in nodes if degree.get(n["id"], 0) <= 1))
    out += ["## Knowledge Gaps"]
    if isolated:
        out.append(f"- **{len(isolated)} node(s) with ≤1 connection:** " +
                   ", ".join(f"`{x}`" for x in isolated[:5]) +
                   (f" (+{len(isolated) - 5} more)" if len(isolated) > 5 else ""))
    if unassigned:
        lineage_only = sum(1 for n in unassigned if n.get("_origin") == "lineage")
        out.append(
            f"- **{len(unassigned)} node(s) outside every community** "
            f"({lineage_only} of them injected lineage). Clustering runs during the `/graphify` "
            "rebuild, before lineage injection, so a column or query node minted here is only "
            "placed in a community once the next full rebuild sees it.")
    if not isolated and not unassigned:
        out.append("- None.")
    out.append("")

    (GRAPH.parent / "GRAPH_REPORT.md").write_text("\n".join(out), encoding="utf-8")


# graphify's community palette, cycled by community id.
PALETTE = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
           "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"]


def rebuild_viewer_data(g: dict) -> dict:
    """Re-derive the viewer's data arrays from the graph, in graphify's shapes.

    Node radius scales with degree against the busiest node, and only each
    community's most connected node carries a visible label — the same rules
    the exporter used, so a regenerated viewer looks like the one it replaces.
    """
    nodes, links = g["nodes"], g["links"]
    degree = {n["id"]: 0 for n in nodes}
    for e in links:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1
    top = max(degree.values(), default=0) or 1

    hubs = {}
    for n in nodes:
        cid = n.get("community")
        if cid is None:
            continue
        if cid not in hubs or degree[n["id"]] > degree[hubs[cid]]:
            hubs[cid] = n["id"]
    hub_ids = set(hubs.values())

    def colour(n):
        cid = n.get("community")
        return PALETTE[cid % len(PALETTE)] if cid is not None else "#BAB0AC"

    raw_nodes = []
    for n in nodes:
        c = colour(n)
        raw_nodes.append({
            "id": n["id"], "label": n.get("label", n["id"]),
            "color": {"background": c, "border": c,
                      "highlight": {"background": "#ffffff", "border": c}},
            "size": round(10 + 30 * degree[n["id"]] / top, 1),
            "font": {"size": 12 if n["id"] in hub_ids else 0, "color": "#ffffff"},
            "title": n.get("label", n["id"]),
            "community": n.get("community"), "community_name": n.get("community_name"),
            "source_file": n.get("source_file"), "file_type": n.get("file_type"),
            "degree": degree[n["id"]],
        })

    raw_edges = []
    for e in links:
        inferred = e.get("confidence") != "EXTRACTED"
        raw_edges.append({
            "from": e["source"], "to": e["target"], "label": e.get("relation", ""),
            "title": f"{e.get('relation', '')} [{e.get('confidence', '?')}]",
            "dashes": inferred, "width": 1 if inferred else 2,
            "color": {"opacity": 0.7}, "confidence": e.get("confidence"),
        })

    counts, names = {}, {}
    for n in nodes:
        cid = n.get("community")
        if cid is None:
            continue
        counts[cid] = counts.get(cid, 0) + 1
        names.setdefault(cid, n.get("community_name") or f"Community {cid}")
    legend = [{"cid": cid, "color": PALETTE[cid % len(PALETTE)],
               "label": names[cid], "count": counts[cid]}
              for cid in sorted(counts)]

    return {"RAW_NODES": raw_nodes, "RAW_EDGES": raw_edges,
            "LEGEND": legend, "hyperedges": g.get("hyperedges", [])}


def harden_viewer(g: dict) -> None:
    """Patch the defects in graphify's exported viewer.

    graph.html comes from the installed graphify package, so these cannot be
    fixed at the source from this repository — but the file is committed here,
    so it is this repository's problem. Every patch is checked: a viewer that
    is already hardened counts as patched, but one where neither the original
    nor the patched form is recognisable means a graphify upgrade has changed
    the template, and that fails loudly rather than shipping unpatched.
    """
    html_path = GRAPH.parent / "graph.html"
    if not html_path.exists():
        return
    html = html_path.read_text(encoding="utf-8")
    patches = 0

    def patch(text, before, after):
        """Apply a replacement, tolerating a file that already carries it."""
        nonlocal patches
        if before and before in text:
            patches += 1
            return text.replace(before, after)
        if after in text:
            patches += 1
        return text

    # 1. `esc()` runs only after the browser has already parsed the <script>.
    #    A label containing `</script>` closes it early and injects markup, and
    #    graph values can come from scraped documents. Escape at serialization.
    def safe_json(value):
        return (json.dumps(value, ensure_ascii=False)
                .replace("<", "\\u003c").replace(">", "\\u003e")
                .replace("&", "\\u0026").replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029"))

    # The viewer's arrays were exported before injection, so they describe a
    # graph that no longer exists. Rebuild them from the artifact the report
    # also reads, then serialize with the escaping above.
    for name, value in rebuild_viewer_data(g).items():
        pattern = re.compile(rf"^const {name} = (.*);$", re.M)
        if not pattern.search(html):
            continue
        html = pattern.sub(lambda _: f"const {name} = {safe_json(value)};", html, count=1)
        patches += 1

    # 2. The graph is undirected (`directed: false`), and the stored endpoint
    #    order is not meaningful — an arrow on every edge asserts a direction
    #    the data does not carry.
    arrows = "  arrows: { to: { enabled: true, scaleFactor: 0.5 } },\n"
    if arrows in html:
        html = html.replace(arrows, "")
        patches += 1
    elif "arrows:" not in html:
        patches += 1

    # 3. Search results were non-focusable <div>s with only a click handler,
    #    so the result list could not be reached or activated from a keyboard.
    old_result = "    const el = document.createElement('div');\n    el.className = 'search-item';"
    new_result = ("    const el = document.createElement('button');\n"
                  "    el.type = 'button';\n"
                  "    el.className = 'search-item';\n"
                  "    el.style.display = 'block';\n"
                  "    el.style.width = '100%';\n"
                  "    el.style.textAlign = 'left';\n"
                  "    el.style.background = 'none';\n"
                  "    el.style.border = 'none';\n"
                  "    el.style.font = 'inherit';\n"
                  "    el.style.color = 'inherit';\n"
                  "    el.style.cursor = 'pointer';")
    html = patch(html, old_result, new_result)

    # 4. `hidden` is set through nodesDS.update, never on RAW_NODES — so search
    #    could focus a node the user had filtered away, and a hyperedge region
    #    was drawn around members that were no longer on screen.
    old_filter = "const matches = RAW_NODES.filter(n => n.label.toLowerCase().includes(q)).slice(0, 20);"
    new_filter = ("const matches = RAW_NODES.filter(n => n.label.toLowerCase().includes(q)\n"
                  "    && !(nodesDS.get(n.id) || {}).hidden).slice(0, 20);")
    html = patch(html, old_filter, new_filter)

    old_positions = ("        const positions = h.nodes\n"
                     "            .map(nid => network.getPositions([nid])[nid])\n"
                     "            .filter(p => p !== undefined);")
    new_positions = ("        const positions = h.nodes\n"
                     "            .filter(nid => !(nodesDS.get(nid) || {}).hidden)\n"
                     "            .map(nid => network.getPositions([nid])[nid])\n"
                     "            .filter(p => p !== undefined);")
    html = patch(html, old_positions, new_positions)

    # The stats banner is baked in at export time, before injection.
    communities = len({n.get("community") for n in g["nodes"] if n.get("community") is not None})
    html = re.sub(
        r'<div id="stats">[^<]*</div>',
        f'<div id="stats">{len(g["nodes"])} nodes &middot; {len(g["links"])} edges '
        f'&middot; {communities} communities</div>',
        html, count=1)

    if patches < 8:
        raise SystemExit(
            f"harden_viewer: only {patches}/8 patches applied — graphify's viewer template "
            "has changed. Review graphify-out/graph.html before shipping it.")
    html_path.write_text(html, encoding="utf-8")


def main() -> None:
    g = json.loads(GRAPH.read_text(encoding="utf-8"))

    # Drop the previous generation of injected records so this run reconciles
    # rather than accumulates. Anything graphify itself extracted stays put.
    g["nodes"] = [n for n in g["nodes"] if n.get("_origin") != "lineage"]
    surviving = {n["id"] for n in g["nodes"]}
    g["links"] = [
        e for e in g["links"]
        if e.get("_origin") != "lineage"
        and e["source"] in surviving and e["target"] in surviving
    ]

    # graphify emits the same hyperedge list twice — once nested under `graph`
    # and once at the top level — and the viewer draws both, so every region is
    # painted twice. Collapse to one canonical list with unique ids.
    canonical, seen_hyper = [], set()
    for h in (g.get("hyperedges") or []) + (g.get("graph", {}).get("hyperedges") or []):
        signature = (h.get("id"), tuple(sorted(h.get("nodes") or [])))
        if signature in seen_hyper:
            continue
        seen_hyper.add(signature)
        if any(h.get("id") == kept.get("id") for kept in canonical):
            # Same id, different membership: keep both, but make the id unique.
            h = dict(h, id=f"{h['id']}__{len(canonical)}")
        canonical.append(h)
    g["hyperedges"] = canonical
    g.setdefault("graph", {}).pop("hyperedges", None)

    nodes = {n["id"]: n for n in g["nodes"]}
    edge_keys = {edge_key(e["source"], e["target"], e.get("relation")) for e in g["links"]}
    by_file = {}
    for n in g["nodes"]:
        sf = n.get("source_file") or ""
        # Prefer the file-level node (AST emits one node per file plus symbols).
        # Column nodes carry a source_file too, so without this guard one of them
        # can become its file's representative and every column then gets minted
        # a second time beneath it as `col__col__…`.
        if n.get("type") == "column":
            continue
        if sf and (sf not in by_file or n["id"].count("_") <= by_file[sf].count("_")):
            by_file[sf] = n["id"]

    added_nodes, added_edges = [], []
    # has_column edges keyed by owner, so the page pass below can find a query's
    # columns without reading them back out of the undirected edge set.
    columns_of = {}

    def add_node(nid, label, ntype, source_file, location=None, description=None,
                 owner=None):
        if nid in nodes:
            return
        node = {
            "id": nid, "label": label, "type": ntype, "file_type": "code",
            "source_file": source_file, "source_location": location or "",
            "confidence": "EXTRACTED", "_origin": "lineage", "norm_label": label,
        }
        # Clustering runs before this script does, so an injected node would
        # otherwise sit outside every community and the report's community
        # sizes would not add up to the node count. A column belongs with the
        # file that projects it, so inherit that file's community.
        parent = nodes.get(owner) if owner else None
        if parent and parent.get("community") is not None:
            node["community"] = parent["community"]
            node["community_name"] = parent.get("community_name")
        if description:
            node["description"] = description
        nodes[nid] = node
        added_nodes.append(node)

    def add_edge(src, tgt, relation, source_file, location=None, context=None):
        key = edge_key(src, tgt, relation)
        if key in edge_keys or src not in nodes or tgt not in nodes or src == tgt:
            return
        edge = {
            "source": src, "target": tgt, "relation": relation,
            "confidence": "EXTRACTED", "confidence_score": 1.0, "weight": 1.0,
            "source_file": source_file, "source_location": location or "",
            "_origin": "lineage",
        }
        if context:
            edge["context"] = context[:300]
        edge_keys.add(key)
        added_edges.append(edge)

    # ---- dbt mart nodes (external upstream) + their columns --------------
    for mart, model_path in MART_MODELS.items():
        add_node(f"dbt_marts_{mart}", f"marts.{mart}", "table",
                 f"{DBT_PROJECT}/{model_path}",
                 description="dbt mart (external upstream, synced by scripts/sync-dbt.sh)")

    # ---- SQL files: tables, output columns, column lineage ---------------
    sql_files = sorted((ROOT / "queries").rglob("*.sql")) + \
                sorted((ROOT / "sources" / "dbt_semantic").glob("*.sql"))
    for f in sql_files:
        rel = str(f.relative_to(ROOT))
        fid = by_file.get(rel)
        if not fid:
            # graphify's AST pass cannot parse .sql without tree_sitter_sql, so a
            # newly added query file has no node to hang lineage off. Mint one —
            # this injector is the reason SQL is in the graph at all, and it must
            # not silently skip a file just because the AST pass produced nothing.
            fid = "sqlfile__" + rel.replace("/", "_")[:-4]
            add_node(fid, f.stem, "query", rel,
                     description=f"SQL query file ({rel})")
            by_file[rel] = fid
        sql = f.read_text(encoding="utf-8")
        try:
            parsed = sqlglot.parse_one(sql, dialect="duckdb")
        except Exception as err:  # unparseable file: report, keep going
            print(f"  WARN could not parse {rel}: {err}", file=sys.stderr)
            continue

        # table references (schema-qualified only — CTEs are internal)
        for t in parsed.find_all(exp.Table):
            db = t.text("db")
            if db == "dbt_semantic":
                tgt = by_file.get(f"sources/dbt_semantic/{t.name}.sql")
                if tgt:
                    add_edge(fid, tgt, "reads_table", rel, context=f"from dbt_semantic.{t.name}")
            elif db == "marts":
                mart_id = f"dbt_marts_{t.name}"
                if mart_id in nodes:
                    add_edge(fid, mart_id, "derived_from", rel, context=f"from marts.{t.name}")

        # output columns of the outermost SELECT
        outer = parsed
        if not isinstance(outer, exp.Select):
            continue
        for proj in outer.selects:
            name = proj.alias_or_name
            if not name or name == "*":
                continue
            cid = col_id(fid, name)
            expr_sql = proj.sql(dialect="duckdb")
            add_node(cid, f"{f.stem}.{name}", "column", rel,
                     description=expr_sql[:200], owner=fid)
            add_edge(fid, cid, "has_column", rel, context=expr_sql)
            columns_of.setdefault(fid, []).append((name, cid))

            # column-level lineage back to real tables (through CTEs)
            try:
                ln = lineage(name, sql, dialect="duckdb")
            except Exception:
                continue
            leaves, stack, seen = [], [ln], set()
            while stack:
                node = stack.pop()
                if id(node) in seen:
                    continue
                seen.add(id(node))
                if node.downstream:
                    stack.extend(node.downstream)
                elif isinstance(node.expression, exp.Table):
                    leaves.append(node)
            for leaf in leaves:
                tbl = leaf.expression
                src_col = leaf.name.split(".")[-1]
                db = tbl.text("db")
                owner = None
                if db == "dbt_semantic":
                    owner = by_file.get(f"sources/dbt_semantic/{tbl.name}.sql")
                elif db == "marts":
                    owner = f"dbt_marts_{tbl.name}"
                # A mart outside MART_MODELS has no node, and nodes[owner] below
                # would raise — one unlisted mart must not abort the whole run.
                if not owner or owner == fid or owner not in nodes:
                    continue
                up_id = col_id(owner, src_col)
                add_node(up_id, f"{tbl.name}.{src_col}", "column",
                         nodes[owner].get("source_file", rel), owner=owner)
                add_edge(owner, up_id, "has_column", nodes[owner].get("source_file", rel))
                add_edge(cid, up_id, "derives_from", rel, context=expr_sql)

    # ---- pages: frontmatter loads, ${} chains, column usage --------------
    qid_to_file = {p.with_suffix("").as_posix().replace("queries/", "").replace("/", "_"):
                   str(p) for p in [q.relative_to(ROOT) for q in sql_files
                                    if "queries/" in str(q)]}
    for page in sorted((ROOT / "pages").rglob("*.md")):
        rel = str(page.relative_to(ROOT))
        pid = by_file.get(rel)
        if not pid:
            continue
        text = page.read_text(encoding="utf-8")
        lines = text.splitlines()

        # query id -> the query node it loads, for the column pass below
        loaded = {}

        # frontmatter `queries:` entries
        if lines and lines[0].strip() == "---":
            for i, line in enumerate(lines[1:60], start=2):
                if line.strip() == "---":
                    break
                m = re.match(r"\s*-\s*([\w/\-\[\]]+\.sql)\s*$", line)
                if m:
                    qpath = f"queries/{m.group(1)}"
                    tgt = by_file.get(qpath)
                    if tgt:
                        add_edge(pid, tgt, "loads_query", rel, f"L{i}",
                                 context=f"frontmatter: queries: - {m.group(1)}")
                        loaded[Path(qpath).stem] = tgt

        # ${query_id} chains inside page SQL (sorted: set order is not stable
        # across processes, and the emitted edge order must be reproducible)
        for qid in sorted(set(re.findall(r"\$\{(\w+)\}", text))):
            qfile = qid_to_file.get(qid)
            if qfile:
                tgt = by_file.get(qfile)
                if tgt:
                    add_edge(pid, tgt, "references_query", rel,
                             context=f"${{{qid}}} query chain")
                    loaded[qid] = tgt

        # Metric columns the page actually reads. Scanning the whole page for a
        # bare column name would match prose, headings and unrelated queries —
        # `revenue` and `region` appear all over an English sentence — so each
        # query is matched only against the text that names that query: its SQL
        # blocks, and the component tags bound to it.
        scopes = {}
        for block in re.findall(r"```sql[^\n]*\n(.*?)```", text, re.S):
            for qid in sorted(set(re.findall(r"\$\{(\w+)\}", block))):
                scopes.setdefault(qid, []).append(block)
        for tag in re.findall(r"<[A-Z]\w*\b[^>]*?/?>", text, re.S):
            m = re.search(r"\bdata=\{(\w+)\}", tag)
            if m:
                scopes.setdefault(m.group(1), []).append(tag)

        for qid, qnode in loaded.items():
            scope = "\n".join(scopes.get(qid, []))
            if not scope:
                continue
            for colname, cnode in columns_of.get(qnode, []):
                if re.search(rf"\b{re.escape(colname)}\b", scope):
                    add_edge(pid, cnode, "uses_column", rel,
                             context=f"'{colname}' referenced in {rel} via ${{{qid}}}")

    # ---- sync script writes the source database --------------------------
    sync_id = by_file.get("scripts/sync-dbt.sh")
    conn_id = by_file.get("sources/dbt_semantic/connection.yaml")
    if sync_id and conn_id:
        add_edge(sync_id, conn_id, "writes", "scripts/sync-dbt.sh",
                 context="copies dev.duckdb -> sources/dbt_semantic/dbt_semantic.duckdb")
    for mart in MART_MODELS:
        if sync_id:
            add_edge(sync_id, f"dbt_marts_{mart}", "derived_from",
                     "scripts/sync-dbt.sh", context="dbt build produces the mart it copies")

    g["nodes"] = list(nodes.values())
    g["links"] = g["links"] + added_edges
    GRAPH.write_text(json.dumps(g, indent=2, ensure_ascii=False), encoding="utf-8")

    write_report(g)
    harden_viewer(g)
    print(f"lineage: +{len(added_nodes)} nodes, +{len(added_edges)} edges "
          f"-> {len(g['nodes'])} nodes, {len(g['links'])} edges total")


if __name__ == "__main__":
    main()
