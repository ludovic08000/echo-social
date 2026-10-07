"""Small explicit-feedback matrix factorization, trained from scratch on CPU.

This is a recommender, not a language model, semantic encoder or safety filter.
Evaluation is on observed future pairs, not a counterfactual production A/B test.
"""
from dataclasses import asdict, dataclass
import math
import json
from pathlib import Path
import platform
import time
from uuid import UUID
import numpy as np

from .data import Pair, SIGNAL_LABEL, digest_dataset, temporal_split, timestamp, validate_dataset


@dataclass(frozen=True)
class Config:
    dimensions: int = 32
    epochs: int = 20
    learning_rate: float = 0.03
    regularization: float = 0.02
    seed: int = 43
    max_seconds: float = 60.0

    def validate(self):
        if type(self.dimensions) is not int or not 4 <= self.dimensions <= 128:
            raise ValueError("DIMENSION_LIMIT")
        if type(self.epochs) is not int or not 1 <= self.epochs <= 50:
            raise ValueError("EPOCH_LIMIT")
        if not math.isfinite(self.learning_rate) or not 0 < self.learning_rate <= 0.1:
            raise ValueError("LEARNING_RATE_LIMIT")
        if not math.isfinite(self.regularization) or not 0 <= self.regularization <= 1:
            raise ValueError("REGULARIZATION_LIMIT")
        if not math.isfinite(self.max_seconds) or not 0 < self.max_seconds <= 120:
            raise ValueError("TIME_LIMIT")
        if type(self.seed) is not int or not 0 <= self.seed < 2**32:
            raise ValueError("SEED_LIMIT")


