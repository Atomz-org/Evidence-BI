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

Idempotent: nodes dedupe by id, edges by (source, target, relation). Never
deletes. Re-run after any /graphify rebuild or after editing pages/queries:

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


def main() -> None:
    g = json.loads(GRAPH.read_text(encoding="utf-8"))
    nodes = {n["id"]: n for n in g["nodes"]}
    edge_keys = {(e["source"], e["target"], e.get("relation")) for e in g["links"]}
    by_file = {}
    for n in g["nodes"]:
        sf = n.get("source_file") or ""
        # prefer the file-level node (AST emits one node per file plus symbols)
        if sf and (sf not in by_file or n["id"].count("_") <= by_file[sf].count("_")):
            by_file[sf] = n["id"]

    added_nodes, added_edges = [], []

    def add_node(nid, label, ntype, source_file, location=None, description=None):
        if nid in nodes:
            return
        node = {
            "id": nid, "label": label, "type": ntype, "file_type": "code",
            "source_file": source_file, "source_location": location or "",
            "confidence": "EXTRACTED", "_origin": "lineage", "norm_label": label,
        }
        if description:
            node["description"] = description
        nodes[nid] = node
        added_nodes.append(node)

    def add_edge(src, tgt, relation, source_file, location=None, context=None):
        key = (src, tgt, relation)
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
            continue
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
            add_node(cid, f"{f.stem}.{name}", "column", rel, description=expr_sql[:200])
            add_edge(fid, cid, "has_column", rel, context=expr_sql)

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
                if not owner or owner == fid:
                    continue
                up_id = col_id(owner, src_col)
                add_node(up_id, f"{tbl.name}.{src_col}", "column",
                         nodes[owner].get("source_file", rel))
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

        # frontmatter `queries:` entries
        if lines and lines[0].strip() == "---":
            for i, line in enumerate(lines[1:60], start=2):
                if line.strip() == "---":
                    break
                m = re.match(r"\s*-\s*([\w/\-\[\]]+\.sql)\s*$", line)
                if m:
                    tgt = by_file.get(f"queries/{m.group(1)}")
                    if tgt:
                        add_edge(pid, tgt, "loads_query", rel, f"L{i}",
                                 context=f"frontmatter: queries: - {m.group(1)}")

        # ${query_id} chains inside page SQL
        for qid in set(re.findall(r"\$\{(\w+)\}", text)):
            qfile = qid_to_file.get(qid)
            if qfile:
                tgt = by_file.get(qfile)
                if tgt:
                    add_edge(pid, tgt, "references_query", rel,
                             context=f"${{{qid}}} query chain")

        # metric columns referenced anywhere in the page body
        loaded = [t for (s, t, r) in edge_keys
                  if s == pid and r in ("loads_query", "references_query")]
        for qnode in loaded:
            for (s, t, r) in list(edge_keys):
                if s == qnode and r == "has_column":
                    colname = t.rsplit("__", 1)[-1]
                    if re.search(rf"\b{re.escape(colname)}\b", text):
                        add_edge(pid, t, "uses_column", rel,
                                 context=f"'{colname}' referenced in {rel}")

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
    print(f"lineage: +{len(added_nodes)} nodes, +{len(added_edges)} edges "
          f"-> {len(g['nodes'])} nodes, {len(g['links'])} edges total")


if __name__ == "__main__":
    main()
