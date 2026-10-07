"""Compile a legally downloaded DB-IP City Lite MMDB into small immutable Cloud objects.

No network calls, cloud writes, visitor IPs or coordinates. SQLite sorting keeps
RAM bounded even for the complete world database. Never replace an old release.
"""
import argparse
import collections
from contextlib import closing
import gzip
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import sqlite3
import sys
import tempfile

LANGUAGES = ("en", "fr", "de", "es", "pt-BR", "zh-CN", "ja", "ru", "fa", "ko")
MAX_BYTES = 262_144


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def clean(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if 0 < len(value) <= 100 and not re.search(r"[\x00-\x1f\x7f<>]", value) else None


def names(value):
    if not isinstance(value, dict):
        return {}
    return {lang: label for lang in LANGUAGES if (label := clean(value.get(lang)))}


def place_from_record(record):
    country = record.get("country", {})
    code = country.get("iso_code", "")
    if not re.fullmatch(r"[A-Z]{2}", code):
        return None
    subdivisions = record.get("subdivisions") or []
    region = subdivisions[0] if subdivisions else {}
    return {"country": code, "countryNames": names(country.get("names")),
            "regionCode": clean(region.get("iso_code")), "regionNames": names(region.get("names")),
            "cityNames": names(record.get("city", {}).get("names"))}


def build(records, output, edition, database_epoch, source_sha, rows_per_shard=2048,
          detail_countries=None):
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", edition) or not re.fullmatch(r"[a-f0-9]{64}", source_sha):
        raise ValueError("Invalid edition or source SHA-256")
    if not 1 <= rows_per_shard <= 2048:
        raise ValueError("Invalid shard row limit")
    detail_countries = tuple(sorted(set(detail_countries or ())))
    if any(not re.fullmatch(r"[A-Z]{2}", code) for code in detail_countries):
        raise ValueError("Invalid detailed country code")
    profile = "full" if not detail_countries else "country-world-detail-" + "-".join(detail_countries)
    build_sha = hashlib.sha256(f"forsure-dbip-lite-v2\n{source_sha}\n{profile}".encode()).hexdigest()
    release = f"{edition}-{build_sha[:12]}"
    target = Path(output) / release
    target.mkdir(parents=True, exist_ok=False)
    manifest = {"format": "forsure-dbip-lite", "edition": edition, "databaseEpoch": database_epoch,
                "sourceSha256": source_sha, "buildSha256": build_sha, "profile": profile,
                "detailCountries": list(detail_countries), "languages": list(LANGUAGES),
                "attribution": "IP Geolocation by DB-IP", "source": "https://db-ip.com",
                "license": "https://creativecommons.org/licenses/by/4.0/",
                "modifications": "Coordinates removed; names and IP ranges partitioned for bounded server reads.",
                "ranges": {"4": [], "6": []}}
    coverage = {lang: {"country": 0, "region": 0, "city": 0} for lang in LANGUAGES}
    count = 0
    with tempfile.TemporaryDirectory(prefix="forsure-dbip-sort-") as temp:
        with closing(sqlite3.connect(str(Path(temp) / "sort.sqlite"))) as db:
            db.execute("PRAGMA cache_size=-8192")
            db.execute("PRAGMA temp_store=FILE")
            db.execute("CREATE TABLE places(id INTEGER PRIMARY KEY, payload TEXT UNIQUE)")
            db.execute("CREATE TABLE ranges(family INTEGER, lo TEXT, hi TEXT, place INTEGER)")
            recent = collections.OrderedDict()
            for network, record in records:
                network = ipaddress.ip_network(network)
                if network.version == 6 and not network.subnet_of(ipaddress.ip_network("2000::/3")):
                    continue
                place = place_from_record(record)
                if place is None:
                    continue
                if detail_countries and place["country"] not in detail_countries:
                    # Outside the detailed catalogue, country-only data avoids retaining
                    # unnecessary city granularity and permits aggressive range coalescing.
                    place = {**place, "regionCode": None, "regionNames": {}, "cityNames": {}}
                payload = encoded(place).decode("utf-8")
                place_id = recent.get(payload)
                if place_id is None:
                    db.execute("INSERT OR IGNORE INTO places(payload) VALUES(?)", (payload,))
                    place_id = db.execute("SELECT id FROM places WHERE payload=?", (payload,)).fetchone()[0]
                    if len(recent) >= 4096:
                        recent.popitem(last=False)
                    recent[payload] = place_id
                width = 8 if network.version == 4 else 32
                db.execute("INSERT INTO ranges VALUES(?,?,?,?)", (network.version,
                           f"{int(network.network_address):0{width}x}", f"{int(network.broadcast_address):0{width}x}", place_id))
                count += 1
                for lang in LANGUAGES:
                    for field in ("country", "region", "city"):
                        coverage[lang][field] += int(lang in place[field + "Names"])
                if count % 10_000 == 0:
                    db.commit()
                if count % 250_000 == 0:
                    print(f"Indexed {count:,} ranges", file=sys.stderr, flush=True)
            db.commit()
            if count >= 250_000:
                print(f"Sorting {count:,} ranges on disk", file=sys.stderr, flush=True)
            db.execute("CREATE INDEX ordered_ranges ON ranges(family,lo)")
            for family in (4, 6):
                rows, places, ids = [], [], {}
                size = 32
                previous = ""
                emitted = 0

                def flush():
                    if not rows:
                        return
                    content = encoded({"ranges": rows, "places": places})
                    if len(content) > MAX_BYTES:
                        raise ValueError("Shard exceeds runtime limit")
                    sha = hashlib.sha256(content).hexdigest()
                    (target / f"{sha}.json").write_bytes(content)
                    manifest["ranges"][str(family)].append([rows[0][0], rows[-1][1], sha])
                    if len(manifest["ranges"][str(family)]) % 250 == 0:
                        print(f"Wrote {len(manifest['ranges'][str(family)]):,} IPv{family} shards", file=sys.stderr, flush=True)

                def append_range(lo, hi, place_id, payload):
                    nonlocal rows, places, ids, size, emitted
                    addition = len(encoded([lo, hi, len(places)])) + 1
                    if place_id not in ids:
                        addition += len(payload.encode("utf-8")) + 1
                    if rows and (len(rows) >= rows_per_shard or size + addition > MAX_BYTES - 64):
                        flush()
                        rows, places, ids = [], [], {}
                        size = 32
                        addition = len(encoded([lo, hi, 0])) + len(payload.encode("utf-8")) + 2
                    if place_id not in ids:
                        ids[place_id] = len(places)
                        places.append(json.loads(payload))
                    rows.append([lo, hi, ids[place_id]])
                    size += addition
                    emitted += 1

                pending = None
                for lo, hi, place_id, payload in db.execute(
                        "SELECT r.lo,r.hi,r.place,p.payload FROM ranges r JOIN places p ON r.place=p.id WHERE family=? ORDER BY lo", (family,)):
                    if lo <= previous:
                        raise ValueError("Overlapping or duplicate input ranges")
                    previous = hi
                    if pending and pending[2] == place_id and int(lo, 16) == int(pending[1], 16) + 1:
                        pending = (pending[0], hi, place_id, payload)
                    else:
                        if pending:
                            append_range(*pending)
                        pending = (lo, hi, place_id, payload)
                if pending:
                    append_range(*pending)
                flush()
                manifest.setdefault("emittedRanges", {})[str(family)] = emitted
    if count == 0:
        raise ValueError("Empty database: no releasable manifest produced")
    if any(len(rows) > 60_000 for rows in manifest["ranges"].values()):
        raise ValueError("Index exceeds runtime range limit")
    content = encoded(manifest)
    if len(content) > 8_388_608:
        raise ValueError("Index exceeds runtime byte limit")
    # Manifest is last: interrupted builds cannot be activated as complete releases.
    (target / "manifest.json").write_bytes(content)
    report = {"release": release, "manifestSha256": hashlib.sha256(content).hexdigest(), "records": count,
              "emittedRanges": manifest["emittedRanges"], "profile": profile,
              "bytes": sum(p.stat().st_size for p in target.glob("*.json")), "coverageByRange": coverage,
              "note": "Coverage counts address ranges, not people. Missing translations fall back to English/French."}
    (target / "report.json").write_bytes(encoded(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="Already downloaded DB-IP City Lite .mmdb or .mmdb.gz")
    parser.add_argument("--edition", required=True, help="YYYY-MM from the official download")
    parser.add_argument("--output", type=Path, default=Path(".geoip-build"))
    parser.add_argument("--detail-country", action="append", default=[], metavar="CC",
                        help="Keep region/city only for this ISO country; repeat as needed")
    args = parser.parse_args()
    import maxminddb  # Offline builder only; never included in the web/Edge bundle.
    with tempfile.TemporaryDirectory(prefix="forsure-dbip-input-") as temp:
        path = args.database
        if path.suffix == ".gz":
            path = Path(temp) / "source.mmdb"
            with gzip.open(args.database, "rb") as source, path.open("wb") as dest:
                total = 0
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > 2_147_483_648:
                        raise ValueError("Database exceeds 2 GiB input limit")
                    dest.write(chunk)
        with path.open("rb") as source:
            source_sha = hashlib.file_digest(source, "sha256").hexdigest()
        with maxminddb.open_database(str(path), mode=maxminddb.MODE_AUTO) as reader:
            metadata = reader.metadata()
            if metadata.database_type != "DBIP-City-Lite":
                raise ValueError("Only the free DBIP-City-Lite database is accepted")
            report = build(reader, args.output, args.edition, metadata.build_epoch, source_sha,
                           detail_countries=args.detail_country)
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