class Ranker:
    def __init__(self, pairs: list[Pair], config: Config):
        config.validate()
        if not pairs:
            raise ValueError("EMPTY_TRAINING_SET")
        self.config = config
        self.trained_through = None
        self.training_source = None
        self.users = {key: i for i, key in enumerate(sorted({p.user for p in pairs}))}
        self.posts = {key: i for i, key in enumerate(sorted({p.post for p in pairs}))}
        self.rng = np.random.default_rng(config.seed)
        self.u = self.rng.normal(0, 0.1, (len(self.users), config.dimensions)).astype(np.float32)
        self.p = self.rng.normal(0, 0.1, (len(self.posts), config.dimensions)).astype(np.float32)
        self.ub = np.zeros(len(self.users), dtype=np.float32)
        self.pb = np.zeros(len(self.posts), dtype=np.float32)
        self.mean = float(np.mean([p.label for p in pairs]))
        totals: dict[str, list[float]] = {}
        for pair in pairs:
            totals.setdefault(pair.post, []).append(pair.label)
        # Smoothed item affinity baseline, computed exclusively on training rows.
        self.popularity = {post: (sum(values) + 5 * self.mean) / (len(values) + 5)
                           for post, values in totals.items()}

    def known(self, pair: Pair) -> bool:
        return pair.user in self.users and pair.post in self.posts

    def baseline(self, pair: Pair) -> float:
        return self.popularity.get(pair.post, self.mean)

    def score(self, pair: Pair) -> float:
        if not self.known(pair):
            return self.baseline(pair)
        u, p = self.users[pair.user], self.posts[pair.post]
        return float(np.clip(self.mean + self.ub[u] + self.pb[p] + np.dot(self.u[u], self.p[p]), -1, 1))

    def fit(self, pairs: list[Pair], clock=time.monotonic) -> list[float]:
        started, losses = clock(), []
        lr, reg = self.config.learning_rate, self.config.regularization
        for _ in range(self.config.epochs):
            for index in self.rng.permutation(len(pairs)):
                if clock() - started >= self.config.max_seconds:
                    raise TimeoutError("TRAINING_TIME_BUDGET_EXCEEDED")
                row = pairs[index]
                u, p = self.users[row.user], self.posts[row.post]
                uv, pv = self.u[u].copy(), self.p[p].copy()
                error = float(self.mean + self.ub[u] + self.pb[p] + np.dot(uv, pv) - row.label)
                error = float(np.clip(error, -2, 2))
                self.u[u] -= lr * (error * pv + reg * uv)
                self.p[p] -= lr * (error * uv + reg * pv)
                self.ub[u] -= lr * (error + reg * self.ub[u])
                self.pb[p] -= lr * (error + reg * self.pb[p])
            losses.append(float(np.mean([(self.score(p) - p.label)**2 for p in pairs])))
        if not all(np.isfinite(a).all() for a in (self.u, self.p, self.ub, self.pb)):
            raise ValueError("NON_FINITE_MODEL")
        return losses

    def artifact(self) -> dict:
        # JSON, not pickle: no executable object deserialization.
        return {"kind": "forsure_feed_factorization", "schema": 1, "global_mean": self.mean,
            "dimensions": self.config.dimensions, "users": list(self.users), "posts": list(self.posts),
            "user_factors": self.u.tolist(), "post_factors": self.p.tolist(),
            "user_bias": self.ub.tolist(), "post_bias": self.pb.tolist(),
            "popularity": self.popularity, "trained_through": self.trained_through,
            "training_source": self.training_source, "promotion_allowed": False}

    @classmethod
    def load(cls, path: Path):
        with path.open("rb") as stream:
            raw = stream.read(64 * 1024 * 1024 + 1)
        if len(raw) > 64 * 1024 * 1024:
            raise ValueError("MODEL_FILE_TOO_LARGE")
        artifact = json.loads(raw)
        if (not isinstance(artifact, dict) or artifact.get("kind") != "forsure_feed_factorization"
                or artifact.get("schema") != 1 or artifact.get("promotion_allowed") is not False):
            raise ValueError("INVALID_MODEL_CONTRACT")
        config = Config(dimensions=artifact["dimensions"])
        config.validate()
        # Validate sizes before materializing numeric arrays. No pickle or code execution.
        model = cls.__new__(cls)
        model.config, model.rng = config, np.random.default_rng(config.seed)
        model.trained_through = artifact.get("trained_through")
        model.training_source = artifact.get("training_source")
        if model.trained_through is not None:
            timestamp(model.trained_through)
        if model.training_source not in (None, "synthetic", "lovable_cloud"):
            raise ValueError("INVALID_MODEL_SOURCE")
        for name in ("users", "posts"):
            ids = artifact[name]
            if not isinstance(ids, list) or not 1 <= len(ids) <= 10_000:
                raise ValueError("MODEL_ENTITY_LIMIT")
            canonical = [str(UUID(value)) for value in ids]
            if len(set(canonical)) != len(ids) or ids != canonical:
                raise ValueError("INVALID_MODEL_IDS")
            setattr(model, name, {value: i for i, value in enumerate(ids)})
        for field, attribute, count, matrix in (
            ("user_factors", "u", len(model.users), True),
            ("post_factors", "p", len(model.posts), True),
            ("user_bias", "ub", len(model.users), False),
            ("post_bias", "pb", len(model.posts), False),
        ):
            values = artifact[field]
            if not isinstance(values, list) or len(values) != count:
                raise ValueError("INVALID_MODEL_SHAPE")
            if matrix and any(not isinstance(v, list) or len(v) != config.dimensions for v in values):
                raise ValueError("INVALID_MODEL_SHAPE")
            array = np.asarray(values, dtype=np.float32)
            expected = (count, config.dimensions) if matrix else (count,)
            if array.shape != expected or not np.isfinite(array).all() or (np.abs(array) > 10).any():
                raise ValueError("INVALID_MODEL_VALUES")
            setattr(model, attribute, array)
        model.mean = float(artifact["global_mean"])
        model.popularity = {k: float(v) for k, v in artifact["popularity"].items()}
        if (not math.isfinite(model.mean) or abs(model.mean) > 1 or set(model.popularity) != set(model.posts)
                or any(not math.isfinite(v) or abs(v) > 1 for v in model.popularity.values())):
            raise ValueError("INVALID_MODEL_BASELINE")
        return model

    def rank(self, user_id: str, candidate_ids: list[str]) -> list[dict]:
        # Candidate visibility/blocks/moderation must be enforced upstream. Offline preview only.
        user_id = str(UUID(user_id))
        if len(candidate_ids) > 200:
            raise ValueError("CANDIDATE_LIMIT")
        ids = list(dict.fromkeys(str(UUID(p)) for p in candidate_ids))
        scores = [{"post_id": p, "score": self.score(Pair(user_id, p, 0)),
                   "fallback": user_id not in self.users or p not in self.posts} for p in ids]
        return sorted(scores, key=lambda row: (-row["score"], row["post_id"]))

    def score_many(self, user_id: str, post_ids: list[str]) -> dict[str, float]:
        """Vectorized bounded inference for the offline challenger; no network."""
        if len(post_ids) > 200:
            raise ValueError("CANDIDATE_LIMIT")
        result = {p: self.popularity.get(p, self.mean) for p in post_ids}
        known = [p for p in post_ids if p in self.posts]
        if user_id in self.users and known:
            indices = np.array([self.posts[p] for p in known], dtype=np.int32)
            u = self.users[user_id]
            scores = np.clip(self.mean + self.ub[u] + self.pb[indices] + self.p[indices] @ self.u[u], -1, 1)
            result.update(zip(known, map(float, scores)))
        return result


