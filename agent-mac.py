#!/usr/bin/env python3
"""Poll Worker pending To Do titles; create them via Super Productivity Local REST API."""
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

def loop():
    print("SP health", sp("/health"), flush=True)
    while True:
        try:
            pending = worker("/agent/pending").get("pending") or []
            acked = []
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
            if acked:
                worker("/agent/ack", method="POST", data={"ids": acked})
        except Exception as e:
            print("poll error", e, flush=True)
        time.sleep(INTERVAL)

if __name__ == "__main__":
    loop()
