# -*- coding: utf-8 -*-
"""
PACT-desktop dispatch watcher  (runs on the Windows PACT box, interactive session)

Drains public.dispatch_jobs (filled by the Sukhna app via /api/dispatch-inbox):
  queued -> claim (processing) -> pact_agent dispatch --post --new -> posted|failed
and writes the voucher back so /api/dispatch-status can show the app popup.

SAFETY (important):
  * Posts ONLY when the arm file exists:  C:\\pact\\ARM_DISPATCH
    Without it the agent FILLS the Stock Outward form but does NOT post (status
    stays 'queued' so it can be posted later, once armed). This lets us run the
    watcher now, safely, and enable real posting only after a supervised test.
  * Duplicate guard: an order that already has a 'posted' row is never posted
    again (protects against a double Submit / SOT-2911-style re-post).
  * One order at a time.

Env (put in C:\\pact\\dispatch.env  as KEY=VALUE lines, or the process env):
  SUPABASE_URL, SUPABASE_SERVICE_KEY
Optional: PACT_DIR (default C:\\pact), POLL_SECONDS (default 6)

Run:  py C:\\pact\\dispatch_watcher.py         (loop)
      py C:\\pact\\dispatch_watcher.py --once   (one job, for testing)
"""

import os, sys, re, json, time, argparse, subprocess, datetime, traceback
import urllib.request, urllib.parse, urllib.error

PACT_DIR   = os.environ.get("PACT_DIR", r"C:\pact")
AGENT      = os.path.join(PACT_DIR, "pact_agent.py")
INBOX_DIR  = os.path.join(PACT_DIR, "dispatch_inbox")
LOG_DIR    = os.path.join(PACT_DIR, "logs")
ARM_FILE   = os.path.join(PACT_DIR, "ARM_DISPATCH")
RESULT_JSON= os.path.join(PACT_DIR, "pact_result.json")
ENV_FILE   = os.path.join(PACT_DIR, "dispatch.env")
POLL       = int(os.environ.get("POLL_SECONDS", "6"))
PYEXE      = sys.executable or "py"
PER_LINE   = 3.5
BASE_SEC   = 200

def load_env():
    try:
        if os.path.exists(ENV_FILE):
            for line in open(ENV_FILE, encoding="utf-8"):
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line: continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    except Exception:
        pass

load_env()
SB_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or ""

def now(): return datetime.datetime.now().isoformat(timespec="seconds")

def log(*a):
    line = now() + "  " + " ".join(str(x) for x in a)
    print(line, flush=True)
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, "dispatch_watcher.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def armed(): return os.path.exists(ARM_FILE)

# --------------------------------------------------------------- Supabase REST
def sb(method, path, body=None, headers=None):
    url = SB_URL + "/rest/v1/" + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY, "Content-Type": "application/json"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else []

def claim_next():
    # oldest queued job
    rows = sb("GET", "dispatch_jobs?status=eq.queued&select=id,order_no,outlet,issue_type,barcodes,txt&order=created_at.asc&limit=1")
    if not rows: return None
    job = rows[0]
    # atomic claim: only if still queued
    updated = sb("PATCH",
                 "dispatch_jobs?id=eq.%s&status=eq.queued" % urllib.parse.quote(job["id"]),
                 body={"status": "processing", "updated_at": now()},
                 headers={"Prefer": "return=representation"})
    if not updated:  # someone else took it
        return None
    return job

def already_posted(order_no):
    q = "dispatch_jobs?order_no=eq.%s&status=eq.posted&select=voucher&limit=1" % urllib.parse.quote(order_no)
    try:
        rows = sb("GET", q)
        if rows: return rows[0].get("voucher") or "yes"
    except Exception:
        pass
    return None

def set_job(job_id, status, voucher="", note=""):
    body = {"status": status, "updated_at": now()}
    if voucher: body["voucher"] = voucher
    if note: body["note"] = note[:400]
    try:
        sb("PATCH", "dispatch_jobs?id=eq.%s" % urllib.parse.quote(job_id), body=body)
    except Exception as e:
        log("  set_job failed:", e)

