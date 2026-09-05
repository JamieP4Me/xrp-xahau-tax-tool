#!/usr/bin/env python3
"""
xah-units-check.py — settle one question about your cached tax data:

    Is the Xahau `Amount_XRP` column in DROPS (1 XAH = 1,000,000 drops)
    or in WHOLE XAH?

The app's code treats it as whole XAH. A comment in the same file claims it's
drops. If the comment is right, every XAH quantity in your reports is one
million times too large. This script answers it from data you already have.

It is strictly READ-ONLY. It opens the database in read-only mode, runs
SELECTs, and writes nothing. It makes no network calls.

Usage:
    python3 xah-units-check.py
    python3 xah-units-check.py --db "/path/to/tax-data.sqlite3"
    python3 xah-units-check.py --address rYourWalletAddressHere

Quit the tax app before running, so its database is closed cleanly.
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile

# Approximate spot price, only used to show what each interpretation would
# imply in dollars. Nothing depends on it being exact.
XAH_USD = 0.014
XRP_USD = 2.40

DEFAULT_DB_PATHS = [
    os.path.expanduser("~/Library/Application Support/XRP & Xahau Tax Tool/tax-data.sqlite3"),
    os.path.expanduser("~/Library/Application Support/xrp-xahau-tax-tool/tax-data.sqlite3"),
    os.path.expanduser("~/.config/XRP & Xahau Tax Tool/tax-data.sqlite3"),
    os.path.expanduser("~/.config/xrp-xahau-tax-tool/tax-data.sqlite3"),
    os.path.join(os.environ.get("APPDATA", ""), "XRP & Xahau Tax Tool", "tax-data.sqlite3"),
]

SAMPLE_LIMIT = 300000   # plenty for a distribution; keeps it fast on a big cache


def find_db(explicit):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit("No database at: %s" % explicit)
        return explicit
    for p in DEFAULT_DB_PATHS:
        if p and os.path.exists(p):
            return p
    sys.exit(
        "Could not find tax-data.sqlite3 automatically.\n"
        "Open the app, look at the Local Data panel on the Setup tab — it prints the\n"
        "exact database path — then re-run with:\n"
        '    python3 xah-units-check.py --db "/that/path/tax-data.sqlite3"'
    )


def connect_readonly(path):
    """Open read-only. Falls back to a temp copy if the WAL blocks that."""
    try:
        con = sqlite3.connect("file:%s?mode=ro" % path.replace("?", "%3f"), uri=True)
        con.execute("SELECT 1 FROM raw_transactions LIMIT 1")
        return con, None
    except sqlite3.Error:
        tmpdir = tempfile.mkdtemp(prefix="xah-units-")
        copy = os.path.join(tmpdir, "copy.sqlite3")
        shutil.copyfile(path, copy)
        for suffix in ("-wal", "-shm"):
            if os.path.exists(path + suffix):
                shutil.copyfile(path + suffix, copy + suffix)
        con = sqlite3.connect(copy)
        return con, tmpdir


def scan(con, chain, address=None):
    """Return (stats, samples) for native-currency Payments on one chain."""
    sql = "SELECT raw_json FROM raw_transactions WHERE chain = ?"
    args = [chain]
    if address:
        sql += " AND wallet = ?"
        args.append(address)
    sql += " LIMIT %d" % SAMPLE_LIMIT

    buckets = {"1-999": 0, "1e3-1e5": 0, "1e5-1e6": 0, "1e6-1e9": 0, ">=1e9": 0}
    stats = {
        "rows_seen": 0, "native_payments": 0, "with_decimal_point": 0,
        "min": None, "max": None, "bad_json": 0, "buckets": buckets,
    }
    samples = []

    for (raw,) in con.execute(sql, args):
        stats["rows_seen"] += 1
        try:
            r = json.loads(raw)
        except Exception:
            stats["bad_json"] += 1
            continue
        if (r.get("TransactionType") or "") != "Payment":
            continue
        # Native currency only — skip IOUs like EVR, whose value lives in
        # Amount_value and is genuinely a plain decimal.
        if (r.get("Amount_currency") or "").strip():
            continue

        raw_amt = r.get("delivered_amount_XRP") or r.get("Amount_XRP")
        if raw_amt in (None, ""):
            continue
        s = str(raw_amt).strip()
        try:
            amt = float(s)
        except ValueError:
            continue
        if amt <= 0:
            continue

        stats["native_payments"] += 1
        if "." in s:
            stats["with_decimal_point"] += 1
        stats["min"] = amt if stats["min"] is None else min(stats["min"], amt)
        stats["max"] = amt if stats["max"] is None else max(stats["max"], amt)

        if amt < 1e3:      buckets["1-999"] += 1
        elif amt < 1e5:    buckets["1e3-1e5"] += 1
        elif amt < 1e6:    buckets["1e5-1e6"] += 1
        elif amt < 1e9:    buckets["1e6-1e9"] += 1
        else:              buckets[">=1e9"] += 1

        h = r.get("TransactionHash") or ""
        if len(samples) < 8 and h and set(h) != {"\x00"}:
            samples.append({
                "hash": h,
                "amount_field": s,
                "from": r.get("Account") or "",
                "to": r.get("Destination") or "",
                "when": r.get("Timestamp") or "",
            })
    return stats, samples


def median_bucket(buckets):
    order = ["1-999", "1e3-1e5", "1e5-1e6", "1e6-1e9", ">=1e9"]
    total = sum(buckets.values())
    if not total:
        return None
    seen = 0
    for b in order:
        seen += buckets[b]
        if seen >= total / 2:
            return b
    return order[-1]


def report(chain, stats, samples, unit_price, unit_name):
    print("=" * 72)
    print("%s — native %s payments" % (chain, unit_name))
    print("=" * 72)
    if stats["native_payments"] == 0:
        print("  No native payments found in the sample (%d rows scanned)." % stats["rows_seen"])
        print()
        return None

    print("  rows scanned in sample : %s" % f"{stats['rows_seen']:,}")
    print("  native payments        : %s" % f"{stats['native_payments']:,}")
    print("  smallest amount value  : %s" % f"{stats['min']:,.6f}".rstrip("0").rstrip("."))
    print("  largest amount value   : %s" % f"{stats['max']:,.6f}".rstrip("0").rstrip("."))
    print("  values with a decimal  : %s   <-- decisive if > 0" % f"{stats['with_decimal_point']:,}")
    print("  magnitude distribution :")
    for b, n in stats["buckets"].items():
        pct = 100.0 * n / stats["native_payments"]
        bar = "#" * int(pct / 2)
        print("      %-9s %10s  %5.1f%%  %s" % (b, f"{n:,}", pct, bar))

    mb = median_bucket(stats["buckets"])
    print()
    print("  What the typical payment would MEAN under each reading")
    print("  (typical magnitude falls in the %s bucket):" % mb)
    rep = {"1-999": 500.0, "1e3-1e5": 5e4, "1e5-1e6": 5e5, "1e6-1e9": 5e7, ">=1e9": 5e9}[mb]
    print("      as WHOLE %-4s : %s %s  = about $%s" % (
        unit_name, f"{rep:,.0f}", unit_name, f"{rep * unit_price:,.2f}"))
    print("      as DROPS      : %s %s  = about $%s" % (
        f"{rep / 1e6:,.6f}".rstrip("0").rstrip("."), unit_name, f"{rep / 1e6 * unit_price:,.4f}"))

    print()
    print("  Transactions you can verify on an explorer:")
    for s in samples:
        print("      %s" % s["hash"])
        print("          amount field in your cache : %s" % s["amount_field"])
        print("          %s  ->  %s   (%s)" % (s["from"][:20], s["to"][:20], s["when"]))
    print()
    return stats


def verdict(stats, unit_name, expect):
    """expect: 'whole' (what the app assumes for Xahau) or 'drops' (XRPL)."""
    if not stats or stats["native_payments"] == 0:
        return "NO DATA — nothing to judge from."

    if stats["with_decimal_point"] > 0:
        line = ("Column holds WHOLE %s. DEFINITIVE: %s values carry a decimal point, and "
                "drops are whole numbers by protocol, so this cannot be drops."
                % (unit_name, f"{stats['with_decimal_point']:,}"))
        return line + ("\n      -> Matches what the app assumes. No change needed."
                       if expect == "whole" else
                       "\n      -> CONFLICTS with the app, which divides this column by 1e6. Tell Claude.")

    b = stats["buckets"]
    small = b["1-999"] + b["1e3-1e5"] + b["1e5-1e6"]
    large = b["1e6-1e9"] + b[">=1e9"]

    if small > large:
        line = ("Column holds WHOLE %s. STRONGLY INDICATED: most payments are under 1,000,000, "
                "which read as drops would make nearly every payment you ever sent worth a "
                "fraction of a cent." % unit_name)
        return line + ("\n      -> Matches what the app assumes. No change needed."
                       if expect == "whole" else
                       "\n      -> CONFLICTS with the app, which divides this column by 1e6. Tell Claude.")

    line = ("Values are mostly >= 1,000,000, which is what DROPS look like — but a genuinely "
            "large holding would look the same. Magnitude alone cannot separate the two here.")
    if expect == "drops":
        return line + ("\n      -> Consistent with the app, which already divides this column "
                       "by 1e6. Confirm one hash on the explorer to be sure.")
    return line + ("\n      -> POSSIBLE PROBLEM. The app does NOT divide this column, so if it "
                   "really is drops every XAH figure is 1,000,000x too large. Check a hash on "
                   "the explorer and send Claude the result before filing anything.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", help="path to tax-data.sqlite3")
    ap.add_argument("--address", help="restrict to one wallet address")
    args = ap.parse_args()

    path = find_db(args.db)
    print()
    print("Reading (read-only): %s" % path)
    if args.address:
        print("Restricted to wallet: %s" % args.address)
    print()

    con, tmpdir = connect_readonly(path)
    try:
        xah_stats, xah_samples = scan(con, "Xahau", args.address)
        xrp_stats, xrp_samples = scan(con, "XRPL", args.address)
    finally:
        con.close()
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)

    report("XAHAU", xah_stats, xah_samples, XAH_USD, "XAH")
    report("XRP LEDGER", xrp_stats, xrp_samples, XRP_USD, "XRP")

    print("=" * 72)
    print("VERDICT")
    print("=" * 72)
    print("  Xahau  Amount_XRP : %s" % verdict(xah_stats, "XAH", "whole"))
    print()
    print("  XRPL   Amount_XRP : %s" % verdict(xrp_stats, "XRP", "drops"))
    print()
    print("Next: copy this whole output back to Claude. To confirm independently,")
    print("paste one of the transaction hashes above into the search box at")
    print("https://xahau.xrplwin.com (Xahau) or https://livenet.xrpl.org (XRP Ledger)")
    print("and compare the amount shown there with the 'amount field in your cache'")
    print("value printed next to it.")
    print()


if __name__ == "__main__":
    main()
