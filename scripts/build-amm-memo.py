#!/usr/bin/env python3
"""Build the AMM treatment memo for the tax preparer.

Reads the verifier's --amm CSV (ledger-confirmed figures) and the app's
embedded XRP price series, and produces a PDF stating what the activity was
and what each candidate treatment does to each tax year.

Deliberately does NOT recommend a treatment. It supplies figures so the
decision is made by someone qualified to make it.
"""
import csv, json, re, sys, collections, datetime, pathlib

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, HRFlowable)

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else 'amm-all.csv'
HTML_PATH = sys.argv[2] if len(sys.argv) > 2 else 'renderer/index.html'
OUT = sys.argv[3] if len(sys.argv) > 3 else 'AMM-Treatment-Memo.pdf'

# ── Data ──────────────────────────────────────────────────────────────────
html = pathlib.Path(HTML_PATH).read_text()
PRICES = json.loads(re.search(r'const XRP_PRICES = (\{.*?\});', html, re.S).group(1))
_days = sorted(PRICES)

def price_on(d):
    """Daily high, the app's default reporting mode; nearest day if absent."""
    if d in PRICES:
        return PRICES[d]['high']
    tgt = datetime.date.fromisoformat(d)
    near = min(_days, key=lambda k: abs((datetime.date.fromisoformat(k) - tgt).days))
    return PRICES[near]['high']

rows = list(csv.DictReader(open(CSV_PATH)))
agg = collections.defaultdict(lambda: {'n': 0, 'xrp': 0.0, 'usd': 0.0, 'nofig': 0})
for r in rows:
    day = r['Timestamp'][:10]
    e = agg[(day[:4], r['Type'])]
    e['n'] += 1
    if r['LedgerDelta']:
        q = float(r['LedgerDelta'])
        e['xrp'] += q
        e['usd'] += q * price_on(day)
    else:
        e['nofig'] += 1

dep_xrp = sum(e['xrp'] for k, e in agg.items() if k[1] == 'AMMDeposit')
dep_usd = sum(e['usd'] for k, e in agg.items() if k[1] == 'AMMDeposit')
wd_xrp = sum(e['xrp'] for k, e in agg.items() if k[1] == 'AMMWithdraw')
w24 = agg[('2024', 'AMMWithdraw')]
w25 = agg[('2025', 'AMMWithdraw')]
nofig = sum(e['nofig'] for e in agg.values())
excess = wd_xrp - dep_xrp

money = lambda v: f"${v:,.2f}"
qty = lambda v: f"{v:,.2f}"

# ── Document ──────────────────────────────────────────────────────────────
ss = getSampleStyleSheet()
H1 = ParagraphStyle('H1', parent=ss['Title'], fontSize=15, spaceAfter=2, alignment=0)
SUB = ParagraphStyle('SUB', parent=ss['Normal'], fontSize=9, textColor=colors.HexColor('#555555'))
H2 = ParagraphStyle('H2', parent=ss['Heading2'], fontSize=11, spaceBefore=12, spaceAfter=4,
                    textColor=colors.HexColor('#1a2a52'))
BODY = ParagraphStyle('BODY', parent=ss['Normal'], fontSize=9.5, leading=13.5, spaceAfter=5)
NOTE = ParagraphStyle('NOTE', parent=BODY, fontSize=8.5, leading=11.5,
                      textColor=colors.HexColor('#444444'))

doc = SimpleDocTemplate(OUT, pagesize=letter, title='AMM Treatment Memo',
                        author='XRP & Xahau Tax Tool',
                        leftMargin=0.8 * inch, rightMargin=0.8 * inch,
                        topMargin=0.7 * inch, bottomMargin=0.7 * inch)
S = []

S.append(Paragraph('XRP Ledger AMM — treatment decision', H1))
S.append(Paragraph(
    'Prepared for review by a tax professional &nbsp;·&nbsp; figures reconciled against the '
    'XRP Ledger, not against exchange statements &nbsp;·&nbsp; '
    f'{datetime.date.today().isoformat()}', SUB))
S.append(Spacer(1, 6))
S.append(HRFlowable(width='100%', color=colors.HexColor('#1a2a52'), thickness=1.2))
S.append(Spacer(1, 8))

S.append(Paragraph('What is being decided', H2))
S.append(Paragraph(
    'The taxpayer supplied liquidity to an automated market maker (AMM) pool on the XRP Ledger. '
    'Depositing into the pool surrenders XRP and receives LP tokens; withdrawing reverses that. '
    '<b>The IRS has published no guidance on liquidity pool deposits.</b> Two positions are in '
    'general use, and they place income in different tax years. A position must be chosen and '
    'applied consistently to both entry and exit.', BODY))

S.append(Paragraph('The activity, as recorded on-chain', H2))
data = [['Year', 'Event', 'Count', 'XRP', 'USD at daily high']]
for k in sorted(agg):
    e = agg[k]
    data.append([k[0], k[1], str(e['n']), qty(e['xrp']), money(e['usd'])])
