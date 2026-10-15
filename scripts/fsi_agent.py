# B2B Factory Sales Invoice agent -- drives the native WPF PACT RevenU desktop
# app, "Factory Sales Invoice" screen. This is the B2B twin of the NB
# pact_agent.py (Stock Outward to Outlet). Same proven mechanics: attach to
# PACT.VIEW.exe, target controls by LABEL (stable) not numeric AutomationIds,
# fill the header, type barcodes into the Scan box, click Post, read the voucher.
#
# Commands:
#   py fsi_agent.py map
#       -> dumps every label + the control next to it to fsi_map.txt, so we can
#          confirm the EXACT field names on the Factory Sales Invoice screen.
#          RUN THIS FIRST, on a blank new Factory Sales Invoice, and send me
#          fsi_map.txt. That locks in the header-field labels below.
#
#   py fsi_agent.py dispatch --txt order.txt [--post] [--shot]
#       -> fills Customer + SO ref + Narration, scans barcodes. Posts ONLY with
#          --post. Without --post it stops before Post so you can watch + verify.
#
#   py fsi_agent.py post [--wait 60]
#       -> clicks Post on the already-filled invoice, handles confirm dialogs,
#          reads back the voucher. Writes pact_result.json {status,voucher,note}.
#
# order.txt format (the watcher writes this):
#   Order: FSOD-26-27/1017
#   Customer: <customer name exactly as it appears in PACT>
#   CODE_BATCH_WEIGHT        <- one barcode per line
#   CODE_BATCH_WEIGHT
#   ...
#
# SAFETY: 'dispatch' never posts unless --post is given. Mirror of NB behaviour.

import sys, re, io, time, datetime, argparse, traceback
from pywinauto import Desktop, Application

TITLE_RE = re.compile(r"PACT\s*RevenU.*Allsure", re.I)

# -------------------------------------------------------------------------
# FACTORY SALES INVOICE header-field labels.
# These are CANDIDATES -- the agent tries each until one resolves on screen.
# After you run `map`, I'll pin these to the exact labels from fsi_map.txt.
CUSTOMER_LABELS = ["Customer Name *", "Customer Name", "Customer *", "Customer",
                   "Party Name *", "Party Name", "Party *", "Party",
                   "Buyer *", "Buyer"]
SO_LABELS       = ["SO No", "SO No *", "Sales Order No", "Sales Order No *",
                   "Sales Order", "Sales Order *", "Order No", "Order No *",
                   "SO Ref", "Ref No", "Reference No", "Outlet ReqNo"]
SCAN_LABELS     = ["Scan", "Scan Barcode", "Barcode"]
NARRATION_LABEL = "Narration"
# Tokens that are NOT the posted voucher (SO refs / NB prefixes) -- never read
# these back as the Doc No.
EXCLUDE_DOC_TOKENS = ("OMR", "FSOD")
# -------------------------------------------------------------------------

def log(lines, *a):
    s = " ".join(str(x) for x in a); lines.append(s); print(s, flush=True)

def _area(w):
    try:
        r=w.rectangle(); return max(0,r.right-r.left)*max(0,r.bottom-r.top)
    except Exception: return -1

def pact_window(wait=12):
    deadline=time.time()+wait
    while True:
        for kw in (dict(path="PACT.VIEW.exe"), dict(title_re="PACT RevenU.*")):
            try:
                app=Application(backend="uia").connect(timeout=2, **kw)
                best=None; bestA=-1
                for w in app.windows():
                    try: cls=w.class_name()
                    except Exception: cls=""
                    score=_area(w)+(10**9 if cls.startswith("HwndWrapper") else 0)
                    if score>bestA: bestA=score; best=w
                if best is not None:
                    try:
                        if best.is_minimized(): best.restore()
                    except Exception: pass
                    return best
            except Exception: pass
        try:
            for w in Desktop(backend="uia").windows():
                try:
                    if TITLE_RE.search(w.window_text() or ""): return w
                except Exception: pass
        except Exception: pass
        if time.time()>deadline: return None
        time.sleep(1.0)

