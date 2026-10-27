import { expect, test } from 'claude-code/testing'

import { add, DEFAULT_WEIGHTS, fitPrices, merge, opus, report, spans, spread, steps, zero, type Row } from './pace'

const H = 3600e3
const T0 = Date.UTC(2026, 9, 24, 0, 0) // a week start
const RESET = T0 + 7 * 24 * H
const W = DEFAULT_WEIGHTS

// one main-thread Opus call reading `w` percent: 1M cache read = $0.20, 10k output = $0.20
const call = (t: number, w: number, fh = 1): Row => [t, 'claude-opus-5-5', 0, 10_000, 0, 1_000_000, w, fh, 0]
const sonnet = (t: number, w: number): Row => [t, 'claude-sonnet-5-5', 0, 10_000, 0, 1_000_000, w, 1, 1] // $0.20
const round = (x: number) => Math.round(x * 100) / 100

test('prices a call at API list prices', () => {
  const c = add(zero(), call(T0, 0))
  expect(round(c.usd)).toBe(0.4)
  expect(round(c.$cr)).toBe(0.2)
})

test('prices cache writes at the one-hour rate on the main thread and the five-minute rate in subagents', () => {
  const write = (sub: 0 | 1): Row => [T0, 'claude-opus-5-5', 0, 0, 1_000_000, 0, 0, 0, sub]
  expect(round(add(zero(), write(0)).usd)).toBe(8)
  expect(round(add(zero(), write(1)).usd)).toBe(5)
})

test('prices older model generations at their own rates', () => {
  const out = (model: string): Row => [T0, model, 0, 1_000_000, 0, 0, 0, 0, 0]
  expect(round(add(zero(), out('claude-haiku-4-5-20251001')).usd)).toBe(5)
  expect(round(add(zero(), out('claude-haiku-5-5')).usd)).toBe(0.5)
  expect(round(add(zero(), out('claude-sonnet-4-5')).usd)).toBe(15)
})

test('cuts steps where the reading rises and gives the calls before it to that step', () => {
  // 10 calls at 0%, then the 11th reads 1%: the first ten ($4) are the step 0→1
  const rows = Array.from({ length: 25 }, (_, i) => call(T0 + i * 60e3, i < 10 ? 0 : i < 20 ? 1 : 2))
  const s = steps(rows, T0, RESET)
  expect(s.length).toBe(2)
  expect(s[0]!.a).toBe(0)
  expect(s[0]!.b).toBe(1)
  expect(round(s[0]!.cost.usd)).toBe(4)
  expect(s[1]!.clean).toBe(true)
})

test('marks a jump of two percents as not clean', () => {
  const rows = [call(T0, 0), call(T0 + 60e3, 0), call(T0 + 120e3, 2)]
  expect(steps(rows, T0, RESET)[0]!.clean).toBe(false)
})

test('marks the first step as partial when recording began inside a percent', () => {
  // installed at 7%: the calls up to 8% are only the tail of that percent
  const rows = [call(T0 + H, 7), call(T0 + H + 60e3, 8), call(T0 + H + 120e3, 9)]
  const s = steps(rows, T0, RESET)
  expect(s[0]!.partial).toBe(true)
  expect(s[0]!.clean).toBe(false)
  expect(s[1]!.clean).toBe(true)
})

test('starts over when the first readings after the reset are still last week\'s', () => {
  const rows = [call(T0 + 60e3, 99), call(T0 + 120e3, 0), call(T0 + 180e3, 0), call(T0 + 240e3, 1), call(T0 + 300e3, 2)]
  const s = steps(rows, T0, RESET)
  expect(s.map(x => `${x.a}→${x.b}`).join(' ')).toBe('0→1 1→2')
  expect(s[0]!.clean).toBe(true)
})

test('counts a mixed step in Opus dollars, the Sonnet dollars weighted', () => {
  const rows = [call(T0, 0), sonnet(T0 + 60e3, 0), sonnet(T0 + 120e3, 0), call(T0 + 180e3, 1), call(T0 + 240e3, 2)]
  const s = steps(rows, T0, RESET)
  expect(s[0]!.family).toBe(null)
  expect(s[0]!.clean).toBe(true)
  // $0.40 Opus + $0.40 Sonnet × 1.44
  expect(round(opus(s[0]!.cost, W))).toBe(0.98)
})

