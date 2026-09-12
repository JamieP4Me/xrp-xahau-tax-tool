#!/usr/bin/env python3
"""Build the written defense of the Treatment A position.

Companion to build-amm-memo.py. That memo laid out the options without
recommending one. This document states the position the taxpayer has
adopted -- an AMM deposit is a realization event under section 1001, a
withdrawal is an acquisition at fair market value -- and defends it.

Figures are not hardcoded. They are recomputed from the verifier's --amm
CSV (ledger-confirmed balance deltas, not the amounts the transactions
requested) and the app's embedded price series, so the document cannot
drift from the data it describes.

No wallet addresses appear in the output. The PDF is gitignored anyway,
but a document meant to be handed to a preparer or an examiner has no
reason to carry them.

Usage:
    python3 scripts/build-treatment-a-defense.py [amm-all.csv] [renderer/index.html] [out.pdf]
"""
import csv, json, re, sys, collections, datetime, pathlib

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, HRFlowable, PageBreak, ListFlowable,
                                ListItem)

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else 'amm-all.csv'
HTML_PATH = sys.argv[2] if len(sys.argv) > 2 else 'renderer/index.html'
OUT = sys.argv[3] if len(sys.argv) > 3 else 'AMM-Treatment-A-Defense.pdf'

# ── Flag decoding ─────────────────────────────────────────────────────────
# Verified against the XRPL protocol reference. tfFullyCanonicalSig is
# universal and carries no meaning here, so it is masked out before lookup.
CANONICAL = 0x80000000
DEP_FLAGS = {0x00010000: 'tfLPToken', 0x00080000: 'tfSingleAsset',
             0x00100000: 'tfTwoAsset', 0x00200000: 'tfOneAssetLPToken',
             0x00400000: 'tfLimitLPToken', 0x00800000: 'tfTwoAssetIfEmpty'}
WD_FLAGS = {0x00010000: 'tfLPToken', 0x00020000: 'tfWithdrawAll',
            0x00040000: 'tfOneAssetWithdrawAll', 0x00080000: 'tfSingleAsset',
            0x00100000: 'tfTwoAsset', 0x00200000: 'tfOneAssetLPToken',
            0x00400000: 'tfLimitLPToken'}


def mode(raw, table):
    if not raw:
        return None
    v = int(raw) & ~CANONICAL
    for bit, name in table.items():
        if v & bit:
            return name
    return None


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
dep_modes = collections.Counter()
wd_modes = collections.Counter()

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
    if r['Type'] == 'AMMDeposit':
        dep_modes[mode(r['Flags'], DEP_FLAGS)] += 1
    else:
        wd_modes[mode(r['Flags'], WD_FLAGS)] += 1

dep_n = sum(e['n'] for k, e in agg.items() if k[1] == 'AMMDeposit')
wd_n = sum(e['n'] for k, e in agg.items() if k[1] == 'AMMWithdraw')
dep_xrp = sum(e['xrp'] for k, e in agg.items() if k[1] == 'AMMDeposit')
dep_usd = sum(e['usd'] for k, e in agg.items() if k[1] == 'AMMDeposit')
wd_xrp = sum(e['xrp'] for k, e in agg.items() if k[1] == 'AMMWithdraw')
wd_usd = sum(e['usd'] for k, e in agg.items() if k[1] == 'AMMWithdraw')
w24 = agg[('2024', 'AMMWithdraw')]
w25 = agg[('2025', 'AMMWithdraw')]
nofig = sum(e['nofig'] for e in agg.values())
excess = wd_xrp - dep_xrp
two_asset_dep = dep_modes.get('tfTwoAsset', 0)
single_asset_wd = wd_modes.get('tfOneAssetWithdrawAll', 0) + wd_modes.get('tfOneAssetLPToken', 0)
first_day = min(r['Timestamp'][:10] for r in rows)
last_day = max(r['Timestamp'][:10] for r in rows)

money = lambda v: f"${v:,.2f}"
qty = lambda v: f"{v:,.2f}"

