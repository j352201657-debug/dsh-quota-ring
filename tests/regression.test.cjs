'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { clamp, round2, toResetAt } = require('../src/shape');
const { adapters } = require('../src/adapters');
const { createAggregator } = require('../src/aggregator');
const { observeBalance } = require('../src/usage');
const { phaseAt } = require('../src/peak');
const { httpGetJson, httpPostJson, parseProxy } = require('../src/http');
const { resolvePort } = require('../src/adapters/agy');
const { resolveCredentials } = require('../src/credentials');

test('explicit AGY port overrides inference and invalid ports are ignored', () => {
  assert.equal(resolvePort({ dshWebPort: 12345 }, { webPort: 50000 }), 12345);
  assert.equal(resolvePort({ dshWebPort: 0 }, { webPort: 50000 }), 50000);
  assert.equal(resolvePort({ dshWebPort: 70000 }, { webPort: 1.5 }), 0);
});

test('credential reader preserves token characters and observes rotated accounts', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-credential-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const writeFixture = (access) => fs.writeFileSync(path.join(home, '.credentials.yaml'), [
    'records:', '  deepseek-account-platform/default:', '    payload:',
    '      token: "fixture+/token=="', '      issuer: https://platform.deepseek.com',
    '  codex-subscription/accounts:', '    payload:', '      activeId: second', '      accounts:',
    '        - id: first', '          credential:', '            access: unused-fixture',
    '            accountId: account-one', '        - id: second', '          credential:',
    '            access: ' + access, '            accountId: account-two', '            expires: 9999999999999', ''
  ].join('\n'));
  writeFixture('initial-fixture');
  let credentials = resolveCredentials({ dshHome: home });
  assert.equal(credentials.deepseek.token, 'fixture+/token==');
  assert.equal(credentials.codex.accountId, 'account-two');
  assert.equal(credentials.codex.access, 'initial-fixture');
  writeFixture('rotated-fixture');
  credentials = resolveCredentials({ dshHome: home });
  assert.equal(credentials.codex.access, 'rotated-fixture');
});

