// Pure math of limit-pace: API-dollar value of each recorded model call, the steps of the weekly
// percent, the price of 1% in Opus 5.5 dollars, its accuracy, the pace and the two tables. No engine calls here.

// A recorded call: [time ms, model, input, output, cache write, cache read, weekly %, 5-hour %, subagent]
// The two percents are what the response of that very call reported (null when it reported none).
// subagent: 1 for a subagent's call (its cache writes live five minutes), 0 for the main thread's
// (one hour); absent in rows recorded before 1.2.0. A stored row may be several calls merged: the last
// field counts them.
export type Row = [number, string, number, number, number, number, number | null, number | null, (0 | 1)?, number?]

export type Limits = { weekResetsAt?: number; fiveHourResetsAt?: number; week?: number; fiveHour?: number }

const HOUR = 3600e3
const MERGE_MS = 10 * 60e3
const WEEK = 7 * 24 * HOUR

// $ per million tokens: input, output, cache write 5 min, cache write 1 h, cache read
const PRICES: [RegExp, number[]][] = [
  [/fable/, [10, 50, 12.5, 20, 0.25]],
  [/opus-4/, [5, 25, 6.25, 10, 0.5]],
  [/opus/, [4, 20, 5, 8, 0.2]],
  [/sonnet-4/, [3, 15, 3.75, 6, 0.3]],
  [/sonnet/, [2, 10, 2.5, 4, 0.1]],
  [/haiku-4/, [1, 5, 1.25, 2, 0.1]],
  [/haiku/, [0.1, 0.5, 0.125, 0.2, 0.01]],
]

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export const family = (model: string) => FAMILIES.find(f => model.includes(f)) ?? 'other'
const title = (f: string) => f.charAt(0).toUpperCase() + f.slice(1)

// How many Opus 5.5 dollars one API dollar of each family is worth in limit, measured over 147 clean
// percents of one Max account (7–19 Oct 2026). Used until your own steps fit the weights more tightly.
export const DEFAULT_WEIGHTS: Record<string, number> = { opus: 1, sonnet: 1.44, fable: 2.3, haiku: 1.44, other: 1 }
export type Weights = Record<string, number>

export type Cost = {
  usd: number; $in: number; $out: number; $cw: number; $cr: number; cr: number; cw: number; out: number; calls: number
  byFamily: Record<string, number>
}

export const zero = (): Cost => ({ usd: 0, $in: 0, $out: 0, $cw: 0, $cr: 0, cr: 0, cw: 0, out: 0, calls: 0, byFamily: {} })

export function price(model: string, context: number): number[] {
  const p = (PRICES.find(([re]) => re.test(model)) ?? PRICES[2]!)[1]
  return /haiku-5/.test(model) && context > 100e3 ? p.map(x => x * 5) : p
}

export function add(c: Cost, r: Row): Cost {
  const [, model, i, o, cw, cr, , , sub] = r
  const [pi = 0, po = 0, pw5 = 0, pw1 = 0, pr = 0] = price(model, i + cw + cr)
  // Claude Code caches the main thread for an hour and subagents for five minutes; rows from before
  // the flag existed take the family's usual TTL (Sonnet runs mostly as a subagent)
  const pw = (sub ?? (/sonnet/.test(model) ? 1 : 0)) ? pw5 : pw1
  const $in = (i * pi) / 1e6, $out = (o * po) / 1e6, $cw = (cw * pw) / 1e6, $cr = (cr * pr) / 1e6
  const usd = $in + $out + $cw + $cr
  c.$in += $in; c.$out += $out; c.$cw += $cw; c.$cr += $cr; c.usd += usd
  c.cr += cr; c.cw += cw; c.out += o; c.calls += r[9] ?? 1
  const f = family(model)
  c.byFamily[f] = (c.byFamily[f] ?? 0) + usd
  return c
}

// a cost in Opus 5.5 dollars: each family's API dollars times its weight
export const opus = (c: Cost, W: Weights) => Object.entries(c.byFamily).reduce((s, [f, usd]) => s + usd * (W[f] ?? 1), 0)

// The family that took at least 90% of a step's dollars, else null (shown, not used to filter)
export function dominant(c: Cost): string | null {
  for (const [f, usd] of Object.entries(c.byFamily)) if (c.usd > 0 && usd / c.usd >= 0.9) return f
  return null
}