test('takes the pace from the meter over the last day, not from a percent just begun', () => {
  // 10% in the first 24 h, then 2% more in the last 24 h: the pace is 2% a day
  const rows: Row[] = [call(T0, 0), call(T0 + 24 * H, 10), call(T0 + 47 * H, 12), call(T0 + 48 * H, 12.9)]
  const r = report(rows, { week: 12.9, weekResetsAt: RESET }, T0 + 48 * H)
  expect(r.short).toContain('+2% over the last day')
  expect(r.short).toContain('week at 12%')
})

test('takes the pace from the first reading when recording began less than a day ago', () => {
  // installed 3 days into the week at 30%, 4% more in the 10 h since: 0.4%/h, not 34% over a day
  const t = T0 + 72 * H
  const rows: Row[] = [call(t, 30), call(t + 10 * H, 34)]
  const r = report(rows, { week: 34, weekResetsAt: RESET }, t + 10 * H)
  expect(r.short).toContain('+4% over 10 h of records')
  expect(r.full).toContain('(0.40%/h)')
})

test('fits a price of 1% for each model from mixed steps', () => {
  // Opus: $4 per 1%; Sonnet: $2 per 1% (its dollar takes twice the limit). Mixed steps of both.
  const rows: Row[] = []
  let t = T0, w = 0
  const plan = [[10, 0], [5, 5], [0, 10], [8, 2], [2, 8], [10, 0], [4, 6], [6, 4]] // calls: [opus, sonnet]
  for (const [o = 0, s = 0] of plan) {
    for (let i = 0; i < o; i++) rows.push(call((t += 60e3), w))
    for (let i = 0; i < s; i++) rows.push(sonnet((t += 60e3), w))
    // opus calls are $0.40 each → o*0.4/4 %; sonnet $0.20 each → s*0.2/2 %; each plan row adds 1%
    w += 1
  }
  rows.push(call((t += 60e3), w))
  const fit = fitPrices(steps(rows, T0, RESET))
  const o = fit.find(x => x.family === 'opus'), son = fit.find(x => x.family === 'sonnet')
  expect(round(o?.perPct ?? 0)).toBe(4)
  expect(round(son?.perPct ?? 0)).toBe(2)
})

test('calls a gap of more than twice the usual spread clearly above, one between once and twice likely', () => {
  const list = steps(Array.from({ length: 61 }, (_, i) => call(T0 + i * 60e3, Math.floor(i / 10))), T0, RESET)
  const S = spread([], W) // defaults: ±14% at k=5
  const five = (norm: number) => spans(list, norm, W, S).find(s => s.k === 5)
  expect(round(five(2)?.perPct ?? 0)).toBe(4)
  expect(five(2)?.verdict).toBe('clearly above') // +100%
  expect(five(3.4)?.verdict).toBe('likely above') // +18%
  expect(five(3.8)?.verdict).toBe('within the usual spread') // +5%
})

test('merges calls into stored rows without moving a step or losing a dollar', () => {
  const rows = Array.from({ length: 40 }, (_, i) => call(T0 + i * 60e3, Math.floor(i / 10)))
  const m = merge([], rows)
  expect(m.length).toBe(4)
  const a = steps(rows, T0, RESET), b = steps(m, T0, RESET)
  expect(b.map(x => round(x.cost.usd)).join()).toBe(a.map(x => round(x.cost.usd)).join())
  expect(b[0]!.cost.calls).toBe(10)
})

test('answers in two rows: what 1% buys now and whether the week lasts', () => {
  // $4 a percent; 6% in the first hour of the week runs out long before the reset
  const rows = Array.from({ length: 61 }, (_, i) => call(T0 + i * 60e3, Math.floor(i / 10)))
  const r = report(rows, { week: 6, fiveHour: 3, weekResetsAt: RESET }, T0 + 61 * 60e3)
  const lines = r.short.split('\n')
  expect(lines.length).toBe(4)
  expect(lines[2] ?? '').toContain('**$4.00** of API work')
  expect(lines[3] ?? '').toContain('**no**: week at 6%')
  expect(r.full).toContain('## Accuracy')
  expect(r.status).toContain('week 6% · $4.00/1% · out')
  // the same 6% spread over six days lasts
  const slow = Array.from({ length: 61 }, (_, i) => call(T0 + i * 2.4 * H, Math.floor(i / 10)))
  const r2 = report(slow, { week: 6, weekResetsAt: RESET }, T0 + 146 * H)
  expect(r2.short).toContain('**yes**: week at 6%')
  expect(r2.status).toContain('lasts to reset')
})
