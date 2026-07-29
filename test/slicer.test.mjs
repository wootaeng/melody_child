import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceSyllables } from '../src/slicer.js';
import { makeDevSample, DEV_SAMPLE_F0S, DEV_SAMPLE_BURST_SEC } from '../src/devsample.js';

const SR = 48000;

test('합성 신호에서 버스트 개수만큼 조각을 찾는다', () => {
  const segs = sliceSyllables(makeDevSample(SR), SR);
  assert.equal(segs.length, DEV_SAMPLE_F0S.length);
});

test('각 조각의 길이가 버스트 길이와 한 홉 이내로 일치한다', () => {
  const segs = sliceSyllables(makeDevSample(SR), SR);
  const expected = DEV_SAMPLE_BURST_SEC * SR;
  const tolerance = 0.02 * SR * 2; // 홉 20ms의 2배
  for (const [i, s] of segs.entries()) {
    const len = s.end - s.start;
    assert.ok(
      Math.abs(len - expected) <= tolerance,
      `조각 ${i} 길이 ${len}이 기대값 ${expected}에서 ${tolerance} 넘게 벗어남`,
    );
  }
});

test('조각은 순서대로이고 겹치지 않는다', () => {
  const segs = sliceSyllables(makeDevSample(SR), SR);
  for (let i = 0; i < segs.length; i++) {
    assert.ok(segs[i].end > segs[i].start);
    if (i > 0) assert.ok(segs[i].start >= segs[i - 1].end);
  }
});

test('무음만 있으면 빈 배열을 반환한다', () => {
  assert.deepEqual(sliceSyllables(new Float32Array(SR), SR), []);
});

test('minSegMs보다 짧은 조각은 버린다', () => {
  const s = new Float32Array(SR);
  // 10ms짜리 클릭 하나 — minSegMs 기본값 80ms보다 짧다
  for (let i = 1000; i < 1000 + 0.01 * SR; i++) s[i] = 0.8;
  assert.deepEqual(sliceSyllables(s, SR), []);
});
