#!/usr/bin/env python3
"""Poll Worker pending To Do titles and create them via Super Productivity Local REST API."""
import json, os, time, urllib.request

WORKER = os.environ.get("SP_WORKER", "https://sp-todo-sync.marknelson.workers.dev")
DEBUG = os.environ["SP_DEBUG_SECRET"]
SP = os.environ.get("SP_API", "http://127.0.0.1:3876")
TOKEN = os.environ.get("SP_API_TOKEN", "")
INTERVAL = int(os.environ.get("SP_POLL_SEC", "30"))

def req(url, method="GET", data=None, headers=None):
    h = headers or {}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=body, headers=h, method=method)
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())

def worker(path, method="GET", data=None):
    return req(
        WORKER + path,
        method=method,
        data=data,
        headers={"Authorization": "Bearer " + DEBUG},
    )

def sp(path, method="GET", data=None):
    h = {}
    if TOKEN:
        h["Authorization"] = "Bearer " + TOKEN
    return req(SP + path, method=method, data=data, headers=h)

def loop():
    health = req(SP + "/health")
    print("SP health", health, flush=True)
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
