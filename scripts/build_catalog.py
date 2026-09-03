#!/usr/bin/env python3
"""Rebuild pact-catalog.json (app asset + website src) from the PACT
"Product Master Report Updated.xlsx" export.

Keyed by Product Code (col B) so distinct products are never dropped by a shared
name (the old build deduped on name and lost ~186 products, incl. FG0005).

Usage: python3 scripts/build_catalog.py "<path to Product Master Report Updated.xlsx>"
"""
import sys, json, openpyxl

XLSX = sys.argv[1] if len(sys.argv) > 1 else "Product Master Report Updated.xlsx"
# column indexes (0-based) from the report header row (row 2)
B_CODE, C_LABEL, D_NAME, E_GROUP = 1, 2, 3, 4
L1U, L1R, L2U, L2R, L3U, L3R = 6, 7, 8, 9, 10, 11
M_WH, V_SCAN = 12, 21

def s(v):
    return "" if v is None else str(v).strip()
def num(v):
    try: return float(v)
    except Exception: return 0.0

wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
ws = wb.active
byCode = {}   # code -> product (last non-blank-warehouse wins on dup)
order = []
for row in ws.iter_rows(min_row=3, values_only=True):
    code = s(row[B_CODE])
    if not code:
        continue
    name = s(row[D_NAME])
    levels = {}
    units = []
    if s(row[L1U]): levels["L1"] = {"u": s(row[L1U]), "s": num(row[L1R]) or 1}; units.append(s(row[L1U]))
    if s(row[L2U]): levels["L2"] = {"u": s(row[L2U]), "s": num(row[L2R])}; units.append(s(row[L2U]))
    if s(row[L3U]): levels["L3"] = {"u": s(row[L3U]), "s": num(row[L3R])}; units.append(s(row[L3U]))
    printLevel = "L3" if "L3" in levels else ("L2" if "L2" in levels else ("L1" if "L1" in levels else None))
    wh = s(row[M_WH]);  wh = "" if wh in ("", "-") else wh
    scan = s(row[V_SCAN]).lower() == "true"
    prod = {"code": code, "name": name, "printLevel": printLevel,
            "levels": levels, "idealWarehouse": wh, "scanBatches": scan, "_units": units}
    if code in byCode:
        # on duplicate code, prefer the row that carries a warehouse
        if byCode[code]["idealWarehouse"] and not wh:
            continue
    else:
        order.append(code)
    byCode[code] = prod

prods = [byCode[c] for c in order]

# App asset schema: {ok,count,products:[{code,name,printLevel,levels,idealWarehouse,scanBatches}]}
app = {"ok": True, "count": len(prods),
       "products": [{k: p[k] for k in ("code","name","printLevel","levels","idealWarehouse","scanBatches")} for p in prods]}
# Website src schema: bare list of {name,units,levels,printLevel,code,idealWarehouse,scanBatches}
src = [{"name": p["name"], "units": p["_units"], "levels": p["levels"], "printLevel": p["printLevel"],
        "code": p["code"], "idealWarehouse": p["idealWarehouse"], "scanBatches": p["scanBatches"]} for p in prods]

open("/tmp/cat_app.json","w").write(json.dumps(app, ensure_ascii=False))
open("/tmp/cat_src.json","w").write(json.dumps(src, ensure_ascii=False))
print("built", len(prods), "products -> /tmp/cat_app.json, /tmp/cat_src.json")
