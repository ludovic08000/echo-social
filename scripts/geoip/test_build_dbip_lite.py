import hashlib
import io
import json
from contextlib import nullcontext, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch
from build_dbip_lite import build, encoded, LANGUAGES, main, place_from_record


def record(city="Reims"):
    return {"country": {"iso_code": "FR", "names": {lang: f"France-{lang}" for lang in LANGUAGES}},
            "subdivisions": [{"iso_code": "GES", "names": {"fr": "Grand Est", "en": "Grand Est"}}],
            "city": {"names": {"fr": city, "en": city}}, "location": {"latitude": 49, "longitude": 4}}


class BuilderTests(unittest.TestCase):
    def test_cli_uses_maxminddb_public_mode_constant(self):
        class Reader:
            def metadata(self):
                return SimpleNamespace(database_type="DBIP-City-Lite", build_epoch=1790812800)

            def __iter__(self):
                return iter([("8.8.8.0/24", record())])

        # maxminddb 3.2 exposes MODE_AUTO, not a Mode enum. Exercise main(),
        # not just the build() helper, so a broken import API is caught.
        provider = SimpleNamespace(MODE_AUTO=0, open_database=Mock(return_value=nullcontext(Reader())))
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mmdb"
            source.write_bytes(b"fixture")
            argv = ["builder", str(source), "--edition", "2026-10", "--output", str(Path(directory) / "out")]
            output = io.StringIO()
            with patch("sys.argv", argv), patch.dict("sys.modules", {"maxminddb": provider}), redirect_stdout(output):
                main()
            provider.open_database.assert_called_once_with(str(source), mode=provider.MODE_AUTO)
            self.assertEqual(json.loads(output.getvalue())["records"], 1)

    def test_all_languages_and_no_coordinates(self):
        place = place_from_record(record())
        self.assertEqual(set(place["countryNames"]), set(LANGUAGES))
        self.assertNotIn("latitude", json.dumps(place))
        self.assertEqual(place["regionCode"], "GES")

    def test_sort_partition_ipv4_ipv6_and_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            result = build([("8.8.9.0/24", record()), ("8.8.8.0/24", record()),
                            ("2001:4860::/32", record("東京"))], directory, "2026-10", 1790812800, "a" * 64, 1)
            root = Path(directory) / result["release"]
            manifest = json.loads((root / "manifest.json").read_bytes())
            self.assertEqual(result["records"], 3)
            self.assertEqual(len(manifest["ranges"]["4"]), 1)
            self.assertEqual(result["emittedRanges"], {"4": 1, "6": 1})
            self.assertEqual(manifest["ranges"]["4"][0][0], "08080800")
            self.assertEqual(manifest["ranges"]["4"][0][1], "080809ff")
            for family in ("4", "6"):
                for _, _, sha in manifest["ranges"][family]:
                    content = (root / f"{sha}.json").read_bytes()
                    self.assertEqual(hashlib.sha256(content).hexdigest(), sha)
                    self.assertLessEqual(len(content), 262144)
            self.assertEqual(hashlib.sha256((root / "manifest.json").read_bytes()).hexdigest(), result["manifestSha256"])
            with self.assertRaises(FileExistsError):
                build([], directory, "2026-10", 1790812800, "a" * 64)

    def test_country_world_profile_keeps_only_selected_country_detail(self):
        usa = record("New York")
        usa["country"]["iso_code"] = "US"
        usa["country"]["names"] = {lang: f"United States-{lang}" for lang in LANGUAGES}
        with tempfile.TemporaryDirectory() as directory:
            result = build([("8.8.8.0/25", usa), ("8.8.8.128/25", usa),
                            ("51.38.0.0/24", record("Roubaix"))], directory, "2026-10",
                           1790812800, "d" * 64, detail_countries=("FR", "GP", "MQ", "GF", "RE", "YT"))
            root = Path(directory) / result["release"]
            manifest = json.loads((root / "manifest.json").read_bytes())
            self.assertEqual(manifest["profile"], "country-world-detail-FR-GF-GP-MQ-RE-YT")
            self.assertEqual(result["emittedRanges"]["4"], 2)
            shard = json.loads((root / f"{manifest['ranges']['4'][0][2]}.json").read_bytes())
            by_country = {place["country"]: place for place in shard["places"]}
            self.assertEqual(by_country["US"]["cityNames"], {})
            self.assertEqual(by_country["US"]["regionNames"], {})
            self.assertEqual(by_country["FR"]["cityNames"]["fr"], "Roubaix")

    def test_overlap_empty_and_invalid_source_never_emit_manifest(self):
        for records in ([], [("8.8.8.0/24", record()), ("8.8.8.0/25", record())]):
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    build(records, directory, "2026-10", 1790812800, "b" * 64)
                self.assertFalse(list(Path(directory).rglob("manifest.json")))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                build([], directory, "../bad", 1, "b" * 64)

    def test_limits_bytes_and_preserves_non_latin_names(self):
        rows = []
        for i in range(1024):
            data = record()
            data["city"]["names"] = {lang: f"東京{i}" + "界" * 70 for lang in LANGUAGES}
            rows.append((f"8.9.{i // 256}.{i % 256}/32", data))
        with tempfile.TemporaryDirectory() as directory:
            result = build(rows, directory, "2026-10", 1790812800, "c" * 64)
            root = Path(directory) / result["release"]
            manifest = json.loads((root / "manifest.json").read_bytes())
            self.assertGreater(len(manifest["ranges"]["4"]), 1)
            for _, _, sha in manifest["ranges"]["4"]:
                self.assertLessEqual((root / f"{sha}.json").stat().st_size, 262144)
            self.assertEqual(result["coverageByRange"]["ja"]["city"], 1024)


if __name__ == "__main__":
    unittest.main()