test('missing percentages stay unknown; numeric zero is valid', () => {
  for (const value of [null, undefined, '', '  ', false, true, NaN]) {
    assert.equal(clamp(value, 0, 100), null);
    assert.equal(round2(value), null);
  }
  assert.equal(clamp(0, 0, 100), 0);
  assert.equal(clamp('40', 0, 100), 40);
  assert.equal(round2(98.59288), 98.59);
});
test('numeric reset timestamps take precedence over date parsing', () => {
  assert.equal(toResetAt('1793894402'), 1793894402000);
  assert.equal(toResetAt('1793894402000'), 1793894402000);
  assert.equal(toResetAt('2026-11-05T10:00:00Z'), Date.parse('2026-11-05T10:00:00Z'));
  assert.equal(toResetAt(null, null), null);
  assert.equal(toResetAt('0'), null);
});
test('concurrent queries share a request and fresh queries reload credentials', async () => {
  const originals = adapters.map((adapter) => adapter.fetch);
  let calls = 0, reads = 0, release;
  let waiting = new Promise((resolve) => { release = resolve; });
  adapters.forEach((adapter) => {
    adapter.fetch = async (credentials) => {
      calls++;
      await waiting;
      return { id: adapter.id, status: 'ok', generation: credentials.generation };
    };
  });
  try {
    const agg = createAggregator({ serverCacheTtlMs: 60000 }, () => ({ generation: ++reads }));
    const first = agg.getSummary({ force: true });
    const second = agg.getSummary({ force: true });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a, b);
    assert.equal(calls, adapters.length);
    assert.equal(reads, 1);
    await agg.getSummary();
    assert.equal(reads, 1);
    waiting = Promise.resolve();
    const fresh = await agg.getSummary({ force: true });
    assert.equal(reads, 2);
    assert.equal(fresh.providers[0].generation, 2);
  } finally {
    adapters.forEach((adapter, i) => { adapter.fetch = originals[i]; });
  }
});
test('synchronous adapter failure leaves other provider results available', async () => {
  const originals = adapters.map((adapter) => adapter.fetch);
  adapters.forEach((adapter) => { adapter.fetch = () => ({ id: adapter.id, status: 'ok' }); });
  adapters[0].fetch = () => { throw new Error('fixture failure'); };
  try {
    const result = await createAggregator({ serverCacheTtlMs: 0 }, {}).getSummary();
    assert.equal(result.providers[0].status, 'error');
    assert.equal(result.health.ok, adapters.length - 1);
  } finally {
    adapters.forEach((adapter, i) => { adapter.fetch = originals[i]; });
  }
});
test('ledger persists spend and top-ups and archives the previous day', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const start = Date.parse('2026-11-06T01:00:00Z');
  const observe = (balance, time) => observeBalance({ balance, currency: 'CNY', homeDir: home, nowMs: time });
  assert.equal(observe(10, start).today, 0);
  assert.equal(observe(9.5, start + 60000).today, 0.5);
  assert.equal(observe(19.5, start + 120000).credits, 10);
  assert.equal(observe(18.5, start + 180000).today, 1.5);
  assert.equal(observe(18.5, start + 240000).today, 1.5);
  const next = observe(18.5, start + 86400000);
  assert.equal(next.today, 0);
  assert(next.history.some((row) => row.date === '2026-11-06' && row.amount === 1.5));
});
test('peak schedule distinguishes workdays, weekends and holidays', () => {
  assert.equal(phaseAt(Date.parse('2026-11-06T01:30:00Z')).phase, 'peak');
  assert.equal(phaseAt(Date.parse('2026-11-06T04:30:00Z')).phase, 'offPeak');
  assert.equal(phaseAt(Date.parse('2026-11-07T02:00:00Z')).phase, 'offPeak');
  assert.equal(phaseAt(Date.parse('2026-10-01T02:00:00Z')).phase, 'offPeak');
});
async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: 'http://127.0.0.1:' + server.address().port };
}
test('direct response preserves UTF-8 across packet boundaries', async (t) => {
  const bytes = Buffer.from(JSON.stringify({ message: '额度正常' }));
  const server = http.createServer((req, res) => {
    const split = bytes.indexOf(Buffer.from('额')) + 1;
    res.write(bytes.subarray(0, split));
    setTimeout(() => res.end(bytes.subarray(split)), 10);
  });
  const { url } = await listen(t, server);
  assert.deepEqual(await httpGetJson(url), { message: '额度正常' });
});
test('upstream error bodies are omitted from public errors', async (t) => {
  const server = http.createServer((req, res) => { res.statusCode = 401; res.end('private-token-fixture'); });
  const { url } = await listen(t, server);
  for (const query of [() => httpGetJson(url), () => httpPostJson(url, {})]) {
    await assert.rejects(query, (e) => e.status === 401 && !e.message.includes('private-token-fixture'));
  }
});
for (const stage of ['CONNECT', 'TLS']) {
  test('proxy deadline closes sockets during ' + stage, async (t) => {
    let closed;
    const disconnected = new Promise((resolve) => { closed = resolve; });
    const server = http.createServer();
    server.on('connect', (req, socket) => {
      socket.on('close', closed);
      socket.on('end', () => { socket.end(); closed(); });
      socket.on('data', () => {});
      if (stage === 'TLS') socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    const { url } = await listen(t, server);
    await assert.rejects(httpGetJson('https://quota.example.test/', { proxy: url, timeoutMs: 100 }), /超时/);
    let timer;
    try {
      await Promise.race([disconnected, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('proxy socket remained open')), 1000);
      })]);
    } finally { clearTimeout(timer); }
  });
}
test('proxy parsing handles HTTPS transport and rejects unsupported schemes', () => {
  assert.equal(parseProxy('https://proxy.example').protocol, 'https:');
  assert.equal(parseProxy('https://proxy.example').port, 443);
  assert.equal(parseProxy('http://proxy.example:8080').port, 8080);
  assert.equal(parseProxy('socks5://proxy.example:1080'), null);
});