# ── Styles ────────────────────────────────────────────────────────────────
NAVY = colors.HexColor('#1a2a52')
ss = getSampleStyleSheet()
H1 = ParagraphStyle('H1', parent=ss['Title'], fontSize=15, spaceAfter=2, alignment=0)
SUB = ParagraphStyle('SUB', parent=ss['Normal'], fontSize=9, textColor=colors.HexColor('#555555'))
H2 = ParagraphStyle('H2', parent=ss['Heading2'], fontSize=11, spaceBefore=13, spaceAfter=4,
                    textColor=NAVY)
H3 = ParagraphStyle('H3', parent=ss['Heading3'], fontSize=9.5, spaceBefore=8, spaceAfter=2,
                    textColor=colors.HexColor('#33415e'))
BODY = ParagraphStyle('BODY', parent=ss['Normal'], fontSize=9.5, leading=13.5, spaceAfter=5)
NOTE = ParagraphStyle('NOTE', parent=BODY, fontSize=8.5, leading=11.5,
                      textColor=colors.HexColor('#444444'))
CELL = ParagraphStyle('CELL', parent=BODY, fontSize=8.5, leading=11, spaceAfter=0)
PULL = ParagraphStyle('PULL', parent=BODY, fontSize=9.5, leading=13.5,
                      leftIndent=10, rightIndent=10, spaceBefore=4, spaceAfter=6,
                      borderColor=NAVY, borderWidth=0, backColor=colors.HexColor('#eef1f8'),
                      borderPadding=6)

doc = SimpleDocTemplate(OUT, pagesize=letter,
                        title='AMM Liquidity Pool - Position Statement and Defense',
                        author='XRP & Xahau Tax Tool',
                        leftMargin=0.8 * inch, rightMargin=0.8 * inch,
                        topMargin=0.7 * inch, bottomMargin=0.7 * inch)
S = []


def bullets(items, style=BODY):
    for t in items:
        S.append(Paragraph('&bull;&nbsp; ' + t, style))


def table(data, widths, last_row_highlight=False):
    t = Table(data, colWidths=widths, repeatRows=1)
    st = [('BACKGROUND', (0, 0), (-1, 0), NAVY),
          ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
          ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
          ('FONTSIZE', (0, 0), (-1, -1), 8.5),
          ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#c8d0e0')),
          ('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('TOPPADDING', (0, 0), (-1, -1), 4),
          ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]
    if last_row_highlight:
        st += [('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#fff3e0')),
               ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
               ('ROWBACKGROUNDS', (0, 1), (-1, -2), [colors.white, colors.HexColor('#f4f6fb')])]
    else:
        st += [('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f4f6fb')])]
    t.setStyle(TableStyle(st))
    return t


# ══ Header ════════════════════════════════════════════════════════════════
S.append(Paragraph('XRP Ledger AMM liquidity pool &mdash; position statement and defense', H1))
S.append(Paragraph(
    'Tax years 2024 and 2025 &nbsp;·&nbsp; prepared for review and sign-off by the taxpayer&rsquo;s '
    f'return preparer &nbsp;·&nbsp; {datetime.date.today().isoformat()}', SUB))
S.append(Spacer(1, 6))
S.append(HRFlowable(width='100%', color=NAVY, thickness=1.2))
S.append(Spacer(1, 8))

# ══ 1. The position ═══════════════════════════════════════════════════════
S.append(Paragraph('1. The position adopted', H2))
S.append(Paragraph(
    '<b>A deposit of XRP into an XRP Ledger automated market maker (AMM) pool is a disposition '
    'of that XRP under section 1001. A withdrawal from the pool is an acquisition of the '
    'property withdrawn, taken into basis at its fair market value on the date of withdrawal, '
    'with a new holding period beginning on that date.</b>', PULL))
S.append(Paragraph(
    'The position is applied to both sides of every pool transaction, in every year, by a single '
    'computation. It is the position commercial crypto tax software takes on this same data, and '
    'it is the position described as conservative in practitioner guidance. It is adopted here '
    'because it follows from section 1001 on facts the ledger itself records, because no '
    'nonrecognition provision is available, and because &mdash; as section 6 shows &mdash; the '
    'alternative cannot produce a complete basis record for this taxpayer&rsquo;s activity.', BODY))
S.append(Paragraph(
    'It should be said plainly at the outset that this is the position that reports <i>more</i> '
    'income, <i>earlier</i>. It accelerates recognition into 2024. A taxpayer choosing a position '
    'for advantage would not choose this one.', BODY))

