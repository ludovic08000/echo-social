"""Synthetic category preferences only; never presented as production evidence."""
from datetime import datetime, timedelta, timezone
from random import Random
from uuid import NAMESPACE_URL, uuid5


def demo_dataset(post_count=80) -> dict:
    if type(post_count) is not int or not 5 <= post_count <= 200:
        raise ValueError("DEMO_SIZE_LIMIT")
    pairs = [(u, p) for u in range(40) for p in range(post_count)]
    Random(43).shuffle(pairs)
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    events = []
    for i, (u, p) in enumerate(pairs):
        events.append({"id": str(uuid5(NAMESPACE_URL, f"demo-event:{i}")),
            "user_id": str(uuid5(NAMESPACE_URL, f"demo-user:{u}")),
            "post_id": str(uuid5(NAMESPACE_URL, f"demo-post:{p}")),
            "signal_type": "like" if u % 4 == p % 4 else "skip_fast",
            "created_at": (start + timedelta(seconds=i)).isoformat()})
    return {"schema": 1, "source": "synthetic", "as_of": (start + timedelta(seconds=len(events)+60)).isoformat(), "events": events}


def demo_replay() -> dict:
    """Fresh, explicitly fictional observations for 40 slates of 200 candidates."""
    rng = Random(52)
    created = datetime(2026,1,2,tzinfo=timezone.utc).isoformat()
    slates = []
    for user in range(40):
        posts = list(range(200))
        rng.shuffle(posts)
        slates.append({"slate_id": str(uuid5(NAMESPACE_URL,f"demo-slate:{user}")),
            "user_id": str(uuid5(NAMESPACE_URL,f"demo-user:{user}")),
            "created_at": created, "mode": "smart", "author_cap": 2, "variant": "a", "revision": "a"*32,
            "items": [{"post_id": str(uuid5(NAMESPACE_URL,f"demo-post:{p}")),
                       "creator_id": str(uuid5(NAMESPACE_URL,f"demo-creator:{p%20}")),
                       "position": i+1, "served_at": created,
                       "signals": ["like" if user%4==p%4 else "skip_fast"]} for i,p in enumerate(posts)]})
    return {"schema": 1, "source": "synthetic", "as_of": "2026-01-02T00:10:00+00:00",
            "observation_seconds": 300, "slates": slates}