data.append(['', 'Net XRP retained', '', f'+{qty(excess)}', ''])
t = Table(data, colWidths=[0.6 * inch, 1.5 * inch, 0.6 * inch, 1.5 * inch, 1.7 * inch])
t.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a2a52')),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, -1), 8.5),
    ('ALIGN', (2, 0), (-1, -1), 'RIGHT'),
    ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#c8d0e0')),
    ('ROWBACKGROUNDS', (0, 1), (-1, -2), [colors.white, colors.HexColor('#f4f6fb')]),
    ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#fff3e0')),
    ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ('TOPPADDING', (0, 0), (-1, -1), 3),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
]))
S.append(t)
S.append(Spacer(1, 4))
S.append(Paragraph(
    f'Every deposit falls in 2024. Withdrawals span 2024 and 2025. USD figures value each '
    f'transaction at that day&rsquo;s high price. Quantities are the balance change recorded in '
    f'the transaction&rsquo;s own ledger metadata, with the network fee added back &mdash; not the '
    f'amount the transaction requested, which understated {"every one of the 18 that could be checked"}.', NOTE))

S.append(Paragraph('The fact that drives the decision', H2))
S.append(Paragraph(
    f'<b>{qty(wd_xrp)} XRP came out of the pool against {qty(dep_xrp)} XRP that went in &mdash; '
    f'a factor of {wd_xrp / dep_xrp:.2f}.</b> This was not a round trip. Roughly {qty(excess)} XRP '
    'of what was withdrawn did not enter the pool as XRP: it arrived as the pool&rsquo;s other asset '
    'and as accrued trading fees, and was converted to XRP inside the pool.', BODY))

S.append(Paragraph('What each position does', H2))
pos = [['', 'Treatment A &mdash; conservative', 'Treatment B &mdash; non-taxable'],
       ['Deposit', 'Taxable disposal of the XRP', 'Not a disposition'],
       ['Withdrawal', 'Acquisition at fair market value', 'Returns the original lots'],
       ['2024 effect', f'{money(dep_usd)} of proceeds recognised;<br/>{money(w24["usd"])} of new basis',
        'No effect'],
       ['2025 effect', f'{money(w25["usd"])} of new basis', 'No effect'],
       ['Holding period', 'Restarts at withdrawal', 'Preserved'],
       ['Covers the excess?', f'Yes &mdash; all {qty(wd_xrp)} XRP gets basis',
        f'<b>No &mdash; {qty(excess)} XRP is left<br/>without basis</b>']]
pt = Table([[Paragraph(c, ParagraphStyle('c', parent=BODY, fontSize=8.5, leading=11, spaceAfter=0))
             for c in row] for row in pos],
           colWidths=[1.2 * inch, 2.6 * inch, 2.1 * inch])
pt.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a2a52')),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
    ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#c8d0e0')),
    ('BACKGROUND', (0, 1), (0, -1), colors.HexColor('#eef1f8')),
    ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#fff3e0')),
    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ('TOPPADDING', (0, 0), (-1, -1), 4),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
]))
S.append(pt)
S.append(Spacer(1, 4))
S.append(Paragraph(
    'Treatment A is the position taken by commercial crypto tax software checked against this '
    'data (Koinly), and the one described as conservative in practitioner guidance. Treatment B '
    'is workable where a taxpayer withdraws roughly what was deposited. Here it is not, because '
    'most of what came out never went in as XRP.', NOTE))

S.append(Paragraph('Why this is not academic', H2))
S.append(Paragraph(
    'Until a treatment is applied, the withdrawn XRP enters the records with <b>no cost basis and '
    'no acquisition date</b>. Coins later transferred to exchange accounts inherited that: one '
    'Coinbase address currently shows 10,012 XRP carrying $0.49 of total basis. If sold, roughly '
    '$13,614 would be reported as gain against a true basis near $4,794 &mdash; and the whole amount '
    'as short-term, because a missing acquisition date cannot establish a holding period. '
    'Adopting either treatment cures this; treatment A cures all of it.', BODY))

S.append(Paragraph('Limits of these figures', H2))
for txt in [
    f'<b>The XRP leg only.</b> The pool&rsquo;s second asset is not tracked. Its disposal on deposit '
    f'and acquisition on withdrawal are not in these totals.',
    f'<b>{nofig} withdrawals carry no ledger figure</b> and are excluded from the amounts above. '
    f'In those modes the protocol ignores the amount field, so no requested figure exists.',
    '<b>Prices are daily highs</b> from the tool&rsquo;s embedded series. A daily-low basis is also '
    'available and produces a different, lower set of figures.',
    '<b>Gain, not proceeds, is what is taxed.</b> The deposit figure above is proceeds; the gain '
    'depends on the basis of the XRP deposited, which the tool holds per lot and can supply.',
]:
    S.append(Paragraph('&bull; ' + txt, NOTE))

S.append(Paragraph('Questions for the preparer', H2))
for q in [
    'Which treatment should be applied, given no IRS guidance exists?',
    f'Treatment A recognises {money(dep_usd)} of proceeds in <b>2024</b>. If that return is filed, '
    f'does this warrant an amendment, and does the answer change the choice?',
    'Should the position be disclosed on the return, and if so how?',
    'Does the untracked second asset of the pool need to be reconstructed before filing?',
]:
    S.append(Paragraph('&bull; ' + q, BODY))

S.append(Spacer(1, 8))
S.append(HRFlowable(width='100%', color=colors.HexColor('#c8d0e0'), thickness=0.6))
S.append(Paragraph(
    'Figures produced by the taxpayer&rsquo;s own reconciliation tool and verified transaction-by-'
    'transaction against XRP Ledger metadata via a full-history node. This memo states figures and '
    'options; it does not recommend a tax position and is not tax advice.', NOTE))

doc.build(S)
print(f'wrote {OUT}')