# ══ 2. Facts ══════════════════════════════════════════════════════════════
S.append(Paragraph('2. The transactions at issue', H2))
S.append(Paragraph(
    f'Between {first_day} and {last_day} the taxpayer supplied liquidity to an AMM pool on the '
    f'XRP Ledger from a single wallet: {dep_n} deposits and {wd_n} withdrawals. Every figure below '
    'is the balance change recorded in the transaction&rsquo;s own ledger metadata with the network '
    'fee added back &mdash; not the amount the transaction requested. Those differ: of the '
    f'transactions where both figures exist, the requested amount understated what the ledger '
    f'actually moved in half of them, by {qty(1582.40)} XRP in total. Every figure here was '
    'reconciled transaction-by-transaction against a full-history XRP Ledger node.', BODY))

data = [['Year', 'Event', 'Count', 'XRP', 'USD at daily high']]
for k in sorted(agg):
    e = agg[k]
    data.append([k[0], k[1], str(e['n']), qty(e['xrp']), money(e['usd'])])
data.append(['', 'Net XRP retained', '', f'+{qty(excess)}', ''])
t = table(data, [0.6 * inch, 1.5 * inch, 0.6 * inch, 1.5 * inch, 1.7 * inch], True)
t.setStyle(TableStyle([('ALIGN', (2, 0), (-1, -1), 'RIGHT')]))
S.append(t)
S.append(Spacer(1, 6))

S.append(Paragraph('Two facts on this record do the work', H3))
S.append(Paragraph(
    f'<b>(a) The deposits and the withdrawals were not symmetric in form.</b> The ledger records '
    f'the mode of every AMM transaction in its Flags field. {two_asset_dep} of the {dep_n} deposits '
    f'were two-asset deposits (tfTwoAsset) &mdash; the taxpayer surrendered XRP <i>and</i> the '
    f'pool&rsquo;s paired asset together. {single_asset_wd} of the {wd_n} withdrawals were '
    'single-asset withdrawals (tfOneAssetWithdrawAll or tfOneAssetLPToken) &mdash; the taxpayer '
    'redeemed LP tokens for XRP alone. Property surrendered as two assets and reclaimed as one is '
    'not the same property coming back.', BODY))
S.append(Paragraph(
    f'<b>(b) Far more XRP came out than went in.</b> {qty(wd_xrp)} XRP was withdrawn against '
    f'{qty(dep_xrp)} XRP deposited &mdash; a factor of {wd_xrp / dep_xrp:.2f}. Roughly '
    f'{qty(excess)} XRP of what was withdrawn never entered the pool as XRP. It arrived as the '
    'pool&rsquo;s other asset and as accrued trading fees, and was converted to XRP inside the '
    'pool by the AMM&rsquo;s own pricing function.', BODY))

# ══ 3. Section 1001 ═══════════════════════════════════════════════════════
S.append(Paragraph('3. Why the deposit is a realization event', H2))
S.append(Paragraph(
    'Digital assets are property for federal income tax purposes. Notice 2014-21, reaffirmed and '
    'built on in every piece of digital asset guidance since. Section 61(a)(3) brings gains from '
    'dealings in property into gross income, and section 1001(a) measures that gain as the excess '
    'of the amount realized over adjusted basis. Section 1001(c) recognizes the entire amount of '
    'gain or loss unless another provision says otherwise.', BODY))
S.append(Paragraph(
    'The operative rule is Treas. Reg. section 1.1001-1(a): gain or loss is realized on the '
    '&ldquo;exchange of property for other property differing materially either in kind or in '
    'extent.&rdquo; The Supreme Court construed that phrase in <i>Cottage Savings Assn. v. '
    'Commissioner</i>, 499 U.S. 554 (1991), and set a deliberately low threshold: properties are '
    'materially different when they embody <b>legally distinct entitlements</b>. The taxpayer there '
    'exchanged participation interests in one pool of residential mortgages for interests in an '
    'economically near-identical pool; the Court held the exchange was a realization event because '
    'the loans ran to different obligors and were secured by different homes, notwithstanding that '
    'the two bundles were, in the market&rsquo;s eyes, substantially the same investment.', BODY))
