import copy
from datetime import datetime, timedelta
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import UUID

from ml.feed_ai.__main__ import main
from ml.feed_ai.cloud import fetch_evaluation
from ml.feed_ai.data import aggregate, parse_events, timestamp
from ml.feed_ai.demo import demo_dataset, demo_replay
from ml.feed_ai.evaluation import (ReplayPolicy, challenger, cluster_interval, evaluate_replay,
                                   order_metrics, validate_slates)
from ml.feed_ai.model import Config, Pair, Ranker, train


class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dataset = demo_replay()
        pairs = aggregate(parse_events(demo_dataset(200)["events"]))
        cls.model = Ranker(pairs, Config(epochs=1))
        cls.model.trained_through = "2026-01-01T03:00:00+00:00"
        cls.model.training_source = "synthetic"

    def test_valid_synthetic_contract(self):
        self.assertEqual(len(validate_slates(self.dataset)),40)

    def test_duplicate_post_slate_order_and_private_fields_rejected(self):
        for mutation in ("post", "slate", "order", "private"):
            dataset = copy.deepcopy(self.dataset)
            items = dataset["slates"][0]["items"]
            if mutation == "post": items[1]["post_id"] = items[0]["post_id"]
            if mutation == "slate": dataset["slates"][1]["slate_id"] = dataset["slates"][0]["slate_id"]
            if mutation == "order": items[1]["position"] = items[0]["position"]
            if mutation == "private": items[0]["body"] = "private"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_slates(dataset)

    def test_feedback_must_be_mature(self):
        dataset = copy.deepcopy(self.dataset)
        dataset["as_of"] = "2026-01-02T00:04:00+00:00"
        with self.assertRaisesRegex(ValueError,"IMMATURE"):
            validate_slates(dataset)

    def test_future_trained_model_rejected(self):
        with patch.object(self.model,"trained_through",self.dataset["slates"][0]["created_at"]):
            with self.assertRaisesRegex(ValueError,"TEMPORAL_LEAKAGE"):
                evaluate_replay(self.model,self.dataset)

    def test_legacy_model_cannot_claim_temporal_validation(self):
        with patch.object(self.model,"trained_through",None):
            with self.assertRaisesRegex(ValueError,"TRAINING_TIME_REQUIRED"):
                evaluate_replay(self.model,self.dataset)

    def test_challenger_never_reads_outcomes(self):
        slate = copy.deepcopy(self.dataset["slates"][0])
        first,_ = challenger(self.model,slate)
        for item in slate["items"]:
            item["signals"] = ["report"]
        second,_ = challenger(self.model,slate)
        self.assertEqual([p["post_id"] for p in first],[p["post_id"] for p in second])

    def test_disable_and_explicit_preference_preserve_baseline(self):
        slate = copy.deepcopy(self.dataset["slates"][0])
        self.assertEqual(challenger(self.model,slate,ReplayPolicy(model_blend=0))[0],slate["items"])
        slate["mode"] = "chronological"
        self.assertEqual(challenger(self.model,slate)[0],slate["items"])

    def test_unknown_user_and_low_coverage_preserve_baseline(self):
        slate = copy.deepcopy(self.dataset["slates"][0])
        slate["user_id"] = str(UUID(int=99))
        self.assertEqual(challenger(self.model,slate)[1],"unknown_user")
        slate["user_id"] = self.dataset["slates"][0]["user_id"]
        for i,p in enumerate(slate["items"][:30]): p["post_id"] = str(UUID(int=i+1))
        self.assertEqual(challenger(self.model,slate)[1],"low_coverage")

    def test_unknown_post_stays_in_same_slot_and_nothing_is_lost(self):
        slate = copy.deepcopy(self.dataset["slates"][0])
        slate["items"][2]["post_id"] = str(UUID(int=99))
        result,_ = challenger(self.model,slate)
        self.assertEqual(result[2],slate["items"][2])
        self.assertCountEqual([p["post_id"] for p in result],[p["post_id"] for p in slate["items"]])

    def test_scorer_failure_falls_back_without_faking_success(self):
        with patch.object(self.model,"score_many",side_effect=ValueError("failure")):
            result, reason = challenger(self.model,self.dataset["slates"][0])
            self.assertEqual(result,self.dataset["slates"][0]["items"])
            self.assertEqual(reason,"scoring_error")

    def test_creator_window_is_bounded_when_alternatives_exist(self):
        result,_ = challenger(self.model,self.dataset["slates"][0])
        for i,item in enumerate(result[:100]):
            self.assertLessEqual(sum(p["creator_id"]==item["creator_id"] for p in result[max(0,i-11):i+1]),2)

    def test_creator_shortage_does_not_drop_posts(self):
        slate = copy.deepcopy(self.dataset["slates"][0])
        for item in slate["items"]: item["creator_id"] = str(UUID(int=1))
        result,_ = challenger(self.model,slate)
        self.assertEqual(len(result),len(slate["items"]))

    def test_unviewed_is_not_labeled_negative(self):
        items = copy.deepcopy(self.dataset["slates"][0]["items"])
        for item in items: item["signals"] = []
        metrics = order_metrics(items)
        self.assertIsNone(metrics["ndcg"])
        self.assertEqual(metrics["negative_rate"],0)
        self.assertEqual(metrics["observed"],0)
        self.assertEqual(metrics["top10_observed"],0)

    def test_bootstrap_clusters_by_user_not_impression(self):
        report = cluster_interval({"a": [1]*100, "b": [-1]})
        self.assertEqual(report["users"],2)
        self.assertEqual(report["mean"],0)
        self.assertIsNone(cluster_interval({"a":[1]})["ci95_low"])

    def test_revisions_are_never_pooled(self):
        dataset = copy.deepcopy(self.dataset)
        dataset["slates"][0]["revision"] = "b"*32
        report = evaluate_replay(self.model,dataset)
        self.assertEqual(len(report["cohorts"]),2)
        self.assertFalse(report["promotion_allowed"])
        self.assertFalse(report["causal_online_gain_proven"])

    def test_synthetic_never_claims_production_validation(self):
        report = evaluate_replay(self.model,self.dataset)
        self.assertEqual(report["status"],"synthetic_only")
        self.assertFalse(report["production_baseline_evaluated"])
        self.assertNotIn(self.dataset["slates"][0]["user_id"],json.dumps(report))

    def test_empty_real_data_is_inconclusive(self):
        dataset = {**self.dataset,"source":"lovable_cloud","slates":[]}
        with patch.object(self.model,"training_source","lovable_cloud"):
            report = evaluate_replay(self.model,dataset)
        self.assertEqual(report["status"],"inconclusive_or_regression")
        self.assertFalse(report["production_baseline_evaluated"])

    def test_vectorized_scores_match_scalar_model(self):
        slate = self.dataset["slates"][0]
        scores = self.model.score_many(slate["user_id"],[p["post_id"] for p in slate["items"]])
        for p in slate["items"]:
            self.assertAlmostEqual(scores[p["post_id"]],self.model.score(Pair(slate["user_id"],p["post_id"],0)),places=6)

    def test_replay_policy_bounds(self):
        for policy in (ReplayPolicy(model_blend=float("nan")),ReplayPolicy(model_blend=1),ReplayPolicy(minimum_coverage=0),ReplayPolicy(window=100)):
            with self.subTest(policy=policy),self.assertRaises(ValueError): policy.validate()

    def test_cloud_readonly_adapter_validates_contract(self):
        class Opener:
            def open(inner,req,timeout):
                self.assertEqual(req.method,"GET")
                self.assertIn("/rpc/feed_evaluation_slates?",req.full_url)
                self.assertLessEqual(timeout,15)
                return io.BytesIO(json.dumps({**self.dataset,"source":"lovable_cloud"}).encode())
        self.assertEqual(fetch_evaluation("https://example.test","secret",opener=Opener())["source"],"lovable_cloud")

    def test_cli_evaluate_only_saves_aggregate_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/"model.json").write_text(json.dumps(self.model.artifact()),encoding="utf-8")
            (root/"slates.json").write_text(json.dumps(self.dataset),encoding="utf-8")
            with patch("ml.feed_ai.__main__.save_run",return_value=root) as save,patch("sys.stdout",new_callable=io.StringIO):
                self.assertEqual(main(["evaluate","--model",str(root/"model.json"),"--evaluation",str(root/"slates.json")]),0)
                self.assertIsNone(save.call_args.args[1])

    def test_benchmark_rejects_invalid_output_before_training(self):
        for name in ("../outside", "a"*59):
            with self.subTest(name=name), patch("ml.feed_ai.__main__.train") as fit:
                with patch("sys.stderr",new_callable=io.StringIO):
                    self.assertEqual(main(["benchmark","--name",name]),1)
                fit.assert_not_called()

    def test_diversity_regression_blocks_review_even_with_relevance_gain(self):
        # Deterministic paired metrics isolate the guardrail from model quality.
        dataset = {**self.dataset,"source":"lovable_cloud"}
        before = {"ndcg":0.2,"observed":200,"items":200,"negative_rate":0.4,"creator_diversity":0.9,
                  "top10_items":10,"top10_observed":10}
        after = {**before,"ndcg":0.8,"negative_rate":0.1,"creator_diversity":0.7}
        with patch.object(self.model,"training_source","lovable_cloud"):
            with patch("ml.feed_ai.evaluation.order_metrics",side_effect=[before,after]*40):
                report = evaluate_replay(self.model,dataset)
        self.assertGreater(report["cohorts"][0]["ndcg_delta"]["ci95_low"],0)
        self.assertFalse(report["cohorts"][0]["exploratory_gate"])
        self.assertEqual(report["status"],"inconclusive_or_regression")
        self.assertFalse(report["promotion_allowed"])

    def test_missing_top_outcomes_cannot_fake_negative_feedback_improvement(self):
        dataset = {**self.dataset,"source":"lovable_cloud"}
        before = {"ndcg":0.2,"observed":190,"items":200,"negative_rate":0.4,"creator_diversity":0.8,
                  "top10_items":10,"top10_observed":10}
        after = {**before,"ndcg":0.8,"negative_rate":0,"top10_observed":0}
        with patch.object(self.model,"training_source","lovable_cloud"):
            with patch("ml.feed_ai.evaluation.order_metrics",side_effect=[before,after]*40):
                report = evaluate_replay(self.model,dataset)
        self.assertEqual(report["cohorts"][0]["outcome_coverage"],0.95)
        self.assertEqual(report["cohorts"][0]["challenger_top10_outcome_coverage"],0)
        self.assertFalse(report["cohorts"][0]["exploratory_gate"])

    def test_report_fingerprints_data_model_and_records_policy(self):
        first = evaluate_replay(self.model,self.dataset)
        changed = copy.deepcopy(self.dataset)
        changed["slates"][0]["items"][0]["signals"] = []
        second = evaluate_replay(self.model,changed)
        self.assertEqual(first["model_sha256"],second["model_sha256"])
        self.assertNotEqual(first["evaluation_sha256"],second["evaluation_sha256"])
        self.assertEqual(first["policy"]["model_blend"],0.25)


if __name__ == "__main__":
    unittest.main()
