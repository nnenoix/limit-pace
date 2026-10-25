# limit-pace

**How much is 1% of your weekly Claude limit worth, and will the limit last until it resets?**

Claude subscriptions show your five-hour and weekly limits only as percents. limit-pace records the tokens of every model call your Claude Code sessions make, prices them at public API list prices, and lines them up against the percent each response reported. You get:

- **Your pace.** How far the weekly percent moved over the last day, breaks and sleep included, and whether the limit lasts until the reset at that pace, or the hour it would run out.
- **The price of 1%.** What one percent of the week currently buys in API dollars of the model you mostly use, compared with your own earlier weeks. A sudden change means you get more or less for the same subscription.
- **An honest error bar.** Every estimate comes with its error and a verdict: *clearly above*, *clearly below* or *within noise*. A single percent is never treated as proof.
- **Every percent of the week.** What each step cost, split into cache reads, cache writes and output.

## Commands

| Command | Shows |
|---|---|
| `/limit-pace` | The short table: pace, week, price of 1% now, the last percents, the five-hour window, spent and left |
| `/limit-pace-full` | The short table, every percent of this week, and the accuracy table |

The status line also shows `week 21% · enough to reset · $29.73/1%`, updated after each turn.

Example of `/limit-pace`:

| | |
|---|---|
| **At this pace** | **enough**: +10% over the last day (0.42%/h), 100% would take 182 h, reset in 123 h |
| Week | **24%** · resets Sat 31 Oct, 03:00, in 123 h |
| 1% of the week (Opus) | **$31.02** (last 5 clean) · +27% vs your earlier weeks ($24.50) · clearly above |
| Last percents | 21→22 $29.85 · 22→23 $24.33 (Sonnet 58%) · 23→24 $17.24 (Sonnet 88%) |
| 5-hour window | 8% · $5.61 per 1% · resets 04:49 |
| Spent / left | $529 this week · ≈$2357 left at $31.02 per 1% (Opus) |

## Install

```
/plugin install limit-pace --marketplace nnenoix/limit-pace
```

Nothing to configure. Works on Windows, macOS and Linux with a Claude Pro or Max subscription. The plugin starts recording when it is installed, so the price of 1% shows up after a few percents of use, and the comparison with earlier weeks after about a week.

## How it works

- After each model request, subagents' included, the plugin stores one row: time, model, input, output, cache write and cache read tokens, and the five-hour and weekly percents that response reported. Rows are kept for 16 days in the plugin's own storage on your computer. Nothing is sent anywhere, and no prompt or response text is stored.
- A step of the weekly percent, say 20→21, holds the calls made between the response that last read 20% and the one that first read 21%. Its price is the API value of those calls.
- The limit charges model families differently per API dollar: in one measurement a percent of mostly Sonnet subagents cost $17 while Opus percents cost about $30. So the price of 1% is taken only from clean steps, exactly +1% with at least 90% of the dollars on one family, and shown for the family you use most.
- The pace is the weekly percent's own movement over the last day. The percent in progress is not counted, since it may have only just begun.
- The meter books usage in bursts, so one step is off by about ±40% of its price; an average over k steps in a row by about ±40%/k. A further ±10% is systematic: API dollars are a ruler, and the limit may weigh cache reads, cache writes and output differently. A verdict says *clearly* only when the gap is larger than both.

## Limits of what it sees

- Only Claude Code sessions on computers where limit-pace is installed. Chats on claude.ai, Cowork and Claude Code on the web use the same limits but are not seen; when they are busy, 1% looks cheaper than it is.
- Background calls Claude Code makes outside a turn (session titles, compaction) are not seen.
- Cache writes are priced at the one-hour rate for Opus, Fable and Haiku and the five-minute rate for Sonnet, the TTLs Claude Code uses; the plugin cannot tell which one each write used.

## License

MIT