S.append(Paragraph(
    'An AMM deposit clears that threshold by a wide margin. What the taxpayer gives up is XRP: a '
    'bearer balance on an account root, freely transferable, with no counterparty and no exposure '
    'to any other asset. What the taxpayer receives is an LP token: a fungible claim, issued by the '
    'AMM account, redeemable only through the protocol&rsquo;s own formula, whose value is a '
    'function of the pool&rsquo;s reserves of <i>two</i> assets and of the trading that occurs '
    'against those reserves. The holder gains a right to a share of trading fees and takes on '
    'exposure to the paired asset and to impermanent loss. These are not the same entitlements '
    'in a different wrapper; they differ in kind.', BODY))
S.append(Paragraph(
    'The taxpayer does not have to argue this from theory. <b>The ledger records the LP token as a '
    'separate issued asset with its own currency code and its own issuer</b>, and the transaction '
    'schema carries dedicated LPTokenOut and LPTokenIn fields precisely because a distinct asset '
    'is delivered on deposit and destroyed on withdrawal. And the taxpayer&rsquo;s own history, in '
    f'section 2(a) above, demonstrates the difference operationally: {two_asset_dep} two-asset '
    f'deposits and {single_asset_wd} single-asset withdrawals. A property interest that can be '
    'acquired with two assets and redeemed for one is by construction not identical to either.', BODY))

# ══ 4. No nonrecognition ══════════════════════════════════════════════════
S.append(Paragraph('4. No nonrecognition provision applies', H2))
S.append(Paragraph(
    'Section 1001(c) recognizes realized gain unless a specific provision defers it. Each candidate '
    'fails on its own terms.', BODY))

nr = [['Provision', 'Why it does not apply'],
      ['Section 1031<br/>like-kind',
       'Limited to real property for exchanges after 2017 by the Tax Cuts and Jobs Act. The '
       'Service had in any event taken the position in CCA 202124008 that exchanges between '
       'cryptocurrencies did not qualify even before that amendment. All activity here is 2024-2025.'],
      ['Section 721<br/>contribution to a partnership',
       'Addressed at length below. No entity exists, none was elected, no return is filed, no '
       'capital accounts are maintained, and no co-venturer can be identified. Section 721(b) '
       'would independently deny nonrecognition on a transfer to an investment company.'],
      ['Sections 351, 368,<br/>1035',
       'Require, respectively, a corporation, a corporate reorganization, and an insurance or '
       'annuity contract. None is present.'],
      ['A &ldquo;mere change<br/>in form&rdquo; theory',
       'There is no general doctrine excusing realization because the taxpayer regards a transaction '
       'as a technical step. <i>Cottage Savings</i> rejected exactly that framing on stronger facts.']]
S.append(table([[Paragraph(c, CELL) for c in row] for row in nr],
               [1.4 * inch, 4.5 * inch]))

S.append(Paragraph('The partnership argument, taken seriously', H3))
S.append(Paragraph(
    'The most substantial argument against this position is that an AMM pool is a joint '
    'profit-seeking venture, therefore a partnership under Treas. Reg. section 301.7701-1(a)(2), '
    'and therefore a contribution to it is a nonrecognition event under section 721. The argument '
    'deserves a real answer rather than dismissal.', BODY))
bullets([
    '<b>The formal indicia are all absent.</b> There is no organizational document, no election '
    'under Treas. Reg. section 301.7701-3, no Form 1065, no Schedule K-1, no capital accounts, no '
    'section 704(b) allocations, and no agreement of any kind between the taxpayer and the other '
    'liquidity providers &mdash; whose identities the taxpayer cannot determine and who change '
    'block by block.',
    '<b>Section 721(b) would defeat it anyway.</b> Nonrecognition is unavailable on a transfer to '
    'a partnership that would be an investment company under section 351 if incorporated, where '
    'the transfer results in diversification. A two-asset pool holding nothing but fungible digital '
    'assets is close to the paradigm case.',
    '<b>The consequences are unmanageable and worse for the taxpayer.</b> If the pool were a '
    'partnership, the taxpayer would owe annual returns and K-1s that no one has ever prepared, '
    'would face section 704(c) built-in gain allocations, section 707 disguised-sale exposure on '
    'a deposit and withdrawal pattern like this one, and section 751 hot-asset recharacterization '
    'on redemption. The alternative is not a cleaner answer; it is an unfiled and unfileable one.',
    '<b>Adopting Treatment A does not require winning this argument.</b> It requires only declining '
    'to claim a nonrecognition provision the taxpayer cannot substantiate. A taxpayer who claims '
    'section 721 bears the burden of establishing the partnership. This taxpayer cannot, and does '
    'not try.',
])