def ctype(d):
    try: return d.element_info.control_type or ""
    except Exception: return ""
def text(d):
    try: return d.window_text() or ""
    except Exception: return ""
def rect(d):
    try:
        r=d.rectangle(); return f"({r.left},{r.top},{r.right},{r.bottom})"
    except Exception: return "(?)"

def combo_after_label(desc, label, within=8):
    lab=label.lower()
    for i,d in enumerate(desc):
        if ctype(d)=="Text" and text(d).strip().lower().startswith(lab):
            for d2 in desc[i+1:i+1+within]:
                if ctype(d2)=="ComboBox": return d2,i
    return None,None

def visible_combo_after_label(desc, labels, within=8):
    """Find a VISIBLE ComboBox after any of the given label prefixes, trying the
    labels in order. Skips hidden combos (e.g. fields on an inactive tab), which
    is what made the Customer field match a hidden GST-tab combo before."""
    for label in labels:
        lab=label.lower()
        for i,d in enumerate(desc):
            if ctype(d)=="Text" and text(d).strip().lower().startswith(lab):
                for d2 in desc[i+1:i+1+within]:
                    if ctype(d2)=="ComboBox" and _is_visible(d2):
                        return d2, label
    return None, None

def edit_after_label(desc, label, within=6, exact=True):
    lab=label.lower()
    for i,d in enumerate(desc):
        t=text(d).strip().lower()
        hit=(t==lab) if exact else t.startswith(lab)
        if ctype(d)=="Text" and hit:
            for d2 in desc[i+1:i+1+within]:
                if ctype(d2) in ("Edit","ComboBox"): return d2,i
    return None,None

def find_post_button(desc):
    for i,d in enumerate(desc):
        if ctype(d)=="Text" and text(d).strip()=="Post":
            node=d
            for _ in range(5):
                try: p=node.parent()
                except Exception: p=None
                if p is None: break
                if ctype(p)=="Button": return p,"parent#%d"%i
                node=p
            for j in range(i-1,max(-1,i-4),-1):
                if ctype(desc[j])=="Button": return desc[j],"prec#%d"%j
    return None,None

def _is_visible(c):
    try: return bool(c.is_visible())
    except Exception: return False

def edit_child(combo):
    # Prefer a VISIBLE Edit child. A WPF ComboBox can expose a hidden template
    # Edit before the real one; typing into the hidden one raises ElementNotVisible.
    try:
        edits=[c for c in combo.descendants() if ctype(c)=="Edit"]
    except Exception:
        edits=[]
    for c in edits:
        if _is_visible(c): return c
    return edits[0] if edits else None

def read_edit(combo):
    e=edit_child(combo)
    return text(e) if e else text(combo)

def esc(s):
    out=[]
    for ch in s:
        if ch in "^+%~(){}[]": out.append("{"+ch+"}")
        else: out.append(ch)
    return "".join(out)

def type_text(ctrl, value):
    ctrl.type_keys(esc(value), with_spaces=True, pause=0.01, set_foreground=True)

def _item_text(it):
    """Real display text of a WPF list row."""
    parts=[]
    try:
        for tx in it.descendants(control_type="Text"):
            sval=(text(tx) or "").strip()
            if sval: parts.append(sval)
    except Exception: pass
    if not parts:
        own=(text(it) or "").strip()
        if own and not re.match(r'^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$', own):
            parts.append(own)
    return " ".join(parts)

def _visible_items(win):
    out=[]
    for ctp in ("DataItem","ListItem"):
        try: items=win.descendants(control_type=ctp)
        except Exception: items=[]
        for it in items:
            t=_item_text(it)
            if t: out.append((it,t))
    return out