export type Step = { a: number; b: number; t0: number; t1: number; cost: Cost; family: string | null; clean: boolean; partial: boolean }

// The weekly percent's steps: a call belongs to the step that the next higher reading closes.
// A step a→b runs from the call that first read a to the call that first read b. The first step
// of the data is partial when it starts above 0%: part of that percent was used before recording began.
export function steps(rows: Row[], from: number, to: number): Step[] {
  const out: Step[] = []
  let cost = zero(), w: number | null = null, t0 = from, first = true
  for (const r of rows) {
    if (r[0] < from || r[0] >= to) continue
    const now = r[6] == null ? null : Math.floor(r[6])
    // a reading well below the level so far: the earlier ones were the previous week's, still reported
    // just after the reset. Start over from this one. (A reading one or two below is a slow response's
    // older figure and changes nothing.)
    if (w != null && now != null && now < w - 2) { w = now; t0 = r[0]; first = true }
    if (w != null && now != null && now > w) {
      const partial = first && w > 0
      out.push({ a: w, b: now, t0, t1: r[0], cost, family: dominant(cost), clean: now - w === 1 && !partial, partial })
      cost = zero(); t0 = r[0]; first = false
    }
    if (now != null && (w == null || now > w)) w = now
    add(cost, r)
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
// standard error from the spread of the residuals. Partial steps stay out.
export function fitPrices(all: Step[]): FamilyPrice[] {
  const list = all.filter(x => !x.partial)
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

// Weights from your own steps where they fit tightly (Opus within ±15%, the family within ±25%,
// at least five steps with it), the measured defaults elsewhere.
export function weights(list: Step[]): { W: Weights; own: string[] } {
  const fit = fitPrices(list), o = fit.find(x => x.family === 'opus')
  const W = { ...DEFAULT_WEIGHTS }, own: string[] = []
  if (o && o.rel < 0.15) for (const x of fit) if (x.family !== 'opus' && x.rel < 0.25 && x.steps >= 5) { W[x.family] = o.perPct / x.perPct; own.push(x.family) }
  return { W, own }
}

// How much an average over k clean percents in a row wanders while the limit stays the same. It falls
// far slower than 1/k: usage the plugin does not see and the meter's own bursts move it. Measured on
// your earlier weeks once they hold enough windows; until then the spread of one Max account (7–19 Oct 2026).
const DEFAULT_SPREAD: Record<number, number> = { 1: 0.29, 2: 0.24, 3: 0.19, 5: 0.14, 10: 0.11, 20: 0.09 }
export type Spread = { sigma: (k: number) => number; own: boolean }

export function spread(list: Step[], W: Weights): Spread {
  const runs: Step[][] = []
  let run: Step[] = []
  for (const x of list) {
    if (x.clean && (!run.length || x.t0 === run[run.length - 1]!.t1)) run.push(x)
    else { runs.push(run); run = x.clean ? [x] : [] }
  }
  runs.push(run)
  const own: Record<number, number> = {}
  for (const k of Object.keys(DEFAULT_SPREAD).map(Number)) {
    const v: number[] = []
    for (const r of runs) for (let i = 0; i + k <= r.length; i += k) v.push(r.slice(i, i + k).reduce((s, x) => s + opus(x.cost, W), 0) / k)
    if (v.length < 8) continue
    const m = v.reduce((s, x) => s + x, 0) / v.length
    if (m > 0) own[k] = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)) / m
  }
  const table = Object.keys(own).length >= 3 ? own : DEFAULT_SPREAD
  // between and past the measured k: σ1·k^−b through the table's first and last points
  const ks = Object.keys(table).map(Number).sort((p, q) => p - q)
  const k0 = ks[0]!, k1 = ks[ks.length - 1]!, s0 = table[k0]!, s1 = table[k1]!
  const b = k1 > k0 ? Math.log(s0 / s1) / Math.log(k1 / k0) : 0.4
  return { sigma: k => table[k] ?? s0 * (k / k0) ** -b, own: table === own }
}

export type Span = { k: number; a: number; b: number; t0: number; t1: number; perPct: number; sigma: number; diff: number | null; verdict: string }

// Price of 1% in Opus 5.5 dollars over the last k clean steps, against your earlier weeks.
// "Clearly" — the gap is more than twice the usual spread of such an average, "likely" — more than once.
export function spans(list: Step[], norm: number | null, W: Weights, S: Spread): Span[] {
  const out: Span[] = []
  for (const k of [1, 3, 5, 10, 20]) {
    if (list.length < k) continue
    const sp = list.slice(-k)
    const pp = sp.reduce((s, x) => s + x.b - x.a, 0)
    const perPct = sp.reduce((s, x) => s + opus(x.cost, W), 0) / pp
    const sigma = S.sigma(k)
    const diff = norm ? perPct / norm - 1 : null
    const verdict = k === 1 ? 'one percent proves nothing'
      : diff == null ? 'no earlier weeks to compare'
      : Math.abs(diff) > 2 * sigma ? (diff > 0 ? 'clearly above' : 'clearly below')
      : Math.abs(diff) > sigma ? (diff > 0 ? 'likely above' : 'likely below') : 'within the usual spread'
    const first = sp[0]!, last = sp[sp.length - 1]!
    out.push({ k, a: first.a, b: last.b, t0: first.t0, t1: last.t1, perPct, sigma, diff, verdict })
  }
  return out
}

const money = (x: number | null | undefined) => x == null || !isFinite(x) ? '—' : '$' + (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2))
const mt = (x: number) => (x / 1e6).toFixed(2) + 'M'
const pct = (x: number | null) => x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%'
const times = (x: number | null) => x == null ? '—' : '×' + (1 + x).toFixed(2)
const when = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// a step's model mix when it is not all Opus: "Sonnet 88%"
function mix(x: Step) {
  if (x.family === 'opus') return ''
  const [f, usd] = Object.entries(x.cost.byFamily).sort((p, q) => q[1] - p[1]).find(([g]) => g !== 'opus') ?? ['other', 0]
  return ` (${title(f)} ${((usd / (x.cost.usd || 1)) * 100).toFixed(0)}%)`
}

