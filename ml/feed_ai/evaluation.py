"""Paired replay against actual served order, with user-clustered uncertainty.

Observed feedback is position-biased. This module never estimates a causal A/B
effect, invents negative labels for unseen items, or approves model publication.
"""
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import time
from uuid import UUID
import numpy as np

from .data import MAX_BYTES, Pair, SIGNAL_LABEL, timestamp
from .model import Ranker, ndcg


@dataclass(frozen=True)
class ReplayPolicy:
    model_blend: float = 0.25
    minimum_coverage: float = 0.9
    window: int = 12

    def validate(self):
        if not math.isfinite(self.model_blend) or not 0 <= self.model_blend <= 0.5:
            raise ValueError("REPLAY_BLEND_LIMIT")
        if not math.isfinite(self.minimum_coverage) or not 0.9 <= self.minimum_coverage <= 1:
            raise ValueError("REPLAY_COVERAGE_LIMIT")
        if self.window != 12:
            raise ValueError("REPLAY_WINDOW_MUST_MATCH_SERVER")


def validate_slates(dataset: dict) -> list[dict]:
    if not isinstance(dataset, dict) or set(dataset) != {"schema", "source", "as_of", "observation_seconds", "slates"}:
        raise ValueError("INVALID_REPLAY_CONTRACT")
    if (dataset["schema"] != 1 or dataset["source"] not in ("synthetic", "lovable_cloud")
            or dataset["observation_seconds"] != 300):
        raise ValueError("INVALID_REPLAY_SOURCE")
    as_of = timestamp(dataset["as_of"])
    slates = dataset["slates"]
    if not isinstance(slates, list) or len(slates) > 500:
        raise ValueError("REPLAY_SLATE_LIMIT")
    seen = set()
    for slate in slates:
        if not isinstance(slate, dict) or set(slate) != {
                "slate_id", "user_id", "created_at", "mode", "author_cap", "variant", "revision", "items"}:
            raise ValueError("INVALID_SLATE_FIELDS")
        for name in ("slate_id", "user_id"):
            if not isinstance(slate[name], str) or str(UUID(slate[name])) != slate[name]:
                raise ValueError("INVALID_SLATE_ID")
        if slate["slate_id"] in seen:
            raise ValueError("DUPLICATE_SLATE")
        seen.add(slate["slate_id"])
        created = timestamp(slate["created_at"])
        if created > as_of or (as_of-created).total_seconds() > 86400:
            raise ValueError("REPLAY_TIME_WINDOW")
        if (slate["variant"] not in ("a", "b") or not isinstance(slate["revision"], str)
                or not re.fullmatch(r"[a-f0-9]{32}", slate["revision"])):
            raise ValueError("INVALID_SLATE_REVISION")
        if not isinstance(slate["mode"], str) or not re.fullmatch(r"[a-z_-]{1,32}", slate["mode"]):
            raise ValueError("INVALID_SLATE_MODE")
        if type(slate["author_cap"]) is not int or not 1 <= slate["author_cap"] <= 12:
            raise ValueError("INVALID_SLATE_POLICY")
        items, posts, previous = slate["items"], set(), 0
        if not isinstance(items, list) or not 5 <= len(items) <= 200:
            raise ValueError("REPLAY_ITEM_LIMIT")
        for item in items:
            if not isinstance(item, dict) or set(item) != {"post_id", "creator_id", "position", "served_at", "signals"}:
                raise ValueError("INVALID_REPLAY_ITEM")
            for name in ("post_id", "creator_id"):
                if not isinstance(item[name], str) or str(UUID(item[name])) != item[name]:
                    raise ValueError("INVALID_ITEM_ID")
            if item["post_id"] in posts:
                raise ValueError("DUPLICATE_REPLAY_POST")
            posts.add(item["post_id"])
            if type(item["position"]) is not int or not previous < item["position"] <= 200:
                raise ValueError("INVALID_SERVED_ORDER")
            previous = item["position"]
            served = timestamp(item["served_at"])
            if served < created or (as_of-served).total_seconds() < 300:
                raise ValueError("IMMATURE_REPLAY_FEEDBACK")
            signals = item["signals"]
            if (not isinstance(signals, list) or len(signals) > len(SIGNAL_LABEL)
                    or any(not isinstance(s, str) or s not in SIGNAL_LABEL for s in signals)
                    or len(set(signals)) != len(signals)):
                raise ValueError("INVALID_REPLAY_SIGNALS")
    return slates