def _fill_combo_filtered(win, combo, filter_text, pick_token, lines, tag):
    try: win.set_focus()
    except Exception: pass
    # Click the COMBO itself (not a possibly-hidden edit) to focus/open it.
    try: combo.click_input()
    except Exception:
        try: combo.set_focus()
        except Exception: pass
    time.sleep(0.4)
    e = edit_child(combo)
    # Try to type a filter, but never let an invisible edit crash the run.
    if filter_text:
        tgt = e if (e is not None and _is_visible(e)) else combo
        try:
            try: tgt.type_keys("^a{DEL}", set_foreground=True)
            except Exception: pass
            tgt.type_keys(esc(filter_text), with_spaces=True, pause=0.01, set_foreground=True)
            time.sleep(1.1)
        except Exception as ex:
            log(lines, f"  [{tag}] could not type filter ({ex.__class__.__name__}); opening list instead")
            try: (e or combo).type_keys("{F4}")
            except Exception: pass
            time.sleep(0.6)
    else:
        try: (e or combo).type_keys("{F4}")
        except Exception: pass
        time.sleep(0.6)
    tl=pick_token.lower().strip()
    def _click_match():
        for it,t in _visible_items(win):
            low=(t or "").lower()
            if low==tl or low.endswith(tl) or (tl and tl in low):
                try: it.click_input(); return t
                except Exception:
                    try: it.select(); return t
                    except Exception: pass
        return ""
    items=_visible_items(win)
    log(lines, f"  [{tag}] {len(items)} visible rows: " + " | ".join(t for _,t in items[:25]))
    picked=_click_match(); ok=bool(picked)
    # keyboard fallback: step down through the (virtualized) list, re-scanning.
    steps=0
    while not ok and steps<40:
        try: (e or combo).type_keys("{DOWN}")
        except Exception: break
        time.sleep(0.12); steps+=1
        picked=_click_match(); ok=bool(picked)
    time.sleep(0.4)
    log(lines, f"  {tag} -> filter {filter_text!r} pick {pick_token!r} clicked={ok} steps={steps} item={picked!r} readback={read_edit(combo)!r}")
    return ok

def set_customer(win, desc, value, lines):
    """Fill the Customer/Party combo. Tries each candidate label until one has a
    combo next to it, then filters the list to the customer name and clicks it."""
    # Prefer a VISIBLE Customer Name combo; fall back to any match if needed.
    combo, used = visible_combo_after_label(desc, CUSTOMER_LABELS)
    if combo is None:
        for label in CUSTOMER_LABELS:
            c,_=combo_after_label(desc, label)
            if c is not None: combo=c; used=label; break
    if combo is None:
        log(lines, "  [MISS] Customer combo (none of CUSTOMER_LABELS matched)")
        return False
    log(lines, f"  Customer field via label {used!r} visible={_is_visible(combo)}")
    # try a few filter widths: full name, first word, short prefix
    first = (value or "").split("(")[0].strip()
    for filt in (value, first, (value or "")[:6]):
        if _fill_combo_filtered(win, combo, filt, value, lines, "Customer"):
            return True
    return False

def set_so_ref(win, desc, value, lines):
    """Fill the SO reference field. PACT often drops a typed value on Enter, so
    we replay the manual copy/paste trick (type -> select-all -> copy -> delete
    -> paste -> Enter), the same one the NB ReqNo field needs."""
    value=(value or "").strip()
    if not value:
        log(lines, "  [SO] no SO number -> left blank"); return False
    combo, used = visible_combo_after_label(desc, SO_LABELS)
    if combo is None:
        for label in SO_LABELS:
            c,_=combo_after_label(desc, label)
            if c is None:
                c,_=edit_after_label(desc, label, within=6, exact=False)
            if c is not None:
                combo=c; used=label; break
    if combo is None:
        log(lines, "  [MISS] SO reference field (none of SO_LABELS matched)")
        return False
    log(lines, f"  SO field via label {used!r} visible={_is_visible(combo)}")
    # SO No is a combo whose list is populated once the Customer is chosen.
    # Pick it the robust way: filter by full SO, then by the numeric tail.
    tail=value.split("/")[-1]
    for filt in (value, tail):
        if _fill_combo_filtered(win, combo, filt, value, lines, "SO No"):
            return True
    log(lines, f"  SO No NOT selected for {value!r}")
    return False

