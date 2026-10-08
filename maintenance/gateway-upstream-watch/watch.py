#!/usr/bin/env python3
"""Read public upstream evidence; leave interpretation and alerts to Hermes. Stdlib only."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

MAX_BYTES = 4 * 1024 * 1024
TOPICS = re.compile(r"compac|responses|codex|claude|gemini|tool|strict|schema|stream|sse|websocket|context|catalog|signature|thinking|proxy|oauth|retry|429|failover|gateway|provider|certificate|multimodal|image|resume", re.I)


def github_token():
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        return token
    # Reuse the VPS's existing GitHub credential in memory, only for api.github.com.
    # Verify the checkout origin first; never print helper output or persist the credential.
    checkout = Path("/opt/zencore")
    if not checkout.is_dir():
        return None
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
    try:
        origin = subprocess.run(["git", "remote", "get-url", "origin"], cwd=checkout, env=env, capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        if origin != "https://github.com/louisphamdev/zencore.git":
            return None
        result = subprocess.run(["git", "credential", "fill"], cwd=checkout, env=env, capture_output=True, text=True, timeout=10,
                                input="protocol=https\nhost=github.com\npath=louisphamdev/zencore.git\n\n", check=True)
        fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        return fields.get("password") or None
    except (OSError, subprocess.SubprocessError):
        return None


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write("\n")
        temporary = f.name
    os.replace(temporary, path)


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def fetch(url, token=None):
    headers = {"User-Agent": "Hermes-gateway-upstream-watch/1", "Accept": "application/json" if url.startswith("https://api.github.com/") else "*/*"}
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise RuntimeError("source exceeds 4 MiB evidence limit")
        return data, dict(response.headers)


def atom_entries(data):
    ns = {"a": "http://www.w3.org/2005/Atom"}
    root = ET.fromstring(data)
    entries = []
    for item in root.findall("a:entry", ns):
        link = next((x.get("href") for x in item.findall("a:link", ns) if x.get("rel", "alternate") == "alternate"), None)
        entries.append({"id": item.findtext("a:id", "", ns), "title": item.findtext("a:title", "", ns).strip(),
                        "updated_at": item.findtext("a:updated", "", ns), "url": link})
    return entries


class PageText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip and data.strip():
            self.parts.append(data.strip())


def scan_repo(repo, since, prior, token):
    name = repo["repo"]
    result = {"repo": name, "group": repo["group"], "since": since, "sources": {}, "errors": [], "issues": [], "commits": [], "releases": []}
    complete = True
    # Atom feeds avoid spending GitHub API quota on public releases/commits.
    for kind, url in [("releases", f"https://github.com/{name}/releases.atom"),
                      ("commits", f"https://github.com/{name}/commits/{urllib.parse.quote(repo['branch'], safe='')}.atom")]:
        try:
            raw, _ = fetch(url)
            items = atom_entries(raw)
            seen = set(prior.get(kind, []))
            result[kind] = [x for x in items if x["id"] not in seen]
            result["sources"][kind] = {"ok": True, "url": url, "ids": [x["id"] for x in items], "scope": "latest feed entries; older entries require source review"}
        except Exception as error:
            try:
                endpoint = f"https://api.github.com/repos/{name}/releases?per_page=30" if kind == "releases" else f"https://api.github.com/repos/{name}/commits?" + urllib.parse.urlencode({"sha": repo["branch"], "per_page": 30})
                raw, _ = fetch(endpoint, token)
                values = json.loads(raw)
                if not isinstance(values, list):
                    raise RuntimeError("unexpected fallback API response")
                items = [{"id": str(x.get("id") or x.get("sha")), "title": x.get("name") or x.get("tag_name") or x.get("commit", {}).get("message", "").split("\n")[0],
                          "updated_at": x.get("published_at") or x.get("commit", {}).get("committer", {}).get("date"), "url": x.get("html_url")} for x in values]
                seen = set(prior.get(kind, []))
                result[kind] = [x for x in items if x["id"] not in seen]
                result["sources"][kind] = {"ok": True, "url": endpoint, "ids": [x["id"] for x in items], "fallback": True, "scope": "latest 30 entries; older entries require source review"}
            except Exception as fallback_error:
                complete = False
                result["sources"][kind] = {"ok": False, "url": url}
                result["errors"].append(f"{kind}: {type(fallback_error).__name__}: {fallback_error}")
    try:
        rows = []
        max_pages = 50 if token else 2
        for page in range(1, max_pages + 1):
            query = urllib.parse.urlencode({"state": "all", "sort": "updated", "direction": "desc", "since": since, "per_page": 100, "page": page})
            raw, headers = fetch(f"https://api.github.com/repos/{name}/issues?{query}", token)
            batch = json.loads(raw)
            if not isinstance(batch, list):
                raise RuntimeError("unexpected GitHub issue response")
            rows.extend(batch)
            if len(batch) < 100:
                break
        partial = len(batch) == 100
        result["sources"]["issues"] = {"ok": True, "partial": partial, "fetched": len(rows), "quota_remaining": headers.get("X-RateLimit-Remaining", headers.get("x-ratelimit-remaining"))}
        complete = complete and not partial
        # Retain every fetched title and status. Mark topics to help review without discarding evidence.
        result["issues"] = [{"number": x["number"], "title": x["title"], "state": x["state"], "updated_at": x["updated_at"],
                             "url": x["html_url"], "pr": "pull_request" in x, "comments": x.get("comments", 0),
                             "topic_match": bool(TOPICS.search(x["title"]))} for x in rows]
        if partial:
            result["errors"].append(f"issues: {max_pages * 100}-entry cap reached; older changes remain unscanned, checkpoint not advanced")
    except Exception as error:
        complete = False
        result["sources"]["issues"] = {"ok": False}
        result["errors"].append(f"issues: {type(error).__name__}: {error}")
    result["complete"] = complete
    return result


def main():
    parser = argparse.ArgumentParser()
    default_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    parser.add_argument("--manifest", type=Path, default=default_home / "skills/devops/gateway-upstream-watch/references/repos.json")
    parser.add_argument("--state-dir", type=Path, default=default_home / "gateway-upstream-watch")
    parser.add_argument("--only", help="one repository for a bounded smoke check")
    parser.add_argument("--no-checkpoint", action="store_true", help="probe without advancing persistent scan state")
    args = parser.parse_args()
    manifest = read_json(args.manifest, None)
    if manifest is None:
        raise RuntimeError("verified repository manifest is missing")
    state_path = args.state_dir / "scan-state.json"
    state = read_json(state_path, {"repos": {}, "docs": {}})
    now = datetime.now(timezone.utc)
    token = github_token()
    repos = [r for r in manifest["repos"] if not args.only or r["repo"] == args.only]
    if not repos:
        raise RuntimeError("requested repository is not in the verified manifest")
    report = {"checked_at": now.isoformat(), "authenticated_github": bool(token), "requested_repos": len(repos), "repos": [], "docs": [],
              "review_required": True, "scope": "GitHub issue metadata plus latest release/commit feeds; the agent must read source/diffs for conclusions"}
    with ThreadPoolExecutor(max_workers=3) as pool:
        tasks = {}
        for repo in repos:
            prior = state["repos"].get(repo["repo"], {})
            checkpoint = prior.get("checkpoint")
            since = (datetime.fromisoformat(checkpoint) - timedelta(hours=2) if checkpoint else now - timedelta(days=2)).isoformat()
            tasks[pool.submit(scan_repo, repo, since, prior, token)] = repo
        for task in as_completed(tasks):
            result = task.result()
            report["repos"].append(result)
            prior = state["repos"].setdefault(result["repo"], {})
            if result["complete"]:
                prior["checkpoint"] = now.isoformat()
            for kind in ("commits", "releases"):
                if result["sources"][kind]["ok"]:
                    prior[kind] = result["sources"][kind]["ids"]
    if not args.only:
        for url in manifest["docs"]:
            try:
                raw, _ = fetch(url)
                page = PageText()
                page.feed(raw.decode("utf-8", errors="replace"))
                digest = hashlib.sha256(" ".join(page.parts).encode()).hexdigest()
                old = state["docs"].get(url)
                report["docs"].append({"url": url, "ok": True, "changed": old != digest, "first_check": old is None, "hash": digest})
                state["docs"][url] = digest
            except Exception as error:
                report["docs"].append({"url": url, "ok": False, "error": f"{type(error).__name__}: {error}"})
    report["repos"].sort(key=lambda x: x["repo"])
    report["complete_repos"] = sum(r["complete"] for r in report["repos"])
    report["partial"] = report["complete_repos"] != len(repos) or any(not d["ok"] for d in report["docs"])
    target = args.state_dir / "evidence" / f"{now.strftime('%Y-%m-%dT%H-%M-%S')}.json"
    atomic_json(target, report)
    atomic_json(args.state_dir / "latest.json", report)
    if not args.no_checkpoint:
        atomic_json(state_path, state)
    print(json.dumps({"evidence_file": str(target), "requested_repos": len(repos), "complete_repos": report["complete_repos"], "partial": report["partial"],
                      "instruction": "Read the evidence JSON and gateway-upstream-watch skill. Report incomplete sources explicitly; metadata alone is not a verified fix."}, ensure_ascii=False))


if __name__ == "__main__":
    main()
