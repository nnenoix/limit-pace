// limit-pace: records every model call of every Claude Code session on this computer (tokens, and the
// five-hour and weekly percents the response reported), and answers /limit-pace and /limit-pace-full:
// what 1% of the weekly limit is worth in API dollars, how sure that is, and whether the limit lasts
// until the reset at the current pace.
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import { report, type Limits, type Row } from './pace'

const KEEP_MS = 16 * 24 * 3600e3 // this week and the two before it, for the baseline
const FLUSH_MS = 30_000

// rows of this process's sessions not yet written, by session id (a /clear starts a new id)
const pending = new Map<string, Row[]>()

function limitsOf(rl: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Limits {
  const w = rl.find(r => r.kind === 'seven_day'), f = rl.find(r => r.kind === 'five_hour')
  return {
    week: w?.percentUsed, fiveHour: f?.percentUsed,
    weekResetsAt: w?.resetsAt ? Date.parse(w.resetsAt) : undefined,
    fiveHourResetsAt: f?.resetsAt ? Date.parse(f.resetsAt) : undefined,
  }
}

async function record($: EngineInterface, u: TurnUsage) {
  const lim = limitsOf((await $.session.usage()).rateLimits)
  const id = await $.session.id()
  const row: Row = [await $.clock.now(), u.model, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens,
    u.cache_read_input_tokens, lim.week ?? null, lim.fiveHour ?? null]
  pending.set(id, [...(pending.get(id) ?? []), row])
  if (lim.weekResetsAt) await $.store.set('limits', { ...lim, at: row[0] })
}

async function flush($: EngineInterface) {
  for (const [id, rows] of [...pending]) {
    pending.delete(id)
    const key = `s:${id}`
    const old = ((await $.store.get(key)) as Row[] | undefined) ?? []
    await $.store.set(key, [...old, ...rows])
  }
}

async function prune($: EngineInterface) {
  const from = (await $.clock.now()) - KEEP_MS
  for (const key of await $.store.keys()) {
    if (!key.startsWith('s:')) continue
    const rows = ((await $.store.get(key)) as Row[] | undefined) ?? []
    const kept = rows.filter(r => r[0] >= from)
    if (!kept.length) await $.store.delete(key)
    else if (kept.length < rows.length) await $.store.set(key, kept)
  }
}

async function build($: EngineInterface) {
  await flush($)
  const rows: Row[] = []
  for (const key of await $.store.keys()) if (key.startsWith('s:')) rows.push(...(((await $.store.get(key)) as Row[] | undefined) ?? []))
  const live = limitsOf((await $.session.usage()).rateLimits)
  const saved = ((await $.store.get('limits')) as Limits | undefined) ?? {}
  return report(rows, live.weekResetsAt ? live : saved, await $.clock.now())
}

async function show($: EngineInterface, full: boolean) {
  const r = await build($)
  return { text: full ? r.full : r.short }
}

async function refreshStatus($: EngineInterface) {
  $.ui.status((await build($)).status)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'limit-pace', description: 'Weekly limit: price of 1%, pace, enough until reset?' })
    await $.command.register({ name: 'limit-pace-full', description: 'Weekly limit: every percent this week and the accuracy of the estimate' })
    await prune($)
    $.clock.every(FLUSH_MS, () => { if (pending.size) void flush($) })
    return next(e)
  })

  // each model request of the turn, subagents' included: its usage arrives on the stop chunk
  on('turn.step', async function* ($, e, next) {
    for await (const c of next(e)) {
      if (c.kind === 'stop' && c.usage) await record($, c.usage)
      yield c
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refreshStatus($)
    return done
  })

  on('session.end', async ($, e, next) => {
    await flush($)
    return next(e)
  })

  on('command.run', { command: 'limit-pace' }, async $ => show($, false))
  on('command.run', { command: 'limit-pace-full' }, async $ => show($, true))
}
