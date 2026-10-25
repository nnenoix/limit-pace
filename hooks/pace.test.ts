import { expect, test } from 'claude-code/testing'

import { add, report, spans, steps, zero, type Row } from './pace'

const H = 3600e3
const T0 = Date.UTC(2026, 9, 24, 0, 0) // a week start
const RESET = T0 + 7 * 24 * H

// one Opus call reading `w` percent: 1M cache read = $0.20, 10k output = $0.20
const call = (t: number, w: number, fh = 1): Row => [t, 'claude-opus-5-5', 0, 10_000, 0, 1_000_000, w, fh]

test('prices a call at API list prices', () => {
  const c = add(zero(), call(T0, 0))
  expect(Math.round(c.usd * 100) / 100).toBe(0.4)
  expect(Math.round(c.$cr * 100) / 100).toBe(0.2)
})

test('cuts steps where the reading rises and gives the calls before it to that step', () => {
  // 10 calls at 0%, then the 11th reads 1%: the first ten ($4) are the step 0→1
  const rows = Array.from({ length: 25 }, (_, i) => call(T0 + i * 60e3, i < 10 ? 0 : i < 20 ? 1 : 2))
  const s = steps(rows, T0, RESET)
  expect(s.length).toBe(2)
  expect(s[0]!.a).toBe(0)
  expect(s[0]!.b).toBe(1)
  expect(Math.round(s[0]!.cost.usd * 100) / 100).toBe(4)
  expect(s[1]!.clean).toBe(true)
})

test('marks a jump of two percents as not clean', () => {
  const rows = [call(T0, 0), call(T0 + 60e3, 0), call(T0 + 120e3, 2)]
  expect(steps(rows, T0, RESET)[0]!.clean).toBe(false)
})

test('keeps a step that mixes Opus and Sonnet out of the price', () => {
  const sonnet = (t: number, w: number): Row => [t, 'claude-sonnet-5-5', 0, 10_000, 0, 1_000_000, w, 1]
  const rows = [call(T0, 0), sonnet(T0 + 60e3, 0), sonnet(T0 + 120e3, 0), call(T0 + 180e3, 1), call(T0 + 240e3, 2)]
  const s = steps(rows, T0, RESET)
  expect(s[0]!.family).toBe(null)
  expect(s[0]!.clean).toBe(false)
  expect(s[1]!.family).toBe('opus')
  expect(s[1]!.clean).toBe(true)
})

test('takes the pace from the meter over the last day, not from a percent just begun', () => {
  // 10% in the first 24 h, then 2% more in the last 24 h: the pace is 2% a day
  const rows: Row[] = [call(T0, 0), call(T0 + 24 * H, 10), call(T0 + 47 * H, 12), call(T0 + 48 * H, 12.9)]
  const r = report(rows, { week: 12.9, weekResetsAt: RESET }, T0 + 48 * H)
  expect(r.short).toContain('+2% over the last day')
  expect(r.short).toContain('**12%**')
})

test('calls a gap bigger than the error clearly above', () => {
  const list = steps(Array.from({ length: 61 }, (_, i) => call(T0 + i * 60e3, Math.floor(i / 10))), T0, RESET)
  const five = spans(list, 2).find(s => s.k === 5)
  expect(Math.round((five?.perPct ?? 0) * 100) / 100).toBe(4)
  expect(five?.verdict).toBe('clearly above')
  expect(spans(list, 4).find(s => s.k === 5)?.verdict).toBe('within noise')
})

test('says whether the limit lasts at the current pace', () => {
  const rows = Array.from({ length: 61 }, (_, i) => call(T0 + i * 60e3, Math.floor(i / 10)))
  const now = T0 + 61 * 60e3
  const r = report(rows, { week: 6, fiveHour: 3, weekResetsAt: RESET }, now)
  expect(r.short.split('\n')[2] ?? '').toContain('At this pace')
  expect(r.full).toContain('## Accuracy')
  expect(r.status).toContain('week 6%')
})
