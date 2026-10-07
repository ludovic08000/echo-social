"""Read-only adapter to the existing Lovable Cloud feed training RPC.

No SDK credentials are read from disk; no table write or publication endpoint exists.
"""
from datetime import datetime, timezone
import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .data import EVENT_FIELDS, MAX_EVENTS, parse_events, validate_dataset


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward privileged credentials to a redirect destination.
        raise ValueError("CLOUD_REDIRECT_REJECTED")


def validate_connection(base_url: str, service_key: str):
    parsed = urlsplit(base_url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/") or parsed.port not in (None, 443)):
        raise ValueError("LOVABLE_API_HTTPS_ORIGIN_REQUIRED")
    if not service_key or "\n" in service_key or "\r" in service_key:
        raise ValueError("LOVABLE_SERVER_CREDENTIAL_REQUIRED")


def fetch_dataset(base_url: str, service_key: str, limit=5000, *, opener=None, clock=time.monotonic) -> dict:
    if type(limit) is not int or not 1 <= limit <= MAX_EVENTS:
        raise ValueError("EVENT_LIMIT_EXCEEDED")
    validate_connection(base_url, service_key)
    opener = opener or build_opener(NoRedirect())
    as_of, started = datetime.now(timezone.utc).isoformat(), clock()
    rows, seen = [], set()
    # Small pages also work with a gateway row cap below 1000. Fixed as_of excludes new events.
    for _ in range(100):
        if clock() - started >= 90:
            raise TimeoutError("CLOUD_READ_BUDGET_EXCEEDED")
        query = urlencode({"p_limit": limit, "p_as_of": as_of,
            "select": ",".join(sorted(EVENT_FIELDS)), "order": "created_at.desc,id.desc",
            "offset": len(rows), "limit": min(500, limit - len(rows))})
        request = Request(base_url.rstrip("/") + "/rest/v1/rpc/feed_training_events?" + query,
                          headers={"apikey": service_key, "Authorization": "Bearer " + service_key,
                                   "Accept": "application/json"}, method="GET")
        try:
            with opener.open(request, timeout=min(10, max(0.1, 90 - (clock() - started)))) as response:
                payload = response.read(512 * 1024 + 1)
        except HTTPError as error:
            # Avoid logging provider bodies, user IDs, credentials, or request URLs.
            raise ValueError(f"CLOUD_RPC_HTTP_{error.code}") from None
        except (URLError, OSError):
            raise ValueError("CLOUD_RPC_UNAVAILABLE") from None
        if len(payload) > 512 * 1024:
            raise ValueError("CLOUD_RESPONSE_TOO_LARGE")
        try:
            batch = json.loads(payload)
            parsed_events = parse_events(batch)
        except (ValueError, TypeError, KeyError):
            raise ValueError("CLOUD_EVENT_CONTRACT_INVALID") from None
        if len(batch) > min(500, limit - len(rows)):
            raise ValueError("CLOUD_PAGE_LIMIT_EXCEEDED")
        if any(e.id in seen for e in parsed_events):
            raise ValueError("CLOUD_PAGINATION_UNSTABLE")
        seen.update(e.id for e in parsed_events)
        rows.extend(e.row() for e in parsed_events)
        if not batch or len(rows) >= limit:
            dataset = {"schema": 1, "source": "lovable_cloud", "as_of": as_of, "events": rows}
            validate_dataset(dataset)
            return dataset
    raise ValueError("CLOUD_PAGE_BUDGET_EXCEEDED")


def fetch_evaluation(base_url: str, service_key: str, *, opener=None) -> dict:
    from .data import MAX_BYTES
    from .evaluation import validate_slates
    validate_connection(base_url, service_key)
    query = urlencode({"p_limit": 50})
    request = Request(base_url.rstrip("/") + "/rest/v1/rpc/feed_evaluation_slates?" + query,
        headers={"apikey": service_key, "Authorization": "Bearer " + service_key, "Accept": "application/json"},
        method="GET")
    try:
        with (opener or build_opener(NoRedirect())).open(request, timeout=15) as response:
            payload = response.read(MAX_BYTES+1)
    except HTTPError as error:
        raise ValueError(f"CLOUD_RPC_HTTP_{error.code}") from None
    except (URLError, OSError):
        raise ValueError("CLOUD_RPC_UNAVAILABLE") from None
    if len(payload)>MAX_BYTES:
        raise ValueError("CLOUD_RESPONSE_TOO_LARGE")
    try:
        dataset = json.loads(payload)
        validate_slates(dataset)
        if dataset["source"] != "lovable_cloud":
            raise ValueError("INVALID_REPLAY_SOURCE")
        return dataset
    except (ValueError, TypeError, KeyError):
        raise ValueError("CLOUD_REPLAY_CONTRACT_INVALID") from None