def read_slates(path: Path) -> dict:
    with path.open("rb") as stream:
        payload = stream.read(MAX_BYTES+1)
    if len(payload) > MAX_BYTES:
        raise ValueError("REPLAY_FILE_TOO_LARGE")
    dataset = json.loads(payload)
    validate_slates(dataset)
    return dataset


def challenger(ranker: Ranker, slate: dict, policy=ReplayPolicy()) -> tuple[list[dict], str]:
    """Unknown slots stay fixed. The policy consumes no outcome/feedback fields."""
    policy.validate()
    items, user = slate["items"], slate["user_id"]
    if slate["mode"] != "smart":
        return list(items), "explicit_feed_preference"
    if user not in ranker.users:
        return list(items), "unknown_user"
    known = [item for item in items if item["post_id"] in ranker.posts]
    if len(known)/len(items) < policy.minimum_coverage:
        return list(items), "low_coverage"
    if policy.model_blend == 0:
        return list(items), "disabled"
    try:
        scores = ranker.score_many(user, [item["post_id"] for item in known])
        if any(not math.isfinite(v) for v in scores.values()):
            raise ValueError("NON_FINITE_SCORE")
        baseline = {item["post_id"]: 1-i/max(1,len(items)-1) for i,item in enumerate(items)}
        def score(item):
            p = item["post_id"]
            return (1-policy.model_blend)*baseline[p] + policy.model_blend*(scores[p]+1)/2
        remaining = sorted(known, key=lambda item: (-score(item), item["position"]))
        result, recent = [], []
        for original in items:
            if original["post_id"] not in ranker.posts:
                selected = original
            else:
                index = next((i for i,p in enumerate(remaining)
                              if recent.count(p["creator_id"]) < slate["author_cap"]), 0)
                selected = remaining.pop(index)
            result.append(selected)
            recent = (recent + [selected["creator_id"]])[-(policy.window-1):]
        return result, "reranked"
    except (ValueError, FloatingPointError, KeyError):
        return list(items), "scoring_error"


def label(item: dict) -> float | None:
    values = [SIGNAL_LABEL[s] for s in item["signals"]]
    return (min(values) if min(values) < 0 else max(values)) if values else None


def order_metrics(items: list[dict]) -> dict:
    observed = [(p, label(p)) for p in items if p["signals"]]
    rows = [Pair("viewer", p["post_id"], value) for p,value in observed]
    positions = {p["post_id"]: i for i,p in enumerate(items)}
    # No implicit zeros for missing outcomes; require an informative observed set.
    informative = len(rows)>=5 and len({max(0,p.label) for p in rows})>1
    top = items[:10]
    top_observed = [p for p in top if p["signals"]]
    return {
        "ndcg": ndcg(rows, lambda p: -positions[p.post]) if informative else None,
        "observed": len(observed), "items": len(items),
        "top10_observed": len(top_observed), "top10_items": len(top),
        "creator_diversity": len({p["creator_id"] for p in top})/len(top),
        # Count per ten served items, with outcome coverage reported separately.
        "negative_rate": sum(label(p)<0 for p in top_observed)/len(top),
    }


def cluster_interval(values: dict[str, list[float]]) -> dict:
    means = np.array([np.mean(v) for _,v in sorted(values.items())], dtype=float)
    if not len(means):
        return {"users": 0, "mean": None, "ci95_low": None, "ci95_high": None}
    if len(means) < 2:
        return {"users": 1, "mean": float(means.mean()), "ci95_low": None, "ci95_high": None}
    # Resample people, not correlated impressions from the same person.
    rng = np.random.default_rng(43)
    bootstrap = np.array([rng.choice(means, len(means), replace=True).mean() for _ in range(1000)])
    low, high = np.quantile(bootstrap, [0.025,0.975])
    return {"users": len(means), "mean": float(means.mean()), "ci95_low": float(low), "ci95_high": float(high)}


