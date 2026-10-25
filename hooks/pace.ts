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

export type Cost = { usd: number; $in: number; $out: number; $cw: number; $cr: number; cr: number; cw: number; out: number; calls: number }

export const zero = (): Cost => ({ usd: 0, $in: 0, $out: 0, $cw: 0, $cr: 0, cr: 0, cw: 0, out: 0, calls: 0 })

export function price(model: string, context: number): number[] {
  const p = (PRICES.find(([re]) => re.test(model)) ?? PRICES[2]!)[1]
  return /haiku/.test(model) && context > 100e3 ? p.map(x => x * 5) : p
}

export function add(c: Cost, r: Row): Cost {
  const [, model, i, o, cw, cr] = r
  const [pi = 0, po = 0, pw = 0, pr = 0] = price(model, i + cw + cr)
  const $in = (i * pi) / 1e6, $out = (o * po) / 1e6, $cw = (cw * pw) / 1e6, $cr = (cr * pr) / 1e6
  c.$in += $in; c.$out += $out; c.$cw += $cw; c.$cr += $cr; c.usd += $in + $out + $cw + $cr
  c.cr += cr; c.cw += cw; c.out += o; c.calls++
  return c
}

export type Step = { a: number; b: number; t0: number; t1: number; cost: Cost; clean: boolean }

// The weekly percent's steps: a call belongs to the step that the next higher reading closes.
// A step a→b runs from the call that last read a to the call that first read b.
export function steps(rows: Row[], from: number, to: number): Step[] {
  const out: Step[] = []
  let cost = zero(), w: number | null = null, t0 = from
  for (const r of rows) {
    if (r[0] < from || r[0] >= to) continue
    const now = r[6] == null ? null : Math.floor(r[6])
    if (w != null && now != null && now > w) {
      out.push({ a: w, b: now, t0, t1: r[0], cost, clean: now - w === 1 })
      cost = zero(); t0 = r[0]
    }
    if (now != null && (w == null || now > w)) w = now
    add(cost, r)
  }
  return out
}

export type Span = { k: number; a: number; b: number; t0: number; t1: number; perPct: number; stat: number; diff: number | null; verdict: string }

// Price of 1% over the last k steps in a row. Two exact boundaries make the sum exact; the meter
// books usage in bursts, so one step is off by about ±40% of a step's price and a k-step average
// by about ±40%/k. Another ±10% is systematic: API dollars are our ruler, the meter may weigh token
// kinds otherwise.
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

const money = (x: number | null | undefined) => x == null || !isFinite(x) ? '—' : '$' + (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2))
const mt = (x: number) => (x / 1e6).toFixed(2) + 'M'
const pct = (x: number | null) => x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%'
const when = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export type Report = { short: string; full: string; status: string }