def set_narration(win, desc, value, lines):
    ed,_ = edit_after_label(desc, NARRATION_LABEL, within=6, exact=True)
    if ed is None:
        for i,d in enumerate(desc):
            if ctype(d)=="Text" and text(d).strip().lower()==NARRATION_LABEL.lower():
                for d2 in desc[i+1:i+10]:
                    if ctype(d2)=="Edit": ed=d2; break
                break
    if ed is None: log(lines,"  [MISS] Narration"); return False
    try: ed.click_input()
    except Exception:
        try: ed.set_focus()
        except Exception: pass
    try: ed.type_keys("^a{DEL}", set_foreground=True)
    except Exception: pass
    try:
        type_text(ed, value)
    except Exception as ex:
        log(lines, f"  [Narration] type skipped ({ex.__class__.__name__})"); return False
    log(lines, f"  Narration -> {value!r} readback={text(ed)!r}")
    return True

def _find_scan_edit(desc):
    for label in SCAN_LABELS:
        scan,_=edit_after_label(desc, label, exact=True)
        if scan is not None: return scan, label
        scan,_=edit_after_label(desc, label, exact=False)
        if scan is not None: return scan, label
    return None, None

def type_barcodes(win, desc, barcodes, lines):
    scan,label=_find_scan_edit(desc)
    if scan is None: log(lines,"  [MISS] Scan box (none of SCAN_LABELS matched)"); return 0
    log(lines, f"  Scan box found via label {label!r}")
    n=0
    total=sum(1 for b in barcodes if b and b.strip())
    _err_seen=False
    for bc in barcodes:
        bc=bc.strip()
        if not bc: continue
        try: scan.click_input()
        except Exception:
            try: scan.set_focus()
            except Exception: pass
        try: scan.type_keys("^a{DEL}", set_foreground=True)
        except Exception: pass
        try:
            type_text(scan, bc)
        except Exception as ex:
            log(lines, f"  [Scan] item {n+1} type failed ({ex.__class__.__name__})"); continue
        try: scan.type_keys("{ENTER}", set_foreground=True)
        except Exception: pass
        n+=1
        _progress("typing", n, total)
        try:
            if not _err_seen:
                _ft = _fg_title().lower()
                if (_ft and "revenu" not in _ft and "pact" not in _ft and "factory sales" not in _ft) or (n % 10 == 0):
                    _al = _pact_alert()
                    if _al:
                        _pmsg("error", "item %d (%s): %s" % (n, bc, _al))
                        _err_seen = True
        except Exception: pass
        time.sleep(0.3)
    log(lines,f"  typed {n} barcode(s) into Scan box")
    return n