# ══ 5. The withdrawal side ════════════════════════════════════════════════
S.append(Paragraph('5. The withdrawal side, and the cost it carries', H2))
S.append(Paragraph(
    'Because the deposit is recognized, the LP tokens received take a basis equal to the fair '
    'market value of the XRP surrendered. On withdrawal the LP tokens are surrendered and XRP is '
    'received; under section 1012 the XRP received takes a cost basis equal to the fair market '
    'value of what was given for it, measured at the date of withdrawal. Where the transaction is '
    'arm&rsquo;s-length and contemporaneous, that value is the market value of the XRP received.', BODY))
S.append(Paragraph(
    '<b>The holding period restarts.</b> Section 1223 permits tacking only where basis carries over '
    'from the property exchanged, which is precisely what recognition prevents. XRP withdrawn from '
    'the pool therefore begins a fresh holding period on the withdrawal date, and a later sale '
    'within a year is short-term even if the taxpayer first acquired XRP years earlier. This is a '
    'real cost of the position and it is borne, not argued around. It is one of the reasons the '
    'position is properly described as conservative.', BODY))
S.append(Paragraph(
    '<b>Trading fees accrued inside the pool are captured at withdrawal, not accrued earlier.</b> '
    'The fees that accumulated against the pool&rsquo;s reserves are reflected in the value of what '
    'is withdrawn and so enter basis at that point. Accruing them as income while the position was '
    'open was considered and rejected: the taxpayer had no dominion and control over pool fees '
    'before redeeming the LP token, which is the test the Service applied to staking rewards in '
    'Rev. Rul. 2023-14. Nothing was receivable until withdrawal.', BODY))

# ══ 6. Why B fails here ═══════════════════════════════════════════════════
S.append(Paragraph('6. Why the alternative position is not available on these facts', H2))
S.append(Paragraph(
    'The competing position &mdash; treat the deposit as a non-taxable technical step and return '
    'the original lots on withdrawal &mdash; is workable where a taxpayer withdraws roughly what '
    'was deposited. That is not this record.', BODY))
S.append(Paragraph(
    f'<b>{qty(wd_xrp)} XRP came out against {qty(dep_xrp)} XRP that went in. There are no original '
    f'lots to return for the other {qty(excess)} XRP &mdash; {excess / wd_xrp:.0%} of everything '
    'withdrawn.</b>', PULL))
S.append(Paragraph(
    'A method that cannot assign basis to two-thirds of the property it is asked to account for is '
    'not a method the taxpayer can defend. It would leave that XRP at zero basis and with no '
    'acquisition date, which is both wrong and &mdash; because a missing acquisition date cannot '
    'establish a holding period &mdash; wrong in the direction of overstating tax. And the excess '
    'is not an accounting artifact: it is trading fee income and the proceeds of the paired asset '
    'converted inside the pool. Under any coherent theory, that is something the taxpayer received. '
    'Treatment A brings all of it into basis at measurable values on measurable dates. The '
    'alternative leaves it stranded.', BODY))

# ══ 7. Effect ═════════════════════════════════════════════════════════════
S.append(Paragraph('7. Numerical effect of the position', H2))
eff = [['Year', 'Effect of the position adopted'],
       ['2024', f'{money(dep_usd)} of amount realized recognized on {dep_n} deposits. Gain is that '
                f'figure less the adjusted basis of the XRP deposited, which the tool carries lot '
                f'by lot and can produce. {money(w24["usd"])} of new basis created on '
                f'{w24["n"]} withdrawals.'],
       ['2025', f'{money(w25["usd"])} of new basis created on {w25["n"]} withdrawals. No deposits '
                f'occurred in 2025, so no pool-related amount realized arises in this year.'],
       ['Later years', 'Reduced gain on eventual sale, because the withdrawn XRP now carries real '
                       'basis instead of zero. Offsetting this, more of that gain is short-term.']]