def evaluate_replay(ranker: Ranker, dataset: dict, policy=ReplayPolicy()) -> dict:
    policy.validate()
    slates = validate_slates(dataset)
    if ranker.trained_through is None:
        raise ValueError("MODEL_TRAINING_TIME_REQUIRED")
    trained = timestamp(ranker.trained_through)
    if any(timestamp(s["created_at"]) <= trained for s in slates):
        raise ValueError("TEMPORAL_LEAKAGE_REJECTED")
    groups = defaultdict(lambda: {"deltas": defaultdict(list), "slates": 0,
        "observed": 0, "items": 0, "negative_delta": [], "diversity_delta": [],
        "top10_items": 0, "baseline_top10_observed": 0, "challenger_top10_observed": 0})
    reasons, latencies = Counter(), []
    for slate in slates:
        start = time.perf_counter()
        ordered, reason = challenger(ranker, slate, policy)
        latencies.append((time.perf_counter()-start)*1000)
        reasons[reason] += 1
        if slate["mode"] != "smart":
            continue
        before, after = order_metrics(slate["items"]), order_metrics(ordered)
        group = groups[slate["revision"]+":"+slate["variant"]]
        group["slates"] += 1
        group["observed"] += before["observed"]
        group["items"] += before["items"]
        group["top10_items"] += before["top10_items"]
        group["baseline_top10_observed"] += before["top10_observed"]
        group["challenger_top10_observed"] += after["top10_observed"]
        group["negative_delta"].append(after["negative_rate"]-before["negative_rate"])
        group["diversity_delta"].append(after["creator_diversity"]-before["creator_diversity"])
        if before["ndcg"] is not None:
            group["deltas"][slate["user_id"]].append(after["ndcg"]-before["ndcg"])
    cohorts = []
    for key,g in sorted(groups.items()):
        interval = cluster_interval(g["deltas"])
        coverage = g["observed"]/g["items"]
        before_coverage = g["baseline_top10_observed"]/g["top10_items"]
        after_coverage = g["challenger_top10_observed"]/g["top10_items"]
        negative_delta, diversity_delta = float(np.mean(g["negative_delta"])), float(np.mean(g["diversity_delta"]))
        # Exploratory offline gate only; never unlocks production.
        sufficient = (g["slates"]>=30 and interval["users"]>=20 and coverage>=0.9
                      and min(before_coverage,after_coverage)>=0.9)
        passes = sufficient and interval["ci95_low"]>0 and negative_delta<=0 and diversity_delta>=0
        cohorts.append({"revision_variant": key, "slates": g["slates"], "outcome_coverage": coverage,
            "baseline_top10_outcome_coverage": before_coverage,
            "challenger_top10_outcome_coverage": after_coverage,
            "ndcg_delta": interval, "negative_top10_delta": negative_delta,
            "creator_diversity_delta": diversity_delta, "exploratory_gate": passes})
    genuine = dataset["source"] == ranker.training_source == "lovable_cloud"
    def fingerprint(value):
        return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",", ":"),allow_nan=False).encode()).hexdigest()
    report = {"source": dataset["source"], "baseline": "logged_served_order",
        "policy": asdict(policy), "evaluation_as_of": dataset["as_of"],
        "model_trained_through": ranker.trained_through,
        "model_sha256": fingerprint(ranker.artifact()), "evaluation_sha256": fingerprint(dataset),
        "slates": len(slates), "cohorts": cohorts, "fallbacks": dict(reasons),
        "scoring_p50_ms": float(np.percentile(latencies,50)) if latencies else None,
        "scoring_p95_ms": float(np.percentile(latencies,95)) if latencies else None,
        "latency_scope": "warm_local_reranking_only_not_cloud_or_media",
        "production_baseline_evaluated": genuine and bool(slates),
        "position_bias_corrected": False, "causal_online_gain_proven": False,
        "production_order_changed": False, "promotion_allowed": False}
    passed = genuine and bool(cohorts) and all(g["exploratory_gate"] for g in cohorts) and not reasons["scoring_error"]
    report["status"] = "synthetic_only" if not genuine else "ready_for_review" if passed else "inconclusive_or_regression"
    return report