# ----------------------------- MAP -----------------------------
def cmd_map(args):
    lines=[]; log(lines,"FSI agent MAP -",datetime.datetime.now().isoformat())
    win=pact_window()
    if not win:
        log(lines,"PACT window not found. Open the Factory Sales Invoice screen first.")
        open("fsi_map.txt","w",encoding="utf-8").write("\n".join(lines)); return
    log(lines,"window:",repr(text(win)),win.class_name(),rect(win))
    desc=win.descendants(); log(lines,"descendants:",len(desc)); log(lines,"="*70)
    # 1) Label -> next interesting control (this is what names the fields)
    log(lines,"LABEL -> NEXT CONTROL (combos/edits):")
    for i,d in enumerate(desc):
        if ctype(d)=="Text":
            lab=text(d).strip()
            if not lab or len(lab)>40: continue
            nxt=None
            for d2 in desc[i+1:i+1+8]:
                if ctype(d2) in ("ComboBox","Edit"):
                    nxt=d2; break
            if nxt is not None:
                log(lines, f"  {lab:28} -> {ctype(nxt):9} val={read_edit(nxt)!r} {rect(nxt)}")
    log(lines,"-"*70)
    # 2) All combos & edits with current values (in case a field has no label text)
    log(lines,"ALL ComboBox / Edit controls:")
    for i,d in enumerate(desc):
        ct=ctype(d)
        if ct in ("ComboBox","Edit"):
            log(lines, f"  #{i:4} {ct:9} val={read_edit(d)!r} {rect(d)}")
    log(lines,"-"*70)
    # 3) Candidate resolution for our known logical fields
    log(lines,"CANDIDATE RESOLUTION (which label the agent will use):")
    cust=None
    for label in CUSTOMER_LABELS:
        c,_=combo_after_label(desc,label)
        if c is not None: cust=label; break
    log(lines, f"  Customer   -> {cust!r}")
    so=None
    for label in SO_LABELS:
        c,_=combo_after_label(desc,label)
        if c is None: c,_=edit_after_label(desc,label,exact=False)
        if c is not None: so=label; break
    log(lines, f"  SO ref     -> {so!r}")
    scan,slabel=_find_scan_edit(desc)
    log(lines, f"  Scan box   -> {slabel!r}")
    pb,how=find_post_button(desc)
    log(lines, f"  Post btn   -> {'FOUND' if pb else 'MISS'} via={how} {rect(pb) if pb else ''}")
    open("fsi_map.txt","w",encoding="utf-8").write("\n".join(lines)); print(">>> wrote fsi_map.txt")

# ----------------------------- DISPATCH -----------------------------
def parse_fsi_txt(path):
    order=None; customer=None; barcodes=[]
    with open(path, encoding="utf-8") as f:
        for line in f:
            s=line.strip()
            if not s: continue
            low=s.lower()
            if low.startswith("order:") or low.startswith("so:") or low.startswith("sonumber:") or low.startswith("so number:"):
                order=s.split(":",1)[1].strip()
            elif low.startswith("customer:") or low.startswith("party:") or low.startswith("customer name:"):
                customer=s.split(":",1)[1].strip()
            elif low.startswith("total lines") or low.startswith("format"):
                continue
            elif re.match(r"^[A-Za-z0-9]+_.+_\d+$", s):
                barcodes.append(s)
    return order, customer, barcodes

def cmd_dispatch(args):
    _write_result("failed", "", "did not complete")
    lines=[]; log(lines,"FSI agent DISPATCH -", datetime.datetime.now().isoformat())
    order, customer, barcodes = parse_fsi_txt(args.txt)
    if args.customer: customer=args.customer
    if args.so:       order=args.so
    log(lines, f"order={order!r} customer={customer!r} barcodes={len(barcodes)}")
    _progress("preparing", 0, len(barcodes))
    if not barcodes:
        log(lines,"[ABORT] no barcode lines parsed from TXT")
        open("fsi_dispatch.txt","w",encoding="utf-8").write("\n".join(lines)); return
    win=pact_window()
    if not win:
        log(lines,"PACT window not found. Open the 'Factory Sales Invoice' form first.")
        open("fsi_dispatch.txt","w",encoding="utf-8").write("\n".join(lines)); return
    try: win.set_focus()
    except Exception: pass
    desc=win.descendants(); log(lines,"descendants:",len(desc))
    # header: Customer -> SO ref -> Narration
    if customer: set_customer(win, desc, customer, lines)
    desc=win.descendants()
    if order:    set_so_ref(win, desc, order, lines)
    desc=win.descendants()
    set_narration(win, desc, "Entry made by AI - B2B " + (order or ""), lines)
    # barcodes
    desc=win.descendants()
    n=type_barcodes(win, desc, barcodes, lines)
    log(lines, f"typed {n}/{len(barcodes)} barcodes")
    # re-assert SO ref (PACT can drop it after scanning)
    if order:
        desc=win.descendants()
        rc=None
        for label in SO_LABELS:
            c,_=combo_after_label(desc,label)
            if c is None: c,_=edit_after_label(desc,label,exact=False)
            if c is not None: rc=c; break
        rb=read_edit(rc) if rc is not None else ""
        if order[-4:] not in (rb or ""):
            log(lines,f"  [WARN] SO ref empty after scan (readback={rb!r}) -- re-selecting {order!r}")
            set_so_ref(win, desc, order, lines)
    try: win.capture_as_image().save("after_fsi_dispatch.png"); log(lines,"saved after_fsi_dispatch.png")
    except Exception as e: log(lines,"screenshot failed:",e)
    if args.post:
        _progress("posting", len(barcodes), len(barcodes))
        log(lines,"posting..."); cmd_post(argparse.Namespace(wait=args.wait or 60))
    else:
        log(lines,"DONE (NOT posted -- add --post to post). Review after_fsi_dispatch.png")
    open("fsi_dispatch.txt","w",encoding="utf-8").write("\n".join(lines)); print(">>> wrote fsi_dispatch.txt")

