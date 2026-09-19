import test from 'node:test';
import assert from 'node:assert/strict';
import { reachableAddresses, shortenHost } from '../src/addresses.js';

test('the tunnel comes first, then the network, then this machine', () => {
  const all = reachableAddresses({ url: 'https://example.trycloudflare.com' }, { lan: true, port: 8001 }, '192.168.1.20', 8000, true);
  assert.deepEqual(all.map((address) => address.kind), ['tunnel', 'lan', 'local']);
  assert.equal(all[0]?.host, 'example.trycloudflare.com');
  assert.equal(all[1]?.url, 'http://192.168.1.20:8001');
});

test('with nothing shared, this machine is the only address', () => {
  const only = reachableAddresses({ url: null }, { lan: false, port: 8001 }, 'localhost', 8000, true);
  assert.deepEqual(only.map((address) => address.url), ['http://127.0.0.1:8000']);
});

test('moving SillyTavern moves the address that points straight at it', () => {
  // The loopback link used to carry 8000 whatever the console had been told,
  // so every address on the overview pointed at a port SillyTavern had left.
  const moved = reachableAddresses({ url: null }, { lan: false, port: 8001 }, 'localhost', 8003, true);
  assert.deepEqual(moved.map((address) => address.url), ['http://127.0.0.1:8003']);
  assert.equal(moved[0]?.host, '127.0.0.1:8003');
  // The gateway keeps its own port: it is the door, not what is behind it.
  const shared = reachableAddresses({ url: null }, { lan: true, port: 8001 }, '192.168.1.20', 8003, true);
  assert.deepEqual(shared.map((address) => address.url), ['http://192.168.1.20:8001', 'http://127.0.0.1:8003']);
});

test('a fixed address in front of the tunnel is the one offered', () => {
  /*
   * A Quick Tunnel's hostname changes every time cloudflared starts, so it is
   * the wrong thing to hand anybody: the link they save or send stops working
   * on the next restart, and stops as DNS_PROBE_FINISHED_NXDOMAIN because the
   * name has gone from DNS altogether. The Worker address is the same one for
   * good, so it is what the card shows and what the Open button takes.
   */
  const withProxy = reachableAddresses(
    { url: 'https://example.trycloudflare.com', proxyUrl: 'https://sillytavern.acme.workers.dev' },
    { lan: false, port: 8001 },
    'localhost',
    8000,
    false,
  );
  assert.deepEqual(withProxy.map((address) => address.url), ['https://sillytavern.acme.workers.dev']);
  // The tunnel behind it is still worth being able to see: it is what the
  // traffic really goes through, and the share sheet says so.
  assert.equal(withProxy[0]?.via, 'example.trycloudflare.com');

  // With no Cloudflare sign-in there is no Worker, and the tunnel's own
  // address is the only address there is.
  const withoutProxy = reachableAddresses({ url: 'https://example.trycloudflare.com', proxyUrl: null }, { lan: false, port: 8001 }, 'localhost', 8000, false);
  assert.deepEqual(withoutProxy.map((address) => address.url), ['https://example.trycloudflare.com']);
  assert.equal(withoutProxy[0]?.via, undefined);

  // A Worker deployed while the tunnel is off is still the address to show:
  // it answers, and it says the door is shut.
  const tunnelOff = reachableAddresses({ url: null, proxyUrl: 'https://stm.acme.workers.dev' }, { lan: false, port: 8001 }, 'localhost', 8000, false);
  assert.deepEqual(tunnelOff.map((address) => address.url), ['https://stm.acme.workers.dev']);
  assert.equal(tunnelOff[0]?.via, undefined);
});

test('a long host keeps its two ends and a short one is left alone', () => {
  assert.equal(shortenHost('example.trycloudflare.com'), 'exam...flare.com');
  assert.equal(shortenHost('127.0.0.1:8000'), '127.0.0.1:8000');
  assert.equal(shortenHost('192.168.100.200:8001'), '192.168.100.200:8001');
});

test('read from anywhere but the machine itself, the loopback address is not offered', () => {
  // A hosted console is a page served from a container in a data centre. The
  // loopback address there names the reader's own laptop, so offering it as
  // the way in is a link that can only ever fail - and it used to be the one
  // the Open button took.
  const hosted = reachableAddresses({ url: null }, { lan: false, port: 8001 }, '10.0.0.4', 8000, false);
  assert.deepEqual(hosted, []);
  // What is published still counts, and is still in the same order.
  const published = reachableAddresses({ url: 'https://example.trycloudflare.com' }, { lan: true, port: 8001 }, '10.0.0.4', 8000, false);
  assert.deepEqual(published.map((address) => address.kind), ['tunnel', 'lan']);
});
