import test from 'node:test';
import assert from 'node:assert/strict';
import { TickFeed } from '../src/tickfeed.js';
import { Market } from '../src/market.js';
import { APP } from '../src/config.js';

test('small seeded universe waits for refresh interval after exhausting queue', async () => {
  const original = Date.now;
  let now = 1000000;
  Date.now = () => now;
  try {
    const feed = new TickFeed({ symbols: new Map([['A', { seeded: true }]]) }, {});
    feed.queues = [{ plan: { levels: ['1m'], everyMs: 90000 }, items: [], cursor: 0, startedAt: 0 }];
    let calls = 0;
    feed.refreshOne = async () => { calls++; };
    for (let i = 0; i < 90; i++) { await feed.scheduleRefresh(); now += 1000; }
    assert.equal(calls, 1);
    await feed.scheduleRefresh();
    assert.equal(calls, 2);
  } finally { Date.now = original; }
});

test('empty startup queue accepts first ready symbol immediately', async () => {
  const market = { symbols: new Map() };
  const feed = new TickFeed(market, {});
  let calls = 0;
  feed.refreshOne = async () => { calls++; };
  await feed.scheduleRefresh();
  assert.equal(calls, 0);
  market.symbols.set('A', { seeded: true });
  await feed.scheduleRefresh();
  assert.ok(calls > 0);
});

test('unseeded symbols retry on universe refresh, without overlapping active bootstrap', async () => {
  const rest = { get: async () => [{ symbol: 'TESTUSDT', lastPrice: '1', priceChangePercent: '5', quoteVolume: '9999999999', count: '99999999' }] };
  const log = { info() {}, warn() {}, error() {} };
  const market = new Market(rest, log);
  let attempts = 0;
  market.seedBatch = async list => { attempts += list.length; };
  market.seeding.active = true;
  await market.refreshUniverse();
  assert.equal(attempts, 0);
  market.seeding.active = false;
  await market.refreshUniverse();
  assert.equal(attempts, 1);
  const st = market.symbols.get('TESTUSDT');
  const limits = [];
  rest.get = async url => { limits.push(Number(new URL(url, 'https://example.com').searchParams.get('limit'))); return []; };
  await market.seedSymbol(st);
  assert.ok(limits.every(n => n <= APP.maxCandlesKept));
  assert.equal(market.stats.seededSymbols, 1);
});