# ----------------------------- POST -----------------------------
def read_state(win):
    badge=""; doc=""; net=""
    try:
        for d in win.descendants(control_type="Text"):
            t=text(d).strip()
            if t in ("[Draft]","[Posted]","Draft","Posted") and not badge: badge=t
            if re.search(r"[A-Za-z]{1,5}/\s*\d{2}-\d{2}/\s*\d{3,7}", t) and not doc: doc=t
    except Exception: pass
    return {"badge":badge,"doc":doc,"net":net}

def read_doc_no(win):
    """Read the posted voucher Doc No = series + number. Excludes SO refs
    (FSOD...) and NB prefixes (OMR...). Never raises."""
    import re as _re
    SER  = _re.compile(r"[A-Za-z]{1,5}\s*/?\s*\d{2}-\d{2}")
    FULL = _re.compile(r"[A-Za-z]{1,5}\s*/\s*\d{2}-\d{2}\s*/\s*\d{2,7}")
    NUM  = _re.compile(r"^\d{2,7}$")
    def clean(x): return _re.sub(r"\s+", "", (x or ""))
    def excluded(v): return any(tok in (v or "").upper() for tok in EXCLUDE_DOC_TOKENS)
    def ok(doc):
        d = clean(doc)
        return bool(d) and not excluded(d) and _re.search(r"\d{2}-\d{2}/\d{2,7}", d)
    try:
        desc = win.descendants()
    except Exception:
        return ""
    vals = []
    for d in desc:
        try:
            ct = ctype(d)
            if ct in ("ComboBox", "Edit"):
                v = (read_edit(d) or text(d) or "").strip()
            elif ct == "Text":
                v = (text(d) or "").strip()
            else:
                v = ""
        except Exception:
            ct = ""; v = ""
        vals.append((ct, v))
    for ct, v in vals:
        m = FULL.search(v or "")
        if m and not excluded(v):
            return clean(m.group(0))
    for k, (ct, v) in enumerate(vals):
        if ct == "Text" and v.lower().startswith("doc no"):
            series = ""; number = ""
            for ct2, v2 in vals[k+1:k+20]:
                if not series and ct2 in ("ComboBox","Edit","Text") and SER.search(v2 or "") and not excluded(v2):
                    series = v2
                elif not number and ct2 in ("Edit","Text","ComboBox") and NUM.match(clean(v2)):
                    number = clean(v2)
                if series and number: break
            if series and number:
                srs = clean(series)
                if not srs.endswith("/"): srs += "/"
                doc = srs + number
                if ok(doc): return doc
    for k, (ct, v) in enumerate(vals):
        if ct in ("ComboBox","Edit","Text") and SER.search(v or "") and not excluded(v):
            srs = clean(v)
            if not srs.endswith("/"): srs += "/"
            if _re.search(r"/\s*\d{2,7}\s*$", v or ""):
                if ok(v): return clean(v)
            for ct2, v2 in vals[k+1:k+8]:
                if ct2 in ("Edit","Text","ComboBox") and NUM.match(clean(v2)):
                    doc = srs + clean(v2)
                    if ok(doc): return doc
    try:
        with io.open("voucher_debug.txt", "w", encoding="utf-8") as _f:
            for ct, v in vals:
                if v and _re.search(r"\d", v):
                    _f.write("%s | %s\n" % (ct, v[:90]))
    except Exception:
        pass
    return ""

