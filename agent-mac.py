#!/usr/bin/env python3
"""Poll Worker for new/complete To Do items; apply via Super Productivity Local REST API."""
import json, os, subprocess, time

WORKER = os.environ.get("SP_WORKER", "https://sp-todo-sync.marknelson.workers.dev")
DEBUG = os.environ["SP_DEBUG_SECRET"]
SP = os.environ.get("SP_API", "http://127.0.0.1:3876")
TOKEN = os.environ.get("SP_API_TOKEN", "")
INTERVAL = int(os.environ.get("SP_POLL_SEC", "30"))

def curl(url, method="GET", data=None, bearer=None):
    cmd = [
        "curl", "-fsS", "--noproxy", "*",
        "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "-H", "Accept: application/json",
        "-X", method,
        "--max-time", "30",
        url,
    ]
    if bearer:
        cmd.extend(["-H", "Authorization: Bearer " + bearer])
    if data is not None:
        cmd.extend(["-H", "Content-Type: application/json", "-d", json.dumps(data)])
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip() or f"curl {p.returncode}")
    return json.loads(p.stdout) if p.stdout.strip() else {}

def worker(path, method="GET", data=None):
    return curl(WORKER + path, method=method, data=data, bearer=DEBUG)

def sp(path, method="GET", data=None):
    return curl(SP + path, method=method, data=data, bearer=TOKEN or None)

def task_list():
    raw = sp("/tasks")
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        data = raw.get("data", raw)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "tasks" in data:
            return data["tasks"]
    return []

def norm(s):
    return " ".join((s or "").lower().split())

def loop():
    print("SP health", sp("/health"), flush=True)
    while True:
        try:
            payload = worker("/agent/pending")
            pending = payload.get("pending") or []
            complete = payload.get("complete") or []
            acked, acked_done = [], []
            for item in pending:
                title = (item.get("title") or "").strip()
                if not title:
                    continue
                body = {"title": title, "projectId": "INBOX_PROJECT", "notes": item.get("notes") or ""}
                try:
                    sp("/tasks", method="POST", data=body)
                    acked.append(item["id"])
                    print("created", title[:60], flush=True)
                except Exception as e:
                    print("create failed", title[:40], e, flush=True)
            if complete:
                tasks = task_list()
                by = {}
                for t in tasks:
                    if t.get("isDone"):
                        continue
                    by.setdefault(norm(t.get("title") or ""), []).append(t)
                for item in complete:
                    n = item.get("titleNorm") or norm(item.get("title") or "")
                    hits = by.get(n) or []
                    if len(hits) != 1:
                        print("complete skip", (item.get("title") or "")[:40], "matches", len(hits), flush=True)
                        acked_done.append(item["id"])
                        continue
                    tid = hits[0].get("id")
                    try:
                        sp("/tasks/" + tid, method="PATCH", data={"isDone": True})
                        acked_done.append(item["id"])
                        print("completed", (item.get("title") or "")[:60], flush=True)
                    except Exception as e:
                        print("complete failed", (item.get("title") or "")[:40], e, flush=True)
            if acked or acked_done:
                worker("/agent/ack", method="POST", data={"ids": acked, "completeIds": acked_done})
        except Exception as e:
            print("poll error", e, flush=True)
        time.sleep(INTERVAL)

if __name__ == "__main__":
    loop()