def ndcg(rows: list[Pair], scorer, k=10) -> float | None:
    # Equal scores keep a stable, label-independent post-ID order.
    ordered = sorted(rows, key=lambda p: (-scorer(p), p.post))[:k]
    ideal = sorted(rows, key=lambda p: (-max(0, p.label), p.post))[:k]
    def dcg(values):
        return sum((2**max(0, p.label) - 1) / math.log2(i + 2) for i, p in enumerate(values))
    denominator = dcg(ideal)
    return dcg(ordered) / denominator if denominator else None


def evaluate(ranker: Ranker, rows: list[Pair]) -> dict:
    known = [p for p in rows if ranker.known(p)]
    groups: dict[str, list[Pair]] = {}
    for p in rows:
        groups.setdefault(p.user, []).append(p)
    # Single-candidate/constant-label slates offer no ranking evidence.
    groups = {u: items for u, items in groups.items()
              if len(items) >= 5 and len({max(0, p.label) for p in items}) > 1}
    ranked = [(ndcg(items, ranker.score), ndcg(items, ranker.baseline)) for items in groups.values()]
    ranked = [(a, b) for a, b in ranked if a is not None and b is not None]
    return {"holdout_pairs": len(rows), "known_pairs": len(known),
        "holdout_coverage": len(known) / len(rows) if rows else 0.0,
        "cold_start_pairs": len(rows) - len(known), "ranking_users": len(ranked),
        "validation_mse": float(np.mean([(ranker.score(p)-p.label)**2 for p in rows])) if rows else None,
        "baseline_mse": float(np.mean([(ranker.baseline(p)-p.label)**2 for p in rows])) if rows else None,
        "ndcg_at_10": float(np.mean([a for a, _ in ranked])) if ranked else None,
        "baseline_ndcg_at_10": float(np.mean([b for _, b in ranked])) if ranked else None,
        "ranking_basis": "observed_future_pairs_not_full_served_slates"}


def train(dataset: dict, config=Config()) -> tuple[dict, dict]:
    config.validate()
    events = validate_dataset(dataset)
    train_rows, holdout, split = temporal_split(events)
    ranker = Ranker(train_rows, config)
    ranker.trained_through = max(e.at for e in events if e.at < timestamp(split["cutoff"])).isoformat()
    ranker.training_source = dataset["source"]
    initial_loss = float(np.mean([(ranker.score(p)-p.label)**2 for p in train_rows]))
    losses = ranker.fit(train_rows)
    metrics = evaluate(ranker, holdout)
    enough = metrics["holdout_pairs"] >= 100 and metrics["ranking_users"] >= 20 and metrics["holdout_coverage"] >= 0.9
    improves = enough and metrics["validation_mse"] <= metrics["baseline_mse"] and metrics["ndcg_at_10"] > metrics["baseline_ndcg_at_10"]
    status = "synthetic_only" if dataset["source"] == "synthetic" else (
        "insufficient_data" if not enough else "offline_candidate" if improves else "rejected")
    report = {"status": status, "source": dataset["source"], "dataset_sha256": digest_dataset(dataset),
        "runtime": {"python": platform.python_version(), "numpy": np.__version__},
        "config": asdict(config), "training_labels": SIGNAL_LABEL,
        "split": split, "train_pairs": len(train_rows), "train_loss_initial": initial_loss,
        "train_loss_by_epoch": losses, **metrics,
        "production_baseline_evaluated": False, "production_order_changed": False,
        "promotion_allowed": False}
    artifact = {**ranker.artifact(), "dataset_sha256": report["dataset_sha256"], "status": status}
    return report, artifact