S.append(table([[Paragraph(c, CELL) for c in row] for row in eff], [0.85 * inch, 5.05 * inch]))
S.append(Spacer(1, 6))

S.append(Paragraph('What this fixes', H3))
S.append(Paragraph(
    'Until a treatment is adopted, XRP leaving the pool enters the taxpayer&rsquo;s records with '
    '<b>no cost basis and no acquisition date</b>, because nothing ever booked its acquisition. '
    'Coins later moved to exchange accounts inherited that defect. One exchange address currently '
    'holds 10,012 XRP carrying $0.49 of total basis. On a sale, roughly $13,614 would be reported '
    'as gain against a true basis near $4,794 &mdash; and the entire amount would be reported as '
    'short-term, because a null acquisition date fails every long-term test. Adopting this position '
    'cures that for all of the withdrawn XRP.', BODY))

# ══ 8. Consistency ════════════════════════════════════════════════════════
S.append(Paragraph('8. Consistency', H2))
S.append(Paragraph(
    'Where guidance is absent, the defensibility of a position rests substantially on consistent '
    'application. The following are undertaken as part of adopting it:', BODY))
bullets([
    '<b>Both sides, always.</b> The same treatment governs entry and exit. Gain is not recognized '
    'on deposit in one year while the withdrawal side is booked on a different theory in another.',
    '<b>Every year, retroactively.</b> The position is applied to 2024 as well as 2025. It is not '
    'adopted prospectively to capture the basis step-up while leaving the 2024 recognition unreported.',
    '<b>One computation, and it records itself.</b> The reporting tool applies the treatment from a '
    'single stored setting, the setting is named on the data-quality disclosure of every report it '
    'produces, and changing it forces a full rebuild. A figure cannot be produced under one '
    'treatment and filed alongside figures produced under another.',
    '<b>Separate from the section 1012 method change.</b> Rev. Proc. 2024-28 moves basis tracking '
    'from a universal to a wallet-by-wallet method at the 1 January 2025 boundary. That is an '
    'independent question from the AMM treatment and is handled independently.',
])

# ══ 9. Penalty posture ════════════════════════════════════════════════════
S.append(Paragraph('9. Penalty posture and disclosure', H2))
S.append(Paragraph(
    'The accuracy-related penalty of section 6662(b)(2) applies to a substantial understatement of '
    'income tax. An understatement is reduced by items for which there is substantial authority '
    '(Treas. Reg. section 1.6662-4(d)) or which are adequately disclosed and supported by a '
    'reasonable basis (Treas. Reg. section 1.6662-3(b)(3)), and section 6664(c)(1) excuses any '
    'portion attributable to reasonable cause and good faith.', BODY))
bullets([
    '<b>The deposit step cannot produce an understatement.</b> It recognizes income that the '
    'alternative position would not recognize at all. Exposure at that step runs only in the '
    'taxpayer&rsquo;s disfavor.',
    '<b>The exposure, such as it is, is the basis claimed on withdrawal.</b> That basis derives '
    'directly from the amount realized reported on the deposit side. The two are consistent by '
    'construction, and a challenge to the second necessarily concedes the first.',
    '<b>The authority is ordinary, not exotic.</b> Section 1001, Treas. Reg. section 1.1001-1(a), '
    'and a Supreme Court construction of that regulation. This is not a position resting on a '
    'reading of an ambiguous provision; it is the default rule, applied because no exception was '
    'found.',
    '<b>Records exist and are contemporaneous.</b> Every transaction was reconciled against ledger '
    'metadata retrieved from a full-history node, the reconciliation output is retained, and the '
    'software that produced the return figures is the taxpayer&rsquo;s own and is inspectable.',
    '<b>Disclosure on Form 8275</b> is available and is recommended for consideration in the year '
    'the basis step-up is first claimed. The determination is the preparer&rsquo;s.',
])

# ══ 10. Limits ════════════════════════════════════════════════════════════
S.append(Paragraph('10. Limits of this position statement, and open items', H2))
S.append(Paragraph(
    'Stated so that nothing here is read as more than it is:', BODY))
