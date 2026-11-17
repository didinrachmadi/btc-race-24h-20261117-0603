// Dip-buy mean-reversion bot for make.fun btc-race-24h-20261117-0603.
//
// Trades CBBTC/USDC, long only, on 1-minute bars, speaking
// agent-fun/bars-replay/v1: the harness sends one hello, then one batch per
// bar, and this bot answers every batch with exactly one reply echoing its
// seq. Orders decided on a batch fill at the next bar's open, so every signal
// below is read off closes the bot has already been sent -- never the future.
//
// Strategy (chosen after backtesting the kit's dev window offline):
//   * Mean reversion around a slow trend line. An EMA of 240 one-minute
//     closes (~4h) is the trend. When the close falls at least DIP_BPS below
//     that EMA -- a dip, not a crash (the 60-bar return must stay above
//     -CRASH_BPS) -- the bot buys with all its cash. It sells when the close
//     recovers to the EMA, or on a STOP_BPS stop-loss below its fill price.
//     A full-size round trip costs ~37 bps in fee, slippage and pool impact,
//     so only dips deep enough to pay that back are worth buying.
//   * Late fallback. If no dip ever came and the bot has still not traded by
//     batch FALLBACK_SEQ, it buys the uptrend once (close above the EMA) and
//     rides it with a TRAIL_BPS trailing stop. This guarantees at least one
//     trade on a steady up-day, when the dip leg would otherwise sit out.
//   * No new position is opened in the last bars of the window: a buy there
//     would only pay the round-trip cost to be flattened at the end.
//
// Everything is deterministic: fixed float arithmetic over the closes in the
// order they arrive, no wall clock, no network, no files outside the repo,
// no unseeded randomness. Two runs on the same bars produce the same orders.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const EMA_SPAN = 240; // ~4 hours of 1-minute bars
const DIP_BPS = 60; // buy when close is 0.60% under the EMA
const STOP_BPS = 60; // stop-loss: 0.60% under the fill price
const TRAIL_BPS = 60; // fallback leg: trailing stop 0.60% under the peak
const CRASH_BPS = 120; // skip dip-buys when the 60-bar return is under -1.20%
const CRASH_LOOKBACK = 60; // bars for the crash filter
const FALLBACK_SEQ = 1200; // first batch that may open the fallback trade
const LAST_BUY_SEQ = 1435; // do not open a position after this batch
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
const MIN_NOTIONAL = 1000000n; // 1 USDC, in quote units
const PRICE_TO_USD = 100000; // a bar's "c" is an integer at 1e5 per USD

const closes: number[] = []; // closes in USD, in arrival order
let ema: number | null = null; // EMA(240) value, null until seeded
const warm: number[] = []; // closes collected while seeding the EMA
let entryPrice: number | null = null; // fill price of the open position (USD)
let peak: number | null = null; // highest close seen while holding (USD)
let mode: 'dip' | 'fallback' | null = null; // which leg opened the position
let traded = false; // true once a buy has filled
let pendingBuy: string | null = null; // client_id of a buy awaiting its fill

function pushClose(closeUsd: number): void {
  closes.push(closeUsd);
  if (ema === null) {
    warm.push(closeUsd);
    if (warm.length === EMA_SPAN) {
      ema = warm.reduce((a, x) => a + x, 0) / EMA_SPAN;
      warm.length = 0;
    }
  } else {
    ema += (2 / (EMA_SPAN + 1)) * (closeUsd - ema);
  }
}

function noteFills(batch: Batch): void {
  // Learn the fill price of the pending buy, or clear it if rejected.
  if (pendingBuy === null) return;
  for (const fill of batch.fills) {
    if (fill.client_id !== pendingBuy) continue;
    if (fill.status === 'filled') {
      entryPrice = Number(fill.price) / PRICE_TO_USD;
      peak = entryPrice;
      traded = true;
    }
    // A rejected buy leaves the bot flat: forget it either way.
    pendingBuy = null;
  }
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  noteFills(batch);
  for (const bar of batch.bars) {
    if (bar.symbol === SYMBOL) pushClose(Number(bar.c) / PRICE_TO_USD);
  }
  if (state.warmingUp || ema === null || closes.length === 0) return [];
  const close = closes[closes.length - 1];
  const held = state.positions.get(SYMBOL);

  if (held !== undefined) {
    if (peak === null) peak = close;
    else if (close > peak) peak = close;
    const sell = (qty: bigint): OrderInput[] => [
      { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS },
    ];
    if (entryPrice !== null && close <= entryPrice * (1 - STOP_BPS / 10000)) {
      return sell(held.qty);
    }
    if (mode === 'dip' && close >= ema) return sell(held.qty);
    if (mode === 'fallback' && close <= peak * (1 - TRAIL_BPS / 10000)) {
      return sell(held.qty);
    }
    return [];
  }

  // Flat: look for an entry. Never open in the last bars of the window.
  if (state.seq > LAST_BUY_SEQ || state.cash < MIN_NOTIONAL) return [];
  const dip = close <= ema * (1 - DIP_BPS / 10000);
  if (dip) {
    if (closes.length > CRASH_LOOKBACK) {
      const ret60 = close / closes[closes.length - 1 - CRASH_LOOKBACK] - 1;
      if (ret60 >= -CRASH_BPS / 10000) {
        mode = 'dip';
        pendingBuy = state.clientId();
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            client_id: pendingBuy,
            notional_quote_units: state.cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    }
    return [];
  }
  if (state.seq >= FALLBACK_SEQ && !traded && close > ema) {
    // Same crash guard as the dip leg: never chase a falling market late.
    if (closes.length > CRASH_LOOKBACK) {
      const ret60 = close / closes[closes.length - 1 - CRASH_LOOKBACK] - 1;
      if (ret60 < -CRASH_BPS / 10000) return [];
    }
    mode = 'fallback';
    pendingBuy = state.clientId();
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        client_id: pendingBuy,
        notional_quote_units: state.cash,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

await runBars({ onBatch });
