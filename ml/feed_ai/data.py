"""Strict, bounded input contract for verified feed events, never message contents."""
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import UUID

MAX_EVENTS = 10_000
MAX_BYTES = 8 * 1024 * 1024
SIGNAL_LABEL = {
    "view": 0.1, "dwell_medium": 0.4, "dwell_long": 0.7, "watch_complete": 0.9,
    "like": 0.8, "comment": 0.9, "share": 1.0, "save": 0.9, "click": 0.5,
    "hide": -0.8, "not_interested": -0.9, "report": -1.0, "skip_fast": -0.4,
}
EVENT_FIELDS = {"id", "user_id", "post_id", "signal_type", "created_at"}


def timestamp(value: str) -> datetime:
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("INVALID_TIMESTAMP")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.utcoffset() is None:
        raise ValueError("TIMESTAMP_REQUIRES_TIMEZONE")
    return result.astimezone(timezone.utc)


@dataclass(frozen=True)
class Event:
    id: str
    user: str
    post: str
    signal: str
    at: datetime

    def row(self) -> dict:
        return {"id": self.id, "user_id": self.user, "post_id": self.post,
                "signal_type": self.signal, "created_at": self.at.isoformat()}


def parse_events(rows: list) -> list[Event]:
    if not isinstance(rows, list) or len(rows) > MAX_EVENTS:
        raise ValueError("EVENT_LIMIT_EXCEEDED")
    events, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != EVENT_FIELDS:
            raise ValueError("UNEXPECTED_EVENT_FIELDS")
        # The database currently uses UUID interaction IDs; reject opaque content.
        ids = []
        for field in ("id", "user_id", "post_id"):
            if not isinstance(row[field], str):
                raise ValueError("INVALID_EVENT_ID")
            ids.append(str(UUID(row[field])))
        event_id, user, post = ids
        if event_id in seen:
            raise ValueError("DUPLICATE_EVENT_ID")
        seen.add(event_id)
        if row["signal_type"] not in SIGNAL_LABEL:
            raise ValueError("UNSUPPORTED_SIGNAL")
        events.append(Event(event_id, user, post, row["signal_type"], timestamp(row["created_at"])))
    return sorted(events, key=lambda event: (event.at, event.id))


def read_dataset(path: Path) -> dict:
    with path.open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("DATASET_TOO_LARGE")
    dataset = json.loads(raw)
    validate_dataset(dataset)
    return dataset


def validate_dataset(dataset: dict) -> list[Event]:
    if not isinstance(dataset, dict) or set(dataset) != {"schema", "source", "as_of", "events"}:
        raise ValueError("INVALID_DATASET")
    if dataset["schema"] != 1 or dataset["source"] not in ("synthetic", "lovable_cloud"):
        raise ValueError("INVALID_DATASET_SOURCE")
    as_of = timestamp(dataset["as_of"])
    events = parse_events(dataset["events"])
    if any(e.at > as_of or (as_of - e.at).total_seconds() >= 14 * 86400 for e in events):
        raise ValueError("EVENT_OUTSIDE_EXPORT_WINDOW")
    return events


def digest_dataset(dataset: dict) -> str:
    events = validate_dataset(dataset)
    canonical = {**dataset, "events": [e.row() for e in events]}
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class Pair:
    user: str
    post: str
    label: float


def aggregate(events: list[Event]) -> list[Pair]:
    groups: dict[tuple[str, str], set[float]] = {}
    for e in events:
        groups.setdefault((e.user, e.post), set()).add(SIGNAL_LABEL[e.signal])
    # Negative feedback dominates engagement; repeated views cannot dilute a hide.
    return [Pair(u, p, min(labels) if min(labels) < 0 else max(labels))
            for (u, p), labels in sorted(groups.items())]


def temporal_split(events: list[Event]) -> tuple[list[Pair], list[Pair], dict]:
    ordered = sorted(events, key=lambda e: (e.at, e.id))
    if len(ordered) < 2:
        raise ValueError("INSUFFICIENT_TEMPORAL_DATA")
    cutoff = ordered[min(len(ordered) - 1, int(len(ordered) * 0.8))].at
    train_events = [e for e in ordered if e.at < cutoff]
    if not train_events:
        raise ValueError("INSUFFICIENT_TEMPORAL_DATA")
    train = aggregate(train_events)
    seen_pairs = {(p.user, p.post) for p in train}
    future = aggregate([e for e in ordered if e.at >= cutoff])
    holdout = [p for p in future if (p.user, p.post) not in seen_pairs]
    return train, holdout, {"cutoff": cutoff.isoformat(),
        "train_events": len(train_events), "holdout_events": len(ordered) - len(train_events),
        "repeat_pairs_excluded": len(future) - len(holdout)}
