#!/usr/bin/env python3
"""Group the output of `verify-xrpl.js --amm` by withdrawal mode.

Offline. Reads the CSV that run already wrote; makes no network calls and
needs no Payment-Claim.

WHY: a run on 68 paired AMM transactions found 45 where the ledger moved MORE
than the Amount the transaction submitted — always more, mostly by 2-4%, twice
by over 40%. "The submitted figure is not the delivered figure" is established;
WHICH withdrawals behave that way is not, and the answer decides whether the
app can ever show the submitted number.

The Amount field means different things per mode: for tfSingleAsset it is the
exact amount to withdraw, while for the LP-token modes it functions as a bound
and the pool decides what you actually get. If the differing rows cluster on
the bound-style flags and the exact ones on tfSingleAsset, that is the whole
explanation and it is visible in one table.

    python3 scripts/amm-flags.py amm.csv
"""
import csv, collections, sys

# AMMWithdraw / AMMDeposit mode flags, from the XRPL transaction spec.
FLAGS = {
    0x00010000: 'tfLPToken',
    0x00020000: 'tfWithdrawAll',
    0x00040000: 'tfOneAssetWithdrawAll',
    0x00080000: 'tfSingleAsset',
    0x00100000: 'tfTwoAsset',
    0x00200000: 'tfOneAssetLPToken',
    0x00400000: 'tfLimitLPToken',
}
CANONICAL = 0x80000000   # tfFullyCanonicalSig — universal, says nothing about mode

def mode(raw):
    try: f = int(raw or 0)
    except ValueError: return '?'
    f &= ~CANONICAL
    hit = [v for k, v in FLAGS.items() if f & k]
    return '+'.join(hit) if hit else ('(no mode flag)' if f == 0 else hex(f))

path = sys.argv[1] if len(sys.argv) > 1 else 'amm.csv'
# Three outcomes, not two. A row with no cached amount was never compared;
# counting it as "matched" claims agreement that was never tested, and counting
# it as "differed" overstates the problem. The first version of this pair of
# tools made both mistakes in opposite directions and reported 24 differences
# against the verifier's 45 — for the same 68 rows.
g = collections.defaultdict(lambda: {'n': 0, 'diff': 0, 'exact': 0, 'nobasis': 0,
                                     'tot': 0.0, 'pct': []})
for r in csv.DictReader(open(path)):
    if not r.get('LedgerDelta'): continue          # unpaired rows have nothing to say
    e = g[(r['Type'], mode(r['Flags']))]
    e['n'] += 1
    raw = (r.get('SubmittedAmount') or '').strip()
    if not raw:
        e['nobasis'] += 1                          # ledger figure known, cached one absent
        continue
    d = float(r['Difference'] or 0)
    sub = float(raw)
    e['tot'] += d
    if abs(d) > 1e-6:
        e['diff'] += 1
        if sub: e['pct'].append(100 * d / sub)
    else:
        e['exact'] += 1

hdr = (f"{'Type':<12} {'Mode':<24} {'rows':>5} {'cmp':>5} {'exact':>6} {'differ':>7} "
       f"{'net diff (XRP)':>16} {'median %':>9}")
print(hdr)
print('-' * len(hdr))
tot = {'n': 0, 'cmp': 0, 'exact': 0, 'diff': 0, 'tot': 0.0, 'nobasis': 0}
for (t, f), e in sorted(g.items(), key=lambda kv: -kv[1]['tot']):
    pcts = sorted(e['pct'])
    med = f"{pcts[len(pcts)//2]:+.2f}%" if pcts else '—'
    cmp_ = e['exact'] + e['diff']
    print(f'{t:<12} {f:<24} {e["n"]:>5} {cmp_:>5} {e["exact"]:>6} {e["diff"]:>7} '
          f'{e["tot"]:>16.6f} {med:>9}')
    tot['n'] += e['n']; tot['cmp'] += cmp_; tot['exact'] += e['exact']
    tot['diff'] += e['diff']; tot['tot'] += e['tot']; tot['nobasis'] += e['nobasis']

print('-' * len(hdr))
print(f'{"TOTAL":<12} {"":<24} {tot["n"]:>5} {tot["cmp"]:>5} {tot["exact"]:>6} '
      f'{tot["diff"]:>7} {tot["tot"]:>16.6f}')
if tot['nobasis']:
    print(f'\n{tot["nobasis"]} paired row(s) had no cached amount, so nothing was compared for them.')
    print('Their ledger figures are still in the CSV — those are the only figures they have.')
if tot['tot'] > 0:
    print(f'\nNet {tot["tot"]:+.6f} XRP: the ledger moved MORE than was submitted overall,')
    print('so every cached AMM amount should be read as a floor, not a figure.')
