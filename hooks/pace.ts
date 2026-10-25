// Pure math of limit-pace: API-dollar value of each recorded model call, the steps of the weekly
// percent, the price of 1%, its accuracy, the pace and the two tables. No engine calls here.

// A recorded call: [time ms, model, input, output, cache write, cache read, weekly %, 5-hour %]
// The two percents are what the response of that very call reported (null when it reported none).
export type Row = [number, string, number, number, number, number, number | null, number | null]

export type Limits = { weekResetsAt?: number; fiveHourResetsAt?: number; week?: number; fiveHour?: number }

const HOUR = 3600e3
const WEEK = 7 * 24 * HOUR

// $ per million tokens: input, output, cache write, cache read. Cache writes are priced at the TTL
// Claude Code uses for the family: one hour for Opus, Fable and Haiku, five minutes for Sonnet.
const PRICES: [RegExp, number[]][] = [
  [/fable/, [10, 50, 20, 0.25]],
  [/opus-4/, [5, 25, 10, 0.5]],
  [/opus/, [4, 20, 8, 0.2]],
  [/sonnet/, [2, 10, 2.5, 0.1]],
  [/haiku/, [0.1, 0.5, 0.2, 0.01]],
]

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export const family = (model: string) => FAMILIES.find(f => model.includes(f)) ?? 'other'
const title = (f: string) => f.charAt(0).toUpperCase() + f.slice(1)

export type Cost = {
  usd: number; $in: number; $out: number; $cw: number; $cr: number; cr: number; cw: number; out: number; calls: number
  byFamily: Record<string, number>
}

export const zero = (): Cost => ({ usd: 0, $in: 0, $out: 0, $cw: 0, $cr: 0, cr: 0, cw: 0, out: 0, calls: 0, byFamily: {} })

export function price(model: string, context: number): number[] {
  const p = (PRICES.find(([re]) => re.test(model)) ?? PRICES[2]!)[1]
  return /haiku/.test(model) && context > 100e3 ? p.map(x => x * 5) : p
}

export function add(c: Cost, r: Row): Cost {
  const [, model, i, o, cw, cr] = r
  const [pi = 0, po = 0, pw = 0, pr = 0] = price(model, i + cw + cr)
  const $in = (i * pi) / 1e6, $out = (o * po) / 1e6, $cw = (cw * pw) / 1e6, $cr = (cr * pr) / 1e6
  const usd = $in + $out + $cw + $cr
  c.$in += $in; c.$out += $out; c.$cw += $cw; c.$cr += $cr; c.usd += usd
  c.cr += cr; c.cw += cw; c.out += o; c.calls++
  const f = family(model)
  c.byFamily[f] = (c.byFamily[f] ?? 0) + usd
  return c
}

// The family that took at least 90% of a step's dollars, else null. The limit charges model families
// differently per API dollar, so only a one-family step measures the price of 1% for that family.
export function dominant(c: Cost): string | null {
  for (const [f, usd] of Object.entries(c.byFamily)) if (c.usd > 0 && usd / c.usd >= 0.9) return f
  return null
}

export type Step = { a: number; b: number; t0: number; t1: number; cost: Cost; family: string | null; clean: boolean }

// The weekly percent's steps: a call belongs to the step that the next higher reading closes.
// A step a→b runs from the call that last read a to the call that first read b.
export function steps(rows: Row[], from: number, to: number): Step[] {
  const out: Step[] = []
  let cost = zero(), w: number | null = null, t0 = from
  for (const r of rows) {
    if (r[0] < from || r[0] >= to) continue
    const now = r[6] == null ? null : Math.floor(r[6])
    if (w != null && now != null && now > w) {
      const fam = dominant(cost)
      out.push({ a: w, b: now, t0, t1: r[0], cost, family: fam, clean: now - w === 1 && fam != null })
      cost = zero(); t0 = r[0]
    }
    if (now != null && (w == null || now > w)) w = now
    add(cost, r)
  }
  return out
}

export type Span = { k: number; a: number; b: number; t0: number; t1: number; perPct: number; stat: number; diff: number | null; verdict: string }

