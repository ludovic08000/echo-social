"""Offline training, preview and paired replay. No deploy/promote command."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from uuid import uuid4

from .cloud import fetch_dataset, fetch_evaluation
from .data import read_dataset
from .demo import demo_dataset, demo_replay
from .evaluation import evaluate_replay, read_slates
from .model import Config, Ranker, train


def save_run(report: dict, model: dict | None, name: str, root: Path | None = None) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", name):
        raise ValueError("INVALID_RUN_NAME")
    root = root or Path(__file__).resolve().parents[1] / "runs"
    if root.is_symlink():
        raise ValueError("RUN_ROOT_SYMLINK_REJECTED")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = root / name
    destination.mkdir(mode=0o700)  # No overwrite, even when a previous run failed.
    files = [("candidate.json", model)] if model is not None else []
    for filename, value in files + [("report.json", report)]:
        # report.json is the completion marker. Permission flags apply on POSIX.
        descriptor = os.open(destination / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, allow_nan=False, separators=(",", ":"))
    return destination


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="IA de recommandation ForSure — candidat hors production")
    parser.add_argument("command", choices=("demo", "train", "train-cloud", "preview", "evaluate", "evaluate-cloud", "benchmark"))
    parser.add_argument("--input", type=Path, help="Export privé au contrat feed_ai, pour train uniquement")
    parser.add_argument("--name", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid4().hex[:8])
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--dimensions", type=int, default=32)
    parser.add_argument("--limit", type=int, default=5000, help="Maximum 10000 événements cloud")
    parser.add_argument("--model", type=Path, help="Modèle local pour preview, evaluate ou evaluate-cloud")
    parser.add_argument("--user-id", help="UUID du lecteur pour preview")
    parser.add_argument("--posts", nargs="+", help="UUID des publications déjà filtrées, preview uniquement")
    parser.add_argument("--evaluation", type=Path, help="Listes servies et retours observés, pour evaluate")
    args = parser.parse_args(argv)
    try:
        max_name_length = 58 if args.command == "benchmark" else 64
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", args.name)
                or len(args.name) > max_name_length):
            raise ValueError("INVALID_RUN_NAME")
        config = Config(epochs=args.epochs, dimensions=args.dimensions)
        config.validate()
        if (args.command == "train") != (args.input is not None):
            raise ValueError("INPUT_REQUIRED_ONLY_FOR_TRAIN")
        if (args.command == "evaluate") != (args.evaluation is not None):
            raise ValueError("EVALUATION_FILE_REQUIRED_ONLY_FOR_EVALUATE")
        if args.command in ("evaluate", "evaluate-cloud", "benchmark"):
            if args.user_id or args.posts or (args.command == "benchmark" and args.model):
                raise ValueError("INVALID_EVALUATION_ARGUMENTS")
            if args.command == "benchmark":
                training, artifact = train(demo_dataset(200), config)
                destination = save_run(training, artifact, args.name+"-model")
                ranker = Ranker.load(destination / "candidate.json")
                replay = demo_replay()
            else:
                if not args.model:
                    raise ValueError("EVALUATION_MODEL_REQUIRED")
                ranker = Ranker.load(args.model)
                replay = read_slates(args.evaluation) if args.command == "evaluate" else fetch_evaluation(
                    os.environ.get("LOVABLE_CLOUD_API_URL", ""), os.environ.get("LOVABLE_CLOUD_SERVICE_ROLE_KEY", ""))
            report = evaluate_replay(ranker, replay)
            destination = save_run(report, None, args.name)
            print(json.dumps({"output": str(destination), **report}))
            return 0
        if args.command == "preview":
            if not args.model or not args.user_id or not args.posts:
                raise ValueError("PREVIEW_ARGUMENTS_REQUIRED")
            model = Ranker.load(args.model)
            print(json.dumps({"offline_preview": model.rank(args.user_id, args.posts),
                              "production_order_changed": False}))
            return 0
        if args.model or args.user_id or args.posts:
            raise ValueError("PREVIEW_ARGUMENTS_NOT_ALLOWED")
        if args.command == "train-cloud":
            dataset = fetch_dataset(os.environ.get("LOVABLE_CLOUD_API_URL", ""),
                                    os.environ.get("LOVABLE_CLOUD_SERVICE_ROLE_KEY", ""), args.limit)
        elif args.command == "train":
            dataset = read_dataset(args.input)
        else:
            dataset = demo_dataset()
        report, artifact = train(dataset, config)
        destination = save_run(report, artifact, args.name)
        # Only aggregate metrics and a local path are printed, no user IDs or vectors.
        print(json.dumps({"output": str(destination), "status": report["status"],
            "train_pairs": report["train_pairs"], "holdout_pairs": report["holdout_pairs"],
            "ndcg_at_10": report["ndcg_at_10"], "baseline_ndcg_at_10": report["baseline_ndcg_at_10"],
            "promotion_allowed": False}))
        return 0
    except (ValueError, TypeError, KeyError, AttributeError, OSError, TimeoutError) as error:
        # Parser/OS exceptions may contain input data or paths: only print our safe codes.
        message = str(error)
        code = message if re.fullmatch(r"[A-Z][A-Z0-9_]{2,80}", message) else type(error).__name__
        print(json.dumps({"error": code, "production_order_changed": False}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
