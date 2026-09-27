"""Generic REST API -> S3 raw-zone ingester.

Invoked by EventBridge Scheduler with {"source": "<name>"}. The source configuration
lives in SSM Parameter Store (written by Terraform) so a manual invoke with the same
payload reproduces a scheduled run. Optional overrides can be passed in the event:
    {"source": "github_issues", "query_params": {"since": "2024-01-01"}}

Output: s3://<RAW_BUCKET>/api/<source>/ingest_date=YYYY-MM-DD/<run_id>_<page>.json.gz
Each file is gzipped NDJSON (one record per line) with ingestion metadata, which
Snowflake loads with FILE_FORMAT = (TYPE = JSON).
"""

import base64
import gzip
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

s3 = boto3.client("s3")
ssm = boto3.client("ssm")
secrets = boto3.client("secretsmanager")

RAW_BUCKET = os.environ["RAW_BUCKET"]
CONFIG_PREFIX = os.environ["CONFIG_PREFIX"]
REQUEST_TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT", "60"))
MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "5"))

LINK_NEXT_RE = re.compile(r'<([^>]+)>;\s*rel="?next"?')


def _dig(obj, path):
    """Return obj[a][b][c] for path 'a.b.c' (None if missing)."""
    if not path:
        return obj
    for part in path.split("."):
        if isinstance(obj, dict):
            obj = obj.get(part)
        elif isinstance(obj, list) and part.isdigit() and int(part) < len(obj):
            obj = obj[int(part)]
        else:
            return None
    return obj


def _load_config(source):
    param = ssm.get_parameter(Name=f"{CONFIG_PREFIX}/{source}")
    return json.loads(param["Parameter"]["Value"])


def _auth_headers(cfg):
    auth_type = cfg.get("auth_type", "none")
    if auth_type == "none":
        return {}
    secret = json.loads(secrets.get_secret_value(SecretId=cfg["secret_arn"])["SecretString"])
    if auth_type == "bearer":
        return {"Authorization": f"Bearer {secret['token']}"}
    if auth_type == "api_key":
        return {cfg.get("api_key_header", "x-api-key"): secret["api_key"]}
    if auth_type == "basic":
        creds = base64.b64encode(f"{secret['username']}:{secret['password']}".encode()).decode()
        return {"Authorization": f"Basic {creds}"}
    raise ValueError(f"Unsupported auth_type: {auth_type}")


def _request(method, url, headers, body):
    data = body.encode() if body else None
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as err:
            retryable = err.code == 429 or err.code >= 500
            if not retryable or attempt == MAX_RETRIES - 1:
                raise
            wait = int(err.headers.get("Retry-After", 0) or 0) or 2**attempt
            logger.warning("HTTP %s on %s, retrying in %ss", err.code, url, wait)
            time.sleep(min(wait, 60))
        except urllib.error.URLError as err:
            if attempt == MAX_RETRIES - 1:
                raise
            logger.warning("Network error %s on %s, retrying", err.reason, url)
            time.sleep(2**attempt)
    raise RuntimeError("unreachable")


def _build_url(base_url, params):
    if not params:
        return base_url
    parts = urllib.parse.urlsplit(base_url)
    query = dict(urllib.parse.parse_qsl(parts.query))
    query.update({k: str(v) for k, v in params.items()})
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def _extract_records(payload, records_path):
    records = _dig(payload, records_path) if records_path else payload
    if records is None:
        return []
    return records if isinstance(records, list) else [records]


def _write(source, run_id, page, records, meta):
    now = datetime.now(timezone.utc)
    key = f"api/{source}/ingest_date={now:%Y-%m-%d}/{run_id}_{page:05d}.json.gz"
    lines = (
        json.dumps({"_ingested_at": meta["ingested_at"], "_source": source, "_url": meta["url"], "data": r})
        for r in records
    )
    body = gzip.compress(("\n".join(lines) + "\n").encode())
    s3.put_object(Bucket=RAW_BUCKET, Key=key, Body=body, ContentType="application/x-ndjson", ContentEncoding="gzip")
    return key


def handler(event, _context):
    source = event["source"]
    cfg = _load_config(source)
    cfg["query_params"] = {**cfg.get("query_params", {}), **event.get("query_params", {})}

    pag = cfg.get("pagination") or {}
    pag_type = pag.get("type", "none")
    max_pages = int(pag.get("max_pages", 1000))
    size = int(pag.get("size", 100))

    headers = {"Accept": "application/json", "User-Agent": "data-platform-ingest/1.0"}
    headers.update(cfg.get("headers", {}))
    headers.update(_auth_headers(cfg))
    if cfg.get("body"):
        headers.setdefault("Content-Type", "application/json")

    run_id = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}_{uuid.uuid4().hex[:8]}"
    ingested_at = datetime.now(timezone.utc).isoformat()

    params = dict(cfg["query_params"])
    if pag.get("size_param"):
        params[pag["size_param"]] = size
    position = pag.get("start")
    if position is None:
        position = 0 if pag_type == "offset" else 1
    next_url = None
    written, total = [], 0

    for page in range(max_pages):
        if pag_type in ("page", "offset"):
            params[pag.get("param", "page")] = position
        url = next_url or _build_url(cfg["url"], params)

        _status, resp_headers, raw = _request(cfg.get("method", "GET"), url, headers, cfg.get("body"))
        payload = json.loads(raw) if raw else None
        records = _extract_records(payload, cfg.get("records_path"))

        if records:
            written.append(_write(source, run_id, page, records, {"ingested_at": ingested_at, "url": url}))
            total += len(records)

        if pag_type == "none" or not records:
            break
        if pag_type == "page":
            position += 1
        elif pag_type == "offset":
            if len(records) < size:
                break
            position += size
        elif pag_type == "cursor":
            cursor = _dig(payload, pag.get("cursor_path"))
            if not cursor:
                break
            params[pag.get("param", "cursor")] = cursor
        elif pag_type == "link_header":
            match = LINK_NEXT_RE.search(resp_headers.get("Link", "") or resp_headers.get("link", ""))
            if not match:
                break
            next_url = match.group(1)
    else:
        logger.warning("Reached max_pages=%s for %s, data may be incomplete", max_pages, source)

    result = {"source": source, "run_id": run_id, "records": total, "files": len(written)}
    logger.info(json.dumps(result))
    return result
