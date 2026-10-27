# limit-pace

**How much is 1% of your weekly Claude limit worth, and will the limit last until it resets?**

Claude subscriptions show your five-hour and weekly limits only as percents. limit-pace records the tokens of every model call your Claude Code sessions make, prices them at public API list prices, and lines them up against the percent each response reported. You get:

- **Your pace.** How far the weekly percent moved over the last day, breaks and sleep included, and whether the limit lasts until the reset at that pace, or the hour it would run out.
- **The price of 1%, in one stable unit.** What one percent of the week currently buys in *Opus 5.5 dollars*, and how that compares with your own earlier weeks (×1.20 means you get 20% more for the same subscription). Sonnet, Haiku and Fable dollars are converted by how much more limit they take, so a percent spent on Sonnet subagents reads the same as one spent on Opus.
- **The price for every model.** Opus, Sonnet, Haiku and Fable each get their own price of 1%, fitted from all steps, mixed ones included, and the weight that converts each into Opus dollars.
- **An honest error bar.** Every estimate is set against how much such an average wandered in your own earlier weeks, with a verdict: *clearly* above or below (more than twice that spread), *likely* (more than once) or *within the usual spread*. A single percent is never treated as proof.
- **Every percent of the week.** What each step cost, split into cache reads, cache writes and output.

## Commands

| Command | Shows |
|---|---|
| `/limit-pace` | The short table: pace, week, price of 1% now, the last percents, the five-hour window, spent and left |
| `/limit-pace-full` | The short table, every percent of this week, the price of 1% for each model against earlier weeks, and the accuracy table |

The status line also shows `week 38% · enough to reset · $22.18/1% (×1.00)`, updated after each turn.

Example of `/limit-pace`:

| | |
|---|---|
| **At this pace** | **enough**: +7% over the last day (0.29%/h), 100% would take 213 h, reset in 76 h |
| Week | **38%** · resets Sat 31 Oct, 03:00, in 76 h |
| **1% of the week** | **$22.18** in Opus 5.5 dollars (last 10 percents) · **×1.00** your earlier weeks ($22.14) ±24% · within the usual spread |
| Last percents | 35→36 $20.96 · 36→37 $28.69 · 37→38 $30.29 |
| 5-hour window | 7% · $8.38 per 1% · resets 01:30 |
| Spent / left | $916 this week · ≈$1375 left at $22.18 per 1% |

## Install

```
/plugin install limit-pace --marketplace nnenoix/limit-pace
```

Nothing to configure. Works on Windows, macOS and Linux with a Claude Pro or Max subscription and a Claude Code recent enough to run plugin hooks modules (tested on 2.1.309). The plugin starts recording when it is installed, so the price of 1% shows up after a few percents of use, and the comparison with earlier weeks after about a week. The percent that was in progress when you installed it is left out: part of it was used before recording began.

## How it works

- After each model request, subagents' included, the plugin stores the time, model, input, output, cache write and cache read tokens, whether a subagent made it, and the five-hour and weekly percents that response reported. Calls of one session in a row with the same model and the same percents are kept as one row, so sixteen days of heavy use stay well under the plugin storage's 4 MiB. Nothing is sent anywhere, and no prompt or response text is stored.
- Each call is priced at public API list prices. Claude Code caches the main thread's prompt for an hour and a subagent's for five minutes, so cache writes take the matching rate.
- A step of the weekly percent, say 20→21, holds the calls made between the response that first read 20% and the one that first read 21%. A clean step is exactly +1% and not the first one after recording began.
- The limit charges model families differently per API dollar: in one measurement an API dollar of Sonnet took 1.44 times the limit of an Opus dollar, one of Fable 2.3 times. Each step is an equation "percent gained = Σ the model's dollars / its price of 1%", solved over all steps at once by least squares. Once your own fit is tight (Opus within ±15%, the model within ±25%, five steps with it) its weights convert other models' dollars into Opus 5.5 dollars; until then the measured ones above.
- The headline price is the average over the last 10 clean percents, against the clean percents of your two earlier weeks. Its error is not a formula: the price of a percent wanders even while the limit stays the same (about ±29% for one percent, ±11% for ten, on the reference account), mostly from usage the plugin does not see and from the meter booking in bursts. The plugin measures that spread on your own earlier weeks once they hold enough percents.
- The pace is the weekly percent's own movement over the last day (or since the first reading, when the plugin was installed less than a day ago). The percent in progress is not counted, since it may have only just begun.

## Limits of what it sees

- Only Claude Code sessions on computers where limit-pace is installed. Chats on claude.ai, Cowork and Claude Code on the web use the same limits but are not seen; when they are busy, 1% looks cheaper than it is.
- Background calls Claude Code makes outside a turn (session titles, compaction) are not seen.
- Your earlier weeks are the comparison: if Anthropic changed the limit during them, the comparison is with that.
- Rows recorded by versions before 1.2.0 carry no subagent flag; their cache writes take the old rule (one hour for Opus, Fable and Haiku, five minutes for Sonnet).

## License

MIT