// Price of 1% over the last k clean steps. Each step's two boundaries are exact, so its sum is exact;
// the meter books usage in bursts, so one step is off by about ±40% of a step's price and a k-step
// average by about ±40%/k. Another ±10% is systematic: API dollars are our ruler, the meter may weigh
// token kinds otherwise.
export function spans(list: Step[], norm: number | null): Span[] {
  const out: Span[] = []
  for (const k of [1, 3, 5, 10]) {
    if (list.length < k) continue
    const sp = list.slice(-k)
    const pp = sp.reduce((s, x) => s + x.b - x.a, 0)
    const perPct = sp.reduce((s, x) => s + x.cost.usd, 0) / pp
    const stat = (perPct * 0.4) / k
    const diff = norm ? perPct / norm - 1 : null
    const band = 0.4 / k + 0.1
    const verdict = k === 1 ? 'one percent proves nothing'
      : diff == null ? 'no earlier weeks to compare'
      : Math.abs(diff) > band ? (diff > 0 ? 'clearly above' : 'clearly below') : 'within noise'
    const first = sp[0]!, last = sp[sp.length - 1]!
    out.push({ k, a: first.a, b: last.b, t0: first.t0, t1: last.t1, perPct, stat, diff, verdict })
  }
  return out
}

function invert(A: number[][]): number[][] | null {
  const n = A.length
  const M = A.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r
    if (Math.abs(M[p]![c]!) < 1e-12) return null
    ;[M[c], M[p]] = [M[p]!, M[c]!]
    const row = M[c]!, d = row[c]!
    for (let j = 0; j < 2 * n; j++) row[j]! /= d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const other = M[r]!, k = other[c]!
      for (let j = 0; j < 2 * n; j++) other[j]! -= k * row[j]!
    }
  }
  return M.map(row => row.slice(n))
}

export type FamilyPrice = { family: string; perPct: number; rel: number; steps: number; usd: number }

// The price of 1% for every model family from all steps, mixed ones included: each step is an
// equation "percent gained = Σ family dollars / family price", solved together by least squares.
// A family counts once it holds ≥10% of the dollars in at least two steps; a family whose
// coefficient comes out negative (too little data) is dropped. The error is the coefficient's
// standard error from the spread of the residuals.
export function fitPrices(list: Step[]): FamilyPrice[] {
  const share = (x: Step, f: string) => (x.cost.usd > 0 ? (x.cost.byFamily[f] ?? 0) / x.cost.usd : 0)
  let fams: string[] = [...FAMILIES, 'other'].filter(f => list.filter(x => share(x, f) >= 0.1).length >= 2)
  while (fams.length) {
    const p = fams.length, n = list.length
    if (n <= p) return []
    const A = fams.map(() => Array<number>(p).fill(0)), bv = Array<number>(p).fill(0)
    for (const x of list) {
      const v = fams.map(f => x.cost.byFamily[f] ?? 0), y = x.b - x.a
      for (let i = 0; i < p; i++) {
        bv[i]! += v[i]! * y
        for (let j = 0; j < p; j++) A[i]![j]! += v[i]! * v[j]!
      }
    }
    const inv = invert(A)
    if (!inv) return []
    const beta = inv.map(row => row.reduce((s, a, j) => s + a * bv[j]!, 0))
    const neg = beta.findIndex(b => b <= 0)
    if (neg >= 0) { fams = fams.filter((_, i) => i !== neg); continue }
    let rss = 0
    for (const x of list) rss += (x.b - x.a - fams.reduce((s, f, i) => s + (x.cost.byFamily[f] ?? 0) * beta[i]!, 0)) ** 2
    const s2 = rss / (n - p)
    return fams.map((f, i) => ({
      family: f, perPct: 1 / beta[i]!, rel: Math.sqrt(s2 * inv[i]![i]!) / beta[i]!,
      steps: list.filter(x => share(x, f) >= 0.1).length,
      usd: list.reduce((s, x) => s + (x.cost.byFamily[f] ?? 0), 0),
    }))
  }
  return []
}

const money = (x: number | null | undefined) => x == null || !isFinite(x) ? '—' : '$' + (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2))
const mt = (x: number) => (x / 1e6).toFixed(2) + 'M'
const pct = (x: number | null) => x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%'
const when = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// a step's model mix when it is not all one family: "Sonnet 88%"
function mix(x: Step, main: string | null) {
  if (x.family === main) return ''
  const [f, usd] = Object.entries(x.cost.byFamily).sort((p, q) => q[1] - p[1]).find(([g]) => g !== main) ?? ['other', 0]
  return ` (${title(f)} ${((usd / (x.cost.usd || 1)) * 100).toFixed(0)}%)`
}

export type Report = { short: string; full: string; status: string }

