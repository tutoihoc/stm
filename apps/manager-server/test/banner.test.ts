import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapBanner } from '../src/banner.js';

const ESCAPE = '';

const base = {
  title: 'ST Manager 0.1.0',
  addresses: [
    { label: 'On this computer', url: 'http://127.0.0.1:7860' },
    { label: 'On this Wi-Fi', url: 'http://192.168.1.25:7860' },
  ],
  stopHint: 'Press Ctrl+C to stop.',
} as const;

test('piped into a file, the banner is text and nothing else', () => {
  const banner = bootstrapBanner({ ...base, colour: false });
  // A service manager's journal and a redirected log get no escapes.
  assert.equal(banner.includes(ESCAPE), false);
  assert.ok(banner.includes('http://127.0.0.1:7860'));
  assert.ok(banner.includes('http://192.168.1.25:7860'));
  assert.ok(banner.includes('Press Ctrl+C to stop.'));
});

test('the addresses line up under one another', () => {
  const banner = bootstrapBanner({ ...base, colour: false });
  const columns = banner.split('\n')
    .filter((line) => line.includes('http://'))
    .map((line) => line.indexOf('http://'));
  assert.equal(new Set(columns).size, 1, `addresses start at ${columns.join(' and ')}`);
});

test('nothing is drawn in the terminal, however wide it is', () => {
  // The banner used to draw the Wi-Fi address as a scannable code, which was
  // half a window tall on every start. The console carries the code now, on
  // the address it belongs to; the terminal gets the addresses and nothing else.
  for (const width of [20, 80, 200]) {
    const banner = bootstrapBanner({ ...base, colour: true, width });
    assert.equal(banner.includes('▀'), false, `width ${width}`);
    assert.ok(banner.includes('http://192.168.1.25:7860'), `width ${width}`);
  }
});

test('a colour terminal gets the addresses and the hint, in colour', () => {
  const banner = bootstrapBanner({ ...base, colour: true });
  assert.ok(banner.includes(ESCAPE));
  assert.ok(banner.includes('http://127.0.0.1:7860'));
  assert.ok(banner.includes('Press Ctrl+C to stop.'));
});
