[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/didinrachmadi/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/didinrachmadi/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

# Dip-buy BTC bot — make.fun btc-race-24h-20261117-0603

A long-only trading bot for Coinbase Wrapped BTC (cbBTC) against USDC, racing
on 1-minute on-chain prices from the Orca Whirlpool. It starts with $1,000 of
paper money and is ranked by net PnL on the 24 hours after the deadline.

## Strategy

Mean reversion around a slow trend line:

- **Dip leg.** An EMA of 240 one-minute closes (~4 h) is the trend. When the
  close falls at least 0.60% below that EMA — a dip, not a crash (the 60-bar
  return must stay above −1.20%) — the bot buys with all its cash. It sells
  when the close recovers to the EMA, or on a 0.60% stop-loss below its fill
  price. A full-size round trip costs ~37 bps in fee, slippage and pool
  impact, so only dips deep enough to pay that back are worth buying.
- **Late fallback.** If no dip ever came and the bot has still not traded by
  batch 1200, it buys the uptrend once (close above the EMA) and rides it
  with a 0.60% trailing stop. This guarantees at least one trade on a steady
  up-day, when the dip leg would otherwise sit out.
- No new position is opened in the last bars of the window.

## Local grade (dev window)

```
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

Dev window: **net PnL +1.957 USDC, 6 trades, max drawdown 0.70%, Sharpe
0.0056**, guardrails met, two executions reproduced byte for byte
(deterministic).

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `agent-fun/bars-replay/v1` SDK shim
- `LICENSE` — MIT

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout: one `hello`, one
`batch` per bar, one `reply` per batch echoing its `seq`. It is fully
deterministic — fixed float arithmetic over the closes in arrival order, no
wall clock, no network, no files outside the repo.