export function report(rows: Row[], lim: Limits, now: number): Report {
  rows = [...rows].sort((x, y) => x[0] - y[0])
  const reset = lim.weekResetsAt ?? now + WEEK
  const ws = reset - WEEK
  const cur = steps(rows, ws, reset)
  const before = [...steps(rows, ws - 2 * WEEK, ws - WEEK), ...steps(rows, ws - WEEK, ws)].filter(s => s.clean)

  // the family most clean steps measure lately: its price is the one shown
  const recent = [...before, ...cur.filter(s => s.clean)].slice(-10)
  const counts = new Map<string, number>()
  for (const s of recent) if (s.family) counts.set(s.family, (counts.get(s.family) ?? 0) + 1)
  const main = [...counts].sort((p, q) => q[1] - p[1])[0]?.[0] ?? null
  const good = cur.filter(s => s.clean && s.family === main)
  const prev = before.filter(s => s.family === main)
  const norm = prev.length >= 5 ? prev.reduce((s, x) => s + x.cost.usd, 0) / prev.length : null
  const sp = spans(good, norm)
  const fresh = sp.find(s => s.k === 5) ?? sp.find(s => s.k === 3) ?? sp.find(s => s.k === 10)
  const perPct = fresh?.perPct ?? norm

  // the weekly percent as a whole number: a percent just begun says nothing yet
  const w = Math.floor(lim.week ?? rows[rows.length - 1]?.[6] ?? 0)
  const week = zero(), fh = zero()
  const fhStart = lim.fiveHourResetsAt ? lim.fiveHourResetsAt - 5 * HOUR : now
  for (const r of rows) {
    if (r[0] >= ws && r[0] <= now) add(week, r)
    if (r[0] >= fhStart && r[0] <= now) add(fh, r)
  }
  const left = perPct ? (100 - w) * perPct : null
  const resetIn = (reset - now) / HOUR

  // pace: how far the meter itself moved over the last day, breaks and sleep included
  const dayFrom = Math.max(ws, now - 24 * HOUR)
  let wDay = 0
  for (const r of rows) { if (r[0] < ws || r[6] == null) continue; if (r[0] > dayFrom) break; wDay = Math.floor(r[6]) }
  const hrsDay = (now - dayFrom) / HOUR, perHour = hrsDay > 1 ? (w - wDay) / hrsDay : 0
  const span = hrsDay >= 23.5 ? 'over the last day' : `over ${hrsDay.toFixed(0)} h since the reset`

  const S: string[] = ['| | |', '|---|---|']
  let status = `week ${w}%`
  if (perHour > 0) {
    const hrs = (100 - w) / perHour
    S.push(hrs >= resetIn
      ? `| **At this pace** | **enough**: +${w - wDay}% ${span} (${perHour.toFixed(2)}%/h), 100% would take ${hrs.toFixed(0)} h, reset in ${resetIn.toFixed(0)} h |`
      : `| **At this pace** | **runs out**: +${w - wDay}% ${span} (${perHour.toFixed(2)}%/h), 100% at ${when(now + hrs * HOUR)}, ${(resetIn - hrs).toFixed(0)} h before reset |`)
    status += hrs >= resetIn ? ' · enough to reset' : ` · out ${when(now + hrs * HOUR)}`
  }
  S.push(`| Week | **${w}%** · resets ${when(reset)}, in ${resetIn.toFixed(0)} h |`)
  const of = main ? ` (${title(main)})` : ''
  if (fresh) S.push(`| 1% of the week${of} | **${money(fresh.perPct)}** (last ${fresh.k} clean) · ${pct(fresh.diff)} vs your earlier weeks (${money(norm)}) · ${fresh.verdict} |`)
  else S.push(`| 1% of the week${of} | not enough clean percents yet${norm ? `; earlier weeks ${money(norm)}` : ''} |`)
  S.push(`| Last percents | ${cur.slice(-3).map(x => `${x.a}→${x.b} ${money(x.cost.usd)}${mix(x, main)}`).join(' · ') || '—'} |`)
  // every family's price, from all of this week's steps
  const fitNow = fitPrices(cur)
  const fitPrev = fitPrices([...steps(rows, ws - 2 * WEEK, ws - WEEK), ...steps(rows, ws - WEEK, ws)])
  const base = fitNow.find(x => x.family === main) ?? fitNow[0]
  const vs = (x: FamilyPrice, b?: FamilyPrice) => (b && x.family !== b.family ? ` (a dollar costs ×${(b.perPct / x.perPct).toFixed(1)} of ${title(b.family)}'s)` : '')
  if (fitNow.length) S.push(`| 1% by model (whole week) | ${fitNow.map(x => `${title(x.family)} ${money(x.perPct)} ±${(x.rel * 100).toFixed(0)}%${vs(x, base)}`).join(' · ')} |`)
  if (lim.fiveHour != null) S.push(`| 5-hour window | ${lim.fiveHour}%${lim.fiveHour ? ` · ${money(fh.usd / lim.fiveHour)} per 1%` : ''}${lim.fiveHourResetsAt ? ` · resets ${clock(lim.fiveHourResetsAt)}` : ''} |`)
  S.push(`| Spent / left | ${money(week.usd)} this week · ≈${money(left)} left at ${money(perPct)} per 1%${of} |`)
  if (fresh) status += ` · ${money(fresh.perPct)}/1%`

  const F: string[] = [...S, '', '## Every percent this week', '',
    '| Step | Closed | Took | $ | Cache read | Cache write | Output | Calls | |', '|---|---|---|---|---|---|---|---|---|']
  for (const x of cur) {
    const c = x.cost
    const note = x.b - x.a > 1 ? `jumped ${x.b - x.a}%` : x.family == null ? `mixed:${mix(x, null)}` : x.family !== main ? `${title(x.family)} only` : ''
    F.push(`| ${x.a}→${x.b} | ${clock(x.t1)} | ${((x.t1 - x.t0) / 60e3).toFixed(0)} min | ${money(c.usd)} | ${mt(c.cr)} · ${money(c.$cr)} | ${mt(c.cw)} · ${money(c.$cw)} | ${mt(c.out)} · ${money(c.$out)} | ${c.calls} | ${note} |`)
  }
  if (fitNow.length || fitPrev.length) {
    const basePrev = fitPrev.find(x => x.family === main) ?? fitPrev[0]
    F.push('', '## Price of 1% by model', '',
      '| Model | $ per 1% this week | Error | Steps with it | Its dollars | Two earlier weeks | vs earlier | A dollar costs, vs main |', '|---|---|---|---|---|---|---|---|')
    for (const x of fitNow) {
      const pv = fitPrev.find(y => y.family === x.family)
      const d = pv ? x.perPct / pv.perPct - 1 : null
      F.push(`| ${title(x.family)} | **${money(x.perPct)}** | ±${(x.rel * 100).toFixed(0)}% | ${x.steps} | ${money(x.usd)} | ${pv ? `${money(pv.perPct)} ±${(pv.rel * 100).toFixed(0)}%` : '—'} | ${pct(d)} | ${base && x.family !== base.family ? `×${(base.perPct / x.perPct).toFixed(2)}` : '—'} |`)
    }
    for (const x of fitPrev) if (!fitNow.some(y => y.family === x.family))
      F.push(`| ${title(x.family)} | too little this week | — | — | — | ${money(x.perPct)} ±${(x.rel * 100).toFixed(0)}% | — | ${basePrev && x.family !== basePrev.family ? `×${(basePrev.perPct / x.perPct).toFixed(2)} (earlier weeks)` : '—'} |`)
    F.push('', 'Every step of the week, mixed ones too, is an equation "percent gained = Σ the model\'s dollars / its price of 1%", solved over all steps at once (least squares). A model is fitted once it holds ≥10% of the dollars in at least two steps. "A dollar costs" says how many times more limit one API dollar of that model takes than one of your main model.')
  }
  F.push('', '## Accuracy', '', `| Last clean | Span | $ per 1% | Error | vs earlier weeks | Verdict |`, '|---|---|---|---|---|---|')
  for (const s of sp) F.push(`| ${s.k} | ${s.a}→${s.b}%, ${when(s.t0)} – ${when(s.t1)} | ${money(s.perPct)} | ±${money(s.stat)} and ±10% | ${pct(s.diff)} | ${s.verdict} |`)
  F.push('',
    `Clean percents only: exactly +1%, at least 90% of the dollars on one model family${main ? ` (${title(main)} here)` : ''}. The limit charges families differently per API dollar, so a step mixing Opus and Sonnet measures neither.`,
    '"Clearly" means the gap is bigger than the error: ±40%/k from the meter booking usage in bursts, plus ±10% because API dollars are only our ruler (about 18% at k=5, 14% at k=10).',
    'The pace is how far the weekly percent itself moved over the last day, so breaks and sleep count; a percent just begun is not counted.',
    'Dollars count only the Claude Code sessions on this computer where limit-pace runs. Other computers, claude.ai chats, Cowork and Claude Code on the web move the percent but not these dollars: if they were busy, 1% looks cheaper here than it is.',
    'Prices are public API list prices per million tokens; cache writes at the one-hour rate for Opus, Fable and Haiku, five-minute rate for Sonnet.')
  return { short: S.join('\n'), full: F.join('\n'), status }
}