def cmd_post(args):
    lines=[]; log(lines,"FSI agent POST -",datetime.datetime.now().isoformat())
    win=pact_window()
    if not win: log(lines,"PACT window not found."); open("fsi_post.txt","w").write("\n".join(lines)); return
    try: win.set_focus()
    except Exception: pass
    desc=win.descendants()
    before=read_state(win); log(lines,"before:",before)
    pb,how=find_post_button(desc)
    if pb is None: log(lines,"[ABORT] Post button not found"); open("fsi_post.txt","w").write("\n".join(lines)); _write_result("failed","","Post button not found"); return
    log(lines,"clicking Post via",how)
    try: pb.click_input()
    except Exception as e: log(lines,"Post click error:",e)
    app=None
    try: app=Application(backend="uia").connect(path="PACT.VIEW.exe", timeout=3)
    except Exception: pass
    deadline=time.time()+ (args.wait or 45)
    success=False; note=""
    while time.time()<deadline:
        time.sleep(1.2)
        _progress("posting", 0, 0)
        try:
            _al = _pact_alert()
            if _al: _pmsg("error", "posting: %s" % _al); globals()["_LAST_POST_ERR"] = _al
        except Exception: pass
        wins=[]
        try: wins=app.windows() if app else []
        except Exception: wins=[]
        for w in wins:
            try:
                for b in w.descendants(control_type="Button"):
                    bt=(text(b) or "").strip().lower()
                    if bt in ("yes","confirm","proceed","continue"):
                        try: b.click_input(); log(lines,"clicked dialog button:",bt); time.sleep(0.6)
                        except Exception: pass
                for tx in w.descendants(control_type="Text"):
                    tt=(text(tx) or "").lower()
                    if ("posted successfully" in tt) or ("saved successfully" in tt):
                        success=True; note=text(tx).strip()[:120]
            except Exception: pass
        st=read_state(win)
        if (st.get("badge","") or "").strip() in ("[Posted]","Posted"): success=True; note="badge="+(st.get("badge","") or "")
        if success: break
    try: win.capture_as_image().save("after_fsi_post.png"); log(lines,"saved after_fsi_post.png")
    except Exception as e: log(lines,"screenshot failed:",e)
    after=read_state(win); log(lines,"after:",after)
    log(lines, "RESULT: "+("POSTED — "+note if success else "NOT CONFIRMED — check after_fsi_post.png"))
    fw = win
    try: fw = pact_window() or win
    except Exception: fw = win
    if not success:
        try:
            _st2 = read_state(fw)
            if (_st2.get("badge","") or "").strip() in ("[Posted]", "Posted"):
                success = True; note = "confirmed on re-check (slow post)"; log(lines, "  re-check: badge now [Posted]")
        except Exception as _e: log(lines, "  re-check error: %s" % _e)
    voucher = ""
    if success:
        try: voucher = read_doc_no(fw)
        except Exception as _e: log(lines, "  read_doc_no error: %s" % _e)
        log(lines, "  voucher read: %r" % voucher)
    open("fsi_post.txt","w",encoding="utf-8").write("\n".join(lines)); print(">>> wrote fsi_post.txt")
    if success:
        _write_result("posted", voucher, note)
    else:
        _write_result("failed", "", (globals().get("_LAST_POST_ERR") or "NOT CONFIRMED - check after_fsi_post.png"))

# ----------------------------- heartbeat / result -----------------------------
def _fg_title():
    try:
        import ctypes
        u = ctypes.windll.user32
        h = u.GetForegroundWindow()
        n = u.GetWindowTextLengthW(h)
        b = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(h, b, n + 1)
        return b.value or ""
    except Exception:
        return ""