# --------------------------------------------------------------- agent runner
def run_agent(local_txt, nlines):
    try:
        if os.path.exists(RESULT_JSON): os.remove(RESULT_JSON)
    except Exception: pass
    cmd = [PYEXE, AGENT, "dispatch", "--txt", local_txt, "--new", "--wait", "90"]
    if armed():
        cmd.insert(cmd.index("--new"), "--post")
        log("  ARMED -> agent WILL post one voucher")
    else:
        log("  NOT armed (no ARM_DISPATCH) -> agent FILLS but does NOT post")
    timeout = int(BASE_SEC + PER_LINE * max(1, nlines))
    log("  running:", " ".join(cmd), "(timeout", timeout, "s)")
    try:
        p = subprocess.run(cmd, cwd=PACT_DIR, capture_output=True, text=True, timeout=timeout)
        tail = (p.stdout or "").strip().splitlines()
        if tail: log("  agent tail:", tail[-1][:200])
    except subprocess.TimeoutExpired:
        return "FAILED", "", "agent timed out after %ss" % timeout
    except Exception as e:
        return "FAILED", "", "agent launch error: %s" % e
    try:
        rec = json.load(open(RESULT_JSON, encoding="utf-8"))
        return rec.get("status", "UNKNOWN"), rec.get("voucher", ""), rec.get("note", "")
    except Exception as e:
        return "UNKNOWN", "", "no pact_result.json (%s)" % e

# --------------------------------------------------------------- core
def process_one():
    # Stay fully dormant until armed: don't claim or touch PACT, so we can never
    # interfere with the app's current post path during the transition. Jobs just
    # sit 'queued' until ARM_DISPATCH exists (created for the supervised test).
    if not armed():
        return False
    job = claim_next()
    if not job: return False
    order = job.get("order_no") or ""
    log("claimed job", job["id"], "order", order)

    dup = already_posted(order)
    if dup:
        log("  DUPLICATE: order already posted as", dup, "-> not re-posting")
        set_job(job["id"], "posted", voucher=(dup if dup != "yes" else ""), note="duplicate submit; original voucher kept")
        return True

    txt = job.get("txt") or ""
    if not txt:
        bc = job.get("barcodes") or []
        txt = ("Order: %s\nOutlet: %s\nIssueType: %s\nTotal lines: %d\n%s\n" %
               (order, job.get("outlet",""), job.get("issue_type","Frozen"), len(bc), "\n".join(bc)))
    nlines = sum(1 for l in txt.splitlines() if re.match(r"^[A-Za-z0-9]+_.+_\d+$", l.strip()))

    os.makedirs(INBOX_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9-]+", "_", order) or "order"
    local_txt = os.path.join(INBOX_DIR, safe + ".txt")
    with open(local_txt, "w", encoding="utf-8") as f:
        f.write(txt)

    status, voucher, note = run_agent(local_txt, nlines)
    if status == "POSTED" and voucher:
        set_job(job["id"], "posted", voucher=voucher, note=note)
        log("  DONE: order", order, "posted as", voucher)
    elif status in ("FILLED_NOT_POSTED",):
        # safe mode: put it back so an armed run can post it
        set_job(job["id"], "queued", note="filled (not armed); awaiting arm")
        log("  filled but NOT posted (safe mode); left queued")
    else:
        set_job(job["id"], "failed", note=note or status)
        log("  FAILED: order", order, "status", status, "note", note)
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    if not SB_URL or not SB_KEY:
        log("FATAL: SUPABASE_URL / SUPABASE_SERVICE_KEY not set (put them in %s)" % ENV_FILE)
        sys.exit(2)
    log("=" * 60)
    log("dispatch_watcher starting  poll=%ss armed=%s agent=%s" % (POLL, armed(), AGENT))
    if args.once:
        try: log("once:", "processed" if process_one() else "nothing queued")
        except Exception: log("error:\n" + traceback.format_exc())
        return
    while True:
        try: process_one()
        except Exception: log("loop error:\n" + traceback.format_exc())
        time.sleep(POLL)

if __name__ == "__main__":
    main()
