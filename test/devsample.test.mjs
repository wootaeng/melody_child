import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDevSample,
  DEV_SAMPLE_F0S,
  DEV_SAMPLE_BURST_SEC,
  DEV_SAMPLE_GAP_SEC,
} from '../src/devsample.js';

const SR = 48000;

function rms(samples, fromSec, toSec) {
  const a = Math.round(fromSec * SR);
  const b = Math.round(toSec * SR);
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}

test('Float32Array를 반환하고 클리핑되지 않는다', () => {
  const s = makeDevSample(SR);
  assert.ok(s instanceof Float32Array);
  let peak = 0;
  for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]));
  assert.ok(peak > 0.1, `너무 조용하다: ${peak}`);
  assert.ok(peak <= 1.0, `클리핑됨: ${peak}`);
});

test('버스트 구간은 소리가 있고 갭 구간은 조용하다', () => {
  const s = makeDevSample(SR);
  const step = DEV_SAMPLE_BURST_SEC + DEV_SAMPLE_GAP_SEC;
  for (let i = 0; i < DEV_SAMPLE_F0S.length; i++) {
    const burstMid = i * step + DEV_SAMPLE_BURST_SEC / 2;
    const gapMid = i * step + DEV_SAMPLE_BURST_SEC + DEV_SAMPLE_GAP_SEC / 2;
    assert.ok(rms(s, burstMid - 0.02, burstMid + 0.02) > 0.05, `버스트 ${i}이 조용하다`);
    assert.ok(rms(s, gapMid - 0.02, gapMid + 0.02) < 0.001, `갭 ${i}에 소리가 있다`);
  }
});