_ALERT_LAST_DEEP = [0.0]
def _pact_alert():
    import time as _t
    ERR_KW = ("exceed", "becomes negative", "negative for", "not equal", "qty not",
              "insuffic", "already exist", "duplicate", "invalid", "cannot", "must be",
              "greater than", "less than", "not allowed", "mismatch", "out of stock",
              "row no", "no stock", "at row", "not defined", "not maintained", "is required",
              "please", "define", "not found", "does not", "credit limit", "blocked")
    def _scan(ds, cap):
        seen = 0
        for c in ds:
            seen += 1
            if seen > cap: break
            try:
                if ctype(c) in ("Text", "Static", "Edit"):
                    t = (text(c) or "").strip()
                    if t and 4 < len(t) <= 200 and any(k in t.lower() for k in ERR_KW):
                        return t
            except Exception: pass
        return ""
    try:
        from pywinauto import Desktop
        tops = Desktop(backend="uia").windows()
    except Exception:
        return ""
    main = None
    for w in tops:
        try:
            wt = (w.window_text() or "").strip()
            low = wt.lower()
            if not wt: continue
            if ("revenu" in low) or ("factory sales" in low):
                main = w; continue
            ds = w.descendants()
            hit = _scan(ds, 120)
            if hit: return hit[:200]
            if len(ds) <= 60:
                msgs = []; has_btn = False
                for c in ds:
                    try:
                        cc = ctype(c)
                        if cc == "Button": has_btn = True
                        elif cc in ("Text", "Static"):
                            tt = (text(c) or "").strip()
                            if tt and tt.lower() not in ("ok", "yes", "no", "cancel", "close"):
                                msgs.append(tt)
                    except Exception: pass
                body = " ".join(msgs).strip()
                if has_btn and body and len(body) <= 300 and low in ("warning","error","message","confirmation","pact","information"):
                    return body[:200]
        except Exception: pass
    if main is not None and (_t.time() - _ALERT_LAST_DEEP[0] > 4.0):
        _ALERT_LAST_DEEP[0] = _t.time()
        try:
            hit = _scan(main.descendants(), 250)
            if hit: return hit[:200]
        except Exception: pass
    return ""

def _pmsg(phase, msg):
    try:
        import json as _j, datetime as _dt
        with open("pact_progress.json", "w", encoding="utf-8") as _f:
            _j.dump({"phase": phase, "msg": str(msg)[:200], "done": 0, "total": 0,
                     "at": _dt.datetime.now().isoformat()}, _f)
    except Exception: pass

def _progress(phase, done=0, total=0):
    try:
        import json as _j, datetime as _dt
        with open("pact_progress.json", "w", encoding="utf-8") as _f:
            _j.dump({"phase": phase, "done": int(done), "total": int(total),
                     "at": _dt.datetime.now().isoformat()}, _f)
    except Exception: pass

def _write_result(status, voucher="", note=""):
    try:
        import json as _json, datetime as _dt
        with open("pact_result.json", "w", encoding="utf-8") as _f:
            _json.dump({"status": status, "voucher": voucher, "note": note, "at": _dt.datetime.now().isoformat()}, _f)
    except Exception: pass

def main():
    ap=argparse.ArgumentParser()
    sub=ap.add_subparsers(dest="cmd")
    sub.add_parser("map")
    d=sub.add_parser("dispatch")
    d.add_argument("--txt", required=True); d.add_argument("--customer"); d.add_argument("--so")
    d.add_argument("--post", action="store_true"); d.add_argument("--wait", type=int, default=60)
    d.add_argument("--shot", action="store_true")
    p=sub.add_parser("post"); p.add_argument("--wait", type=int, default=45)
    args=ap.parse_args()
    if args.cmd=="map": cmd_map(args)
    elif args.cmd=="dispatch": cmd_dispatch(args)
    elif args.cmd=="post": cmd_post(args)
    else: ap.print_help()

if __name__=="__main__":
    try: main()
    except Exception: traceback.print_exc()