export function report(rows: Row[], lim: Limits, now: number): Report {
  rows = [...rows].sort((x, y) => x[0] - y[0])
  const reset = lim.weekResetsAt ?? now + WEEK
  const ws = reset - WEEK
  const cur = steps(rows, ws, reset)
  const prev = [...steps(rows, ws - 2 * WEEK, ws - WEEK), ...steps(rows, ws - WEEK, ws)].filter(s => s.clean)
  const norm = prev.length >= 5 ? prev.reduce((s, x) => s + x.cost.usd, 0) / prev.length : null
  const sp = spans(cur, norm)
  const fresh = sp.find(s => s.k === 5) ?? sp.find(s => s.k === 3) ?? sp.find(s => s.k === 10)
  const perPct = fresh?.perPct ?? norm

  const w = lim.week ?? rows[rows.length - 1]?.[6] ?? 0
  const tickAt = cur[cur.length - 1]?.t1 ?? ws
  const since = zero(), week = zero(), h6 = zero(), fh = zero()
  const fhStart = lim.fiveHourResetsAt ? lim.fiveHourResetsAt - 5 * HOUR : now
  for (const r of rows) {
    if (r[0] >= tickAt && r[0] <= now) add(since, r)
    if (r[0] >= ws && r[0] <= now) add(week, r)
    if (r[0] >= now - 6 * HOUR && r[0] <= now) add(h6, r)
    if (r[0] >= fhStart && r[0] <= now) add(fh, r)
  }
  const est = perPct ? Math.floor(w) + Math.min(0.99, since.usd / perPct) : w
  const left = perPct ? (100 - est) * perPct : null
  const pace = h6.usd / 6
  const resetIn = (reset - now) / HOUR

  const S: string[] = ['| | |', '|---|---|']
  let status = `week ${Math.floor(w)}%`
  if (pace > 0 && left != null && perPct) {
    const hrs = left / pace, rate = pace / perPct
    S.push(hrs >= resetIn
      ? `| **At this pace** | **enough**: ${rate.toFixed(2)}%/h (${money(pace)}/h), 100% would take ${hrs.toFixed(0)} h, reset in ${resetIn.toFixed(0)} h |`
      : `| **At this pace** | **runs out**: ${rate.toFixed(2)}%/h (${money(pace)}/h), 100% at ${when(now + hrs * HOUR)}, ${(resetIn - hrs).toFixed(0)} h before reset |`)
    status += hrs >= resetIn ? ' · enough to reset' : ` · out ${when(now + hrs * HOUR)}`
  }
  S.push(`| Week | **${Math.floor(w)}%** (≈${est.toFixed(1)}) · resets ${when(reset)}, in ${resetIn.toFixed(0)} h |`)
  if (fresh) S.push(`| 1% of the week now | **${money(fresh.perPct)}** (last ${fresh.k}) · ${pct(fresh.diff)} vs your earlier weeks (${money(norm)}) · ${fresh.verdict} |`)
  else S.push(`| 1% of the week now | not enough steps yet${norm ? `; earlier weeks ${money(norm)}` : ''} |`)
  S.push(`| Last percents | ${cur.slice(-3).map(x => `${x.a}→${x.b} ${money(x.cost.usd)}`).join(' · ') || '—'} |`)
  S.push(`| Current ${Math.floor(w)}→${Math.floor(w) + 1} | ${money(since.usd)} over ${((now - tickAt) / 60e3).toFixed(0)} min |`)
  if (lim.fiveHour != null) S.push(`| 5-hour window | ${lim.fiveHour}%${lim.fiveHour ? ` · ${money(fh.usd / lim.fiveHour)} per 1%` : ''}${lim.fiveHourResetsAt ? ` · resets ${clock(lim.fiveHourResetsAt)}` : ''} |`)
  S.push(`| Spent / left | ${money(week.usd)} this week · ≈${money(left)} left at ${money(perPct)} per 1% |`)
  if (fresh) status += ` · ${money(fresh.perPct)}/1%`

  const F: string[] = [...S, '', '## Every percent this week', '',
    '| Step | Closed | Took | $ | Cache read | Cache write | Output | Calls |', '|---|---|---|---|---|---|---|---|']
  for (const x of cur) {
    const c = x.cost
    F.push(`| ${x.a}→${x.b}${x.clean ? '' : ' (jump)'} | ${clock(x.t1)} | ${((x.t1 - x.t0) / 60e3).toFixed(0)} min | ${money(c.usd)} | ${mt(c.cr)} · ${money(c.$cr)} | ${mt(c.cw)} · ${money(c.$cw)} | ${mt(c.out)} · ${money(c.$out)} | ${c.calls} |`)
  }
  F.push('', '## Accuracy', '', `| Last | Span | $ per 1% | Error | vs earlier weeks | Verdict |`, '|---|---|---|---|---|---|')
  for (const s of sp) F.push(`| ${s.k} | ${s.a}→${s.b}%, ${when(s.t0)} – ${when(s.t1)} | ${money(s.perPct)} | ±${money(s.stat)} and ±10% | ${pct(s.diff)} | ${s.verdict} |`)
  F.push('',
    '"Clearly" means the gap is bigger than the error: ±40%/k from the meter booking usage in bursts, plus ±10% because API dollars are only our ruler (about 18% at k=5, 14% at k=10).',
    'Dollars count only the Claude Code sessions on this computer where limit-pace runs. Other computers, claude.ai chats, Cowork and Claude Code on the web move the percent but not these dollars: if they were busy, 1% looks cheaper here than it is.',
    'Prices are public API list prices per million tokens; cache writes at the one-hour rate for Opus, Fable and Haiku, five-minute rate for Sonnet.')
  return { short: S.join('\n'), full: F.join('\n'), status }
}
