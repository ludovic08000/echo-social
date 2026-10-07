import copy
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from ml.feed_ai.__main__ import main, save_run
from ml.feed_ai.cloud import NoRedirect, fetch_dataset
from ml.feed_ai.data import (MAX_EVENTS, Pair, SIGNAL_LABEL, aggregate, digest_dataset,
                             parse_events, read_dataset, temporal_split, validate_dataset)
from ml.feed_ai.demo import demo_dataset
from ml.feed_ai.model import Config, Ranker, evaluate, ndcg, train
import numpy as np


def event(i, user=1, post=1, signal="view", seconds=0):
    return {"id": str(UUID(int=i)), "user_id": str(UUID(int=user)), "post_id": str(UUID(int=post)),
            "signal_type": signal, "created_at": (datetime(2026, 1, 1, tzinfo=timezone.utc)
                                                    + timedelta(seconds=seconds)).isoformat()}


class DataTests(unittest.TestCase):
    def test_unknown_fields_never_accept_message_body_or_secrets(self):
        for field in ("body", "email", "master_key", "weight"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "UNEXPECTED_EVENT_FIELDS"):
                parse_events([{**event(1), field: "private"}])

    def test_malformed_id_signal_and_timezone_rejected(self):
        for field, value in (("id", "bad"), ("user_id", 1), ("signal_type", "purchase"),
                             ("created_at", "2026-01-01T00:00:00")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                parse_events([{**event(1), field: value}])

    def test_duplicate_events_rejected(self):
        with self.assertRaisesRegex(ValueError, "DUPLICATE_EVENT_ID"):
            parse_events([event(1), event(1)])

    def test_event_limit_checked_before_materialization(self):
        with self.assertRaisesRegex(ValueError, "EVENT_LIMIT"):
            parse_events([{}] * (MAX_EVENTS + 1))

    def test_negative_feedback_cannot_be_diluted_by_views(self):
        rows = [event(i, signal="view") for i in range(1, 100)] + [event(100, signal="hide")]
        self.assertEqual(aggregate(parse_events(rows))[0].label, -0.8)

    def test_timestamp_split_never_trains_on_future_feedback(self):
        rows = [event(i, post=i, seconds=i) for i in range(1, 11)]
        rows[-1] = event(10, post=1, signal="report", seconds=10)
        before, after, stats = temporal_split(parse_events(rows))
        self.assertEqual(stats["repeat_pairs_excluded"], 1)
        self.assertEqual(before[0].label, 0.1)
        self.assertFalse({(p.user, p.post) for p in before} & {(p.user, p.post) for p in after})

    def test_same_timestamp_is_not_randomly_split(self):
        with self.assertRaisesRegex(ValueError, "INSUFFICIENT_TEMPORAL"):
            temporal_split(parse_events([event(i, post=i) for i in range(1, 10)]))

    def test_digest_is_independent_of_input_order(self):
        dataset = demo_dataset()
        reverse = {**dataset, "events": list(reversed(dataset["events"]))}
        self.assertEqual(digest_dataset(dataset), digest_dataset(reverse))

    def test_export_window_and_source_validated(self):
        dataset = {"schema": 1, "source": "synthetic", "as_of": "2026-01-01T00:00:00Z", "events": [event(1)]}
        for changed in ({"as_of": "2025-12-31T23:00:00Z"}, {"as_of": "2026-02-01T00:00:00Z"}, {"source": "browser"}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate_dataset({**dataset, **changed})

    def test_bounded_input_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dataset.json"
            path.write_text(json.dumps(demo_dataset()), encoding="utf-8")
            self.assertEqual(read_dataset(path)["source"], "synthetic")
            with patch("ml.feed_ai.data.MAX_BYTES", 100), self.assertRaisesRegex(ValueError, "TOO_LARGE"):
                read_dataset(path)

    def test_signal_contract_matches_existing_backend(self):
        source = (Path(__file__).resolve().parents[2] / "supabase/functions/_shared/feed-training-policy.ts").read_text(encoding="utf-8")
        values = dict((name, float(value)) for name, value in re.findall(r"(\w+):\s*(-?\d+(?:\.\d+)?)", source.split("});", 1)[0]))
        self.assertEqual(SIGNAL_LABEL, values)


class LearningTests(unittest.TestCase):
    def test_reload_preserves_scores_and_preview_is_bounded(self):
        pairs = aggregate(parse_events([event(i, user=i % 2 + 1, post=i) for i in range(1, 12)]))
        model = Ranker(pairs, Config(epochs=2))
        model.fit(pairs)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.json"
            path.write_text(json.dumps(model.artifact()), encoding="utf-8")
            restored = Ranker.load(path)
            self.assertEqual([restored.score(p) for p in pairs], [model.score(p) for p in pairs])
            user, post = pairs[0].user, pairs[0].post
            self.assertEqual(len(restored.rank(user, [post, post])), 1)
            with self.assertRaisesRegex(ValueError, "CANDIDATE_LIMIT"):
                restored.rank(user, [post] * 201)
            with patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(main(["preview", "--model", str(path), "--user-id", user, "--posts", post]), 0)
                self.assertFalse(json.loads(output.getvalue())["production_order_changed"])

    def test_malformed_model_does_not_reach_inference(self):
        model = Ranker(aggregate(parse_events([event(1)])), Config())
        artifact = model.artifact()
        for changed in ({"promotion_allowed": True}, {"dimensions": 100000}, {"user_factors": [[]]},
                        {"global_mean": float("nan")}, {"users": ["not-a-uuid"]}):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "candidate.json"
                path.write_text(json.dumps({**artifact, **changed}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    Ranker.load(path)

    def test_deterministic_actual_learning_and_serialization(self):
        pairs = [Pair(str(u), str(p), 0.8 if u % 2 == p % 2 else -0.4)
                 for u in range(12) for p in range(16)]
        first, second = Ranker(pairs, Config(epochs=8)), Ranker(pairs, Config(epochs=8))
        initial = np.mean([(first.score(p)-p.label)**2 for p in pairs])
        losses = first.fit(pairs)
        second.fit(pairs)
        self.assertLess(losses[-1], initial)
        self.assertEqual(first.artifact(), second.artifact())
        self.assertFalse(json.loads(json.dumps(first.artifact(), allow_nan=False))["promotion_allowed"])

    def test_all_negative_rows_remain_finite(self):
        pairs = [Pair("u", str(p), -1) for p in range(8)]
        model = Ranker(pairs, Config(epochs=2))
        self.assertTrue(all(np.isfinite(model.fit(pairs))))
        self.assertTrue(all(-1 <= model.score(p) <= 1 for p in pairs))

    def test_unseen_users_and_posts_fall_back(self):
        model = Ranker([Pair("u", "p", 0.8)], Config(epochs=1))
        for pair in (Pair("unknown", "p", 0), Pair("u", "unknown", 0)):
            self.assertEqual(model.score(pair), model.baseline(pair))

    def test_cold_start_stays_in_evaluation_denominator(self):
        model = Ranker([Pair("u", "p", 1)], Config())
        metrics = evaluate(model, [Pair("u", "p", 1), Pair("other", "other", -1)])
        self.assertEqual(metrics["holdout_coverage"], 0.5)
        self.assertEqual(metrics["cold_start_pairs"], 1)
        self.assertEqual(metrics["ranking_users"], 0)

    def test_ndcg_and_zero_relevance(self):
        rows = [Pair("u", "a", 1), Pair("u", "b", 0)]
        self.assertEqual(ndcg(rows, lambda p: p.label), 1)
        self.assertLess(ndcg(rows, lambda p: -p.label), 1)
        self.assertIsNone(ndcg([Pair("u", "a", -1)], lambda p: 0))

    def test_resource_bounds_and_nan_rejected(self):
        for config in (Config(dimensions=129), Config(epochs=51), Config(learning_rate=float("nan")),
                       Config(max_seconds=float("inf")), Config(regularization=-1), Config(seed=-1)):
            with self.subTest(config=config), self.assertRaises(ValueError):
                config.validate()

    def test_time_budget_aborts_without_partial_model(self):
        rows = [Pair("u", "p", 1)]
        model = Ranker(rows, Config(max_seconds=1))
        with self.assertRaisesRegex(TimeoutError, "TIME_BUDGET"):
            model.fit(rows, clock=iter([0, 2]).__next__)

    def test_synthetic_demo_never_qualifies_for_promotion(self):
        dataset = demo_dataset()
        report, model = train(dataset, Config(epochs=2))
        self.assertEqual(report["status"], "synthetic_only")
        self.assertFalse(report["production_baseline_evaluated"])
        self.assertFalse(model["promotion_allowed"])
        self.assertNotIn(dataset["events"][0]["user_id"], json.dumps(report))

    def test_small_real_dataset_is_not_claimed_validated(self):
        dataset = demo_dataset()
        dataset["events"] = dataset["events"][:40]
        dataset["source"] = "lovable_cloud"
        report, _ = train(dataset, Config(epochs=1))
        self.assertEqual(report["status"], "insufficient_data")
        self.assertFalse(report["production_order_changed"])


class FakeResponse(io.BytesIO):
    pass


class FakeOpener:
    def __init__(self, batches):
        self.batches = list(batches)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return FakeResponse(json.dumps(self.batches.pop(0)).encode())


def recent_event(i):
    return {**event(i), "created_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}


class CloudTests(unittest.TestCase):
    def test_paginated_read_only_minimized_contract(self):
        opener = FakeOpener([[recent_event(1)], [recent_event(2)], []])
        dataset = fetch_dataset("https://example.test", "server-secret", opener=opener)
        self.assertEqual(len(dataset["events"]), 2)
        as_of = set()
        for index, request in enumerate(opener.requests):
            self.assertEqual(request.get_method(), "GET")
            parsed = urlsplit(request.full_url)
            self.assertEqual(parsed.path, "/rest/v1/rpc/feed_training_events")
            query = parse_qs(parsed.query)
            self.assertEqual(query["offset"], [str(index)])
            self.assertNotIn("weight", query["select"][0])
            as_of.add(query["p_as_of"][0])
        self.assertEqual(len(as_of), 1)

    def test_https_origin_and_credential_required(self):
        for url in ("http://example.test", "https://a:b@example.test", "https://example.test/path", "https://example.test?x=1"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                fetch_dataset(url, "secret")
        with self.assertRaises(ValueError):
            fetch_dataset("https://example.test", "")

    def test_redirect_rejected_before_forwarding_credentials(self):
        with self.assertRaisesRegex(ValueError, "REDIRECT_REJECTED"):
            NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.test")

    def test_duplicate_page_rejected(self):
        row = recent_event(1)
        with self.assertRaisesRegex(ValueError, "PAGINATION_UNSTABLE"):
            fetch_dataset("https://example.test", "secret", opener=FakeOpener([[row], [row]]))

    def test_server_errors_do_not_leak_response(self):
        opener = FakeOpener([])
        with patch.object(opener, "open", side_effect=HTTPError("https://example.test", 403, "private body", {}, None)):
            with self.assertRaisesRegex(ValueError, "^CLOUD_RPC_HTTP_403$"):
                fetch_dataset("https://example.test", "secret", opener=opener)
        with patch.object(opener, "open", side_effect=URLError("secret request")):
            with self.assertRaisesRegex(ValueError, "^CLOUD_RPC_UNAVAILABLE$"):
                fetch_dataset("https://example.test", "secret", opener=opener)

    def test_cloud_deadline(self):
        with self.assertRaisesRegex(TimeoutError, "CLOUD_READ_BUDGET"):
            fetch_dataset("https://example.test", "secret", opener=FakeOpener([]), clock=iter([0, 91]).__next__)

    def test_cloud_rejects_extra_private_fields(self):
        with self.assertRaisesRegex(ValueError, "CONTRACT_INVALID"):
            fetch_dataset("https://example.test", "secret", opener=FakeOpener([[{**recent_event(1), "body": "private"}]]))


class CommandTests(unittest.TestCase):
    def test_private_outputs_no_overwrite_or_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = save_run({"status": "test"}, {"promotion_allowed": False}, "trial", root)
            self.assertTrue((saved / "report.json").exists())
            self.assertFalse(json.loads((saved / "candidate.json").read_text())["promotion_allowed"])
            with self.assertRaises(FileExistsError):
                save_run({}, {}, "trial", root)
            for name in ("../outside", "C:\\outside", "a/b"):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    save_run({}, {}, name, root)

    def test_cli_failures_never_publish_or_print_secrets(self):
        with patch.dict("os.environ", {}, clear=True), patch("sys.stderr", new_callable=io.StringIO) as output:
            self.assertEqual(main(["train-cloud"]), 1)
            self.assertFalse(json.loads(output.getvalue())["production_order_changed"])

    def test_training_failure_does_not_save_artifacts(self):
        with patch("ml.feed_ai.__main__.train", side_effect=TimeoutError("TRAINING_TIME_BUDGET_EXCEEDED")), \
             patch("ml.feed_ai.__main__.save_run") as save, patch("sys.stderr", new_callable=io.StringIO):
            self.assertEqual(main(["demo"]), 1)
            save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