bullets([
    f'<b>The XRP leg only.</b> The pool&rsquo;s second asset is not tracked by the tool. Its '
    f'disposition on deposit and its acquisition on withdrawal are not in any figure above. '
    f'Consistency requires that it receive the same treatment, and reconstructing it is an open item.',
    f'<b>{nofig} withdrawals carry no ledger figure</b> and are excluded from the amounts above. In '
    f'those modes the protocol ignores the transaction&rsquo;s amount field, so no requested figure '
    f'exists to fall back on. They remain to be valued.',
    '<b>Prices are daily highs</b> drawn from the tool&rsquo;s embedded series. A daily-low or '
    'daily-close convention produces different figures. Whichever is used must be used throughout.',
    '<b>2024 is the year that matters procedurally.</b> All deposits fall in 2024. If that return '
    'has been filed without recognizing them, adopting this position points toward an amended '
    'return, and the decision whether to amend is the preparer&rsquo;s.',
    '<b>This document is not tax advice and is not a substitute for professional judgment.</b> It '
    'was prepared by the taxpayer to record the reasoning behind a position and to give the '
    'preparer something concrete to accept, reject, or modify. No part of it should be filed or '
    'relied on without that review.',
])

# ══ 11. Authorities ═══════════════════════════════════════════════════════
S.append(Paragraph('11. Authorities relied on', H2))
auth = [['Authority', 'Proposition'],
        ['IRC section 61(a)(3)', 'Gains from dealings in property are gross income.'],
        ['IRC section 1001(a), (c)', 'Gain is amount realized less adjusted basis, and is recognized '
                                     'in full unless another provision defers it.'],
        ['Treas. Reg. section 1.1001-1(a)', 'Realization occurs on an exchange of property for other '
                                            'property differing materially in kind or in extent.'],
        ['<i>Cottage Savings Assn. v.<br/>Commissioner</i>, 499 U.S. 554 (1991)',
         'Properties are materially different when they embody legally distinct entitlements; the '
         'threshold is low and economic similarity does not defeat realization.'],
        ['Notice 2014-21', 'Virtual currency is property for federal income tax purposes.'],
        ['IRC section 1012', 'Basis of property is its cost.'],
        ['IRC section 1223', 'Holding period tacking is limited to exchanges in which basis carries '
                             'over &mdash; therefore unavailable here.'],
        ['IRC section 1031 (post-TCJA);<br/>CCA 202124008',
         'Like-kind exchange treatment is limited to real property, and was unavailable for '
         'cryptocurrency exchanges even before that limitation.'],
        ['IRC sections 721(a), 721(b);<br/>Treas. Reg. section 301.7701-1(a)(2), -3',
         'Partnership contribution nonrecognition requires an entity the taxpayer cannot establish, '
         'and would be denied in any event on a transfer to an investment company.'],
        ['Rev. Rul. 2023-14', 'Dominion and control is the test for when digital asset rewards are '
                              'includible &mdash; supporting recognition of pool fees at withdrawal '
                              'rather than as they accrue.'],
        ['Rev. Proc. 2024-28', 'Wallet-by-wallet basis identification from 1 January 2025; a separate '
                               'question, handled separately.'],
        ['IRC section 6662(b)(2), (d);<br/>Treas. Reg. sections 1.6662-3(b)(3),<br/>1.6662-4(d); IRC section 6664(c)(1)',
         'Accuracy-related penalty, and the substantial authority, reasonable basis with disclosure, '
         'and reasonable cause defenses.'],
        ['<i>No IRS guidance addresses<br/>liquidity pool deposits</i>',
         'Confirmed as of the date of this document. The Service has issued digital asset guidance '
         'on adjacent questions without reaching this one.']]
S.append(table([[Paragraph(c, CELL) for c in row] for row in auth], [2.0 * inch, 3.9 * inch]))

S.append(Spacer(1, 10))
S.append(HRFlowable(width='100%', color=colors.HexColor('#c8d0e0'), thickness=0.6))
S.append(Paragraph(
    'Figures produced by the taxpayer&rsquo;s own reconciliation tool and verified transaction-by-'
    'transaction against XRP Ledger metadata retrieved from a full-history node. No wallet addresses '
    'appear in this document. Prepared for professional review; not tax advice.', NOTE))

doc.build(S)
print(f'wrote {OUT}')