export type Report = { short: string; full: string; status: string }

export function report(rows: Row[], lim: Limits, now: number): Report {
  rows = [...rows].sort((x, y) => x[0] - y[0])
  const reset = lim.weekResetsAt ?? now + WEEK
  const ws = reset - WEEK
  const cur = steps(rows, ws, reset)
  const earlier = [...steps(rows, ws - 2 * WEEK, ws - WEEK), ...steps(rows, ws - WEEK, ws)]
  const { W, own } = weights([...earlier, ...cur])
  const S = spread(earlier, W)

  // your usual price of 1%: the clean percents of the two earlier weeks
  const before = earlier.filter(s => s.clean)
  const norm = before.length >= 10 ? before.reduce((s, x) => s + opus(x.cost, W), 0) / before.length : null
  // the last k clean percents, across the reset when this week has fewer
  const sp = spans([...earlier, ...cur].filter(s => s.clean), norm, W, S)
  const head = sp.find(s => s.k === 10) ?? sp.find(s => s.k === 5) ?? sp.find(s => s.k === 3)
  const perPct = head?.perPct ?? norm

  // the weekly percent as a whole number: a percent just begun says nothing yet
  const w = Math.floor(lim.week ?? rows[rows.length - 1]?.[6] ?? 0)
  // before the first answer of a session with limit-pace running there is no reading and no reset time
  const known = lim.weekResetsAt != null && (lim.week != null || rows.some(r => r[6] != null))
  const week = zero(), fh = zero()
  const fhStart = lim.fiveHourResetsAt ? lim.fiveHourResetsAt - 5 * HOUR : now
  for (const r of rows) {
    if (r[0] >= ws && r[0] <= now) add(week, r)
    if (r[0] >= fhStart && r[0] <= now) add(fh, r)
  }
  const left = perPct ? (100 - w) * perPct : null
  const resetIn = (reset - now) / HOUR

  // pace: how far the meter itself moved over the last day, breaks and sleep included. Without a
  // reading from a day ago (installed since), from the first reading there is.
  const dayFrom = Math.max(ws, now - 24 * HOUR)
  let base: [number, number] | null = dayFrom === ws ? [ws, 0] : null
  for (const r of known ? rows : []) {
    if (r[0] < ws || r[6] == null) continue
    if (r[0] <= dayFrom) base = [dayFrom, Math.floor(r[6])]
    else { base ??= [r[0], Math.floor(r[6])]; break }
  }
  const hrsBase = base ? (now - base[0]) / HOUR : 0, perHour = base && hrsBase > 1 ? (w - base[1]) / hrsBase : 0
  const span = base?.[0] === ws ? `over ${hrsBase.toFixed(0)} h since the reset` : hrsBase >= 23.5 ? 'over the last day' : `over ${hrsBase.toFixed(0)} h of records`

  // the short answer: what 1% buys now, and whether the week lasts at this pace
  const hrs = perHour > 0 ? (100 - w) / perHour : Infinity, lasts = hrs >= resetIn
  const Q: string[] = ['| | |', '|---|---|']
  Q.push(head
    ? `| **1% of the week now** | **${money(head.perPct)}** of API work at Opus 5.5 prices (last ${head.k} percents) |`
    : '| **1% of the week now** | not measured yet: it needs a few percents of use with limit-pace running |')
  const leftNote = left ? ` · ≈${money(left)} of work left` : ''
  if (!known) base = null
  Q.push(!known ? '| **Will it last?** | no reading of the weekly limit yet: it comes with the first answer in a session where limit-pace runs |'
    : !base ? `| **Will it last?** | week at ${w}%, not enough readings yet for a pace${leftNote} |`
    : perHour <= 0 ? `| **Will it last?** | **yes**: week at ${w}%, the meter has not moved ${span}${leftNote} |`
    : lasts ? `| **Will it last?** | **yes**: week at ${w}%, +${w - base[1]}% ${span}; at this pace 100% in ${hrs.toFixed(0)} h, the week resets in ${resetIn.toFixed(0)} h${leftNote} |`
    : `| **Will it last?** | **no**: week at ${w}%, +${w - base[1]}% ${span}; at this pace 100% at ${when(now + hrs * HOUR)}, ${(resetIn - hrs).toFixed(0)} h before the reset${leftNote} |`)
  const status = !known ? 'limit-pace: waiting for the first reading' : `week ${w}%${head ? ` · ${money(head.perPct)}/1%` : ''}${base && perHour > 0 ? (lasts ? ' · lasts to reset' : ` · out ${when(now + hrs * HOUR)}`) : ''}`

  const T: string[] = ['| | |', '|---|---|']
  if (perHour > 0 && base) T.push(lasts
    ? `| **At this pace** | **enough**: +${w - base[1]}% ${span} (${perHour.toFixed(2)}%/h), 100% would take ${hrs.toFixed(0)} h, reset in ${resetIn.toFixed(0)} h |`
    : `| **At this pace** | **runs out**: +${w - base[1]}% ${span} (${perHour.toFixed(2)}%/h), 100% at ${when(now + hrs * HOUR)}, ${(resetIn - hrs).toFixed(0)} h before reset |`)
  T.push(`| Week | **${w}%** · resets ${when(reset)}, in ${resetIn.toFixed(0)} h |`)
  if (head) T.push(`| **1% of the week** | **${money(head.perPct)}** in Opus 5.5 dollars (last ${head.k} percents) · ${norm ? `**${times(head.diff)}** your earlier weeks (${money(norm)}) ±${(head.sigma * 100).toFixed(0)}% · ${head.verdict}` : 'no earlier weeks to compare yet'} |`)
  else T.push(`| 1% of the week | not enough clean percents yet${norm ? `; earlier weeks ${money(norm)}` : ''} |`)
  T.push(`| Last percents | ${cur.slice(-3).map(x => `${x.a}→${x.b} ${money(opus(x.cost, W) / (x.b - x.a))}${mix(x)}${x.partial ? ' (partial)' : ''}`).join(' · ') || '—'} |`)
  if (lim.fiveHour != null) T.push(`| 5-hour window | ${lim.fiveHour}%${lim.fiveHour ? ` · ${money(opus(fh, W) / lim.fiveHour)} per 1%` : ''}${lim.fiveHourResetsAt ? ` · resets ${clock(lim.fiveHourResetsAt)}` : ''} |`)
  T.push(`| Spent / left | ${money(opus(week, W))} this week · ≈${money(left)} left at ${money(perPct)} per 1% |`)

  const fitNow = fitPrices(cur), fitPrev = fitPrices(earlier)
  const F: string[] = [...T, '', '## Every percent this week', '',
    '| Step | Closed | Took | Opus $ per 1% | API $ | Cache read | Cache write | Output | Calls | |', '|---|---|---|---|---|---|---|---|---|---|']
  for (const x of cur) {
    const c = x.cost
    const note = x.partial ? 'partial: recording began inside it' : x.b - x.a > 1 ? `jumped ${x.b - x.a}%` : mix(x).trim()
    F.push(`| ${x.a}→${x.b} | ${clock(x.t1)} | ${((x.t1 - x.t0) / 60e3).toFixed(0)} min | **${money(opus(c, W) / (x.b - x.a))}** | ${money(c.usd)} | ${mt(c.cr)} · ${money(c.$cr)} | ${mt(c.cw)} · ${money(c.$cw)} | ${mt(c.out)} · ${money(c.$out)} | ${c.calls} | ${note} |`)
  }
  F.push('', '## Accuracy', '', '| Last | Span | Opus $ per 1% | vs earlier weeks | Usual spread | Verdict |', '|---|---|---|---|---|---|')
  for (const s of sp) F.push(`| ${s.k} | ${s.a}→${s.b}%, ${when(s.t0)} – ${when(s.t1)} | ${money(s.perPct)} | ${times(s.diff)} (${pct(s.diff)}) | ±${(s.sigma * 100).toFixed(0)}% | ${s.verdict} |`)
  F.push('', '## Price of 1% by model', '',
    '| Model | API $ per 1% this week | Error | Steps with it | Its dollars | Two earlier weeks | Weight in Opus $ |', '|---|---|---|---|---|---|---|')
  for (const f of [...new Set([...fitNow, ...fitPrev].map(x => x.family))]) {
    const x = fitNow.find(y => y.family === f), pv = fitPrev.find(y => y.family === f)
    F.push(`| ${title(f)} | ${x ? `**${money(x.perPct)}**` : 'too little this week'} | ${x ? `±${(x.rel * 100).toFixed(0)}%` : '—'} | ${x?.steps ?? '—'} | ${x ? money(x.usd) : '—'} | ${pv ? `${money(pv.perPct)} ±${(pv.rel * 100).toFixed(0)}%` : '—'} | ×${(W[f] ?? 1).toFixed(2)}${own.includes(f) ? ' (yours)' : f === 'opus' ? '' : ' (default)'} |`)
  }
  F.push('',
    'Opus 5.5 dollars: each call\'s tokens at public API list prices, the dollars of other models converted by how much more limit one of their API dollars takes (the weight column; your own fit once it is tight, else measured defaults). One ruler for every model mix, so a percent spent on Sonnet subagents reads the same as one spent on Opus.',
    'Clean percents: exactly +1%, not the first step after recording began. The usual spread is how much an average over that many percents wandered in your earlier weeks (or, until they are long enough, on a reference account); "clearly" means more than twice that, "likely" more than once.',
    'Each step is an equation "percent gained = Σ the model\'s dollars / its price of 1%", solved over all steps at once (least squares) for the per-model prices.',
    'The pace is how far the weekly percent itself moved over the last day, so breaks and sleep count; a percent just begun is not counted.',
    'Dollars count only the Claude Code sessions where limit-pace runs. Other computers, claude.ai chats, Cowork and Claude Code on the web move the percent but not these dollars: if they were busy, 1% looks cheaper here than it is.',
    'Prices are public API list prices per million tokens; cache writes at the one-hour rate on the main thread and the five-minute rate in subagents, the TTLs Claude Code uses.')
  return { short: Q.join('\n'), full: F.join('\n'), status }
}

// Keeps the store far under its 4 MiB: a call joins the session's last stored row when the model, the
// subagent flag and both percents are the same and it came within ten minutes of that row's first call.
// A step's boundary is where a percent changes, so merging never moves one. Haiku 5.5 stays per call:
// its price depends on each call's own context.
export function merge(old: Row[], rows: Row[]): Row[] {
  const out = [...old]
  for (const r of rows) {
    const l = out[out.length - 1]
    if (l && l[1] === r[1] && l[8] === r[8] && r[8] != null && l[6] === r[6] && l[7] === r[7] && r[0] - l[0] < MERGE_MS && !/haiku-5/.test(r[1]))
      out[out.length - 1] = [l[0], l[1], l[2] + r[2], l[3] + r[3], l[4] + r[4], l[5] + r[5], l[6], l[7], r[8], (l[9] ?? 1) + (r[9] ?? 1)]
    else out.push(r)
  }
  return out
}
