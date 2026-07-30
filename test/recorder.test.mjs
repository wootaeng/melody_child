import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinSamples, JOIN_GAP_SEC, MAX_TOTAL_SEC } from '../src/recorder.js';

const SR = 48000;
const tone = (sec, amp) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin(i));

// 이어붙이기는 "세션이 살아 있는 동안 여러 번 녹음해 한 곡으로" 만들기 위한 것이다.
// 실기 요청이라 조각 개수는 둘로 끝나지 않는다.

test('여러 조각을 순서대로 잇고 사이에 무음을 넣는다', () => {
  const a = tone(0.5, 0.4);
  const b = tone(0.3, 0.2);
  const c = tone(0.2, 0.6);
  const gap = Math.round(JOIN_GAP_SEC * SR);
  const out = joinSamples([a, b, c], SR);
  assert.equal(out.length, a.length + b.length + c.length + gap * 2);
  // 각 조각이 제자리에 그대로 있다
  assert.deepEqual(out.slice(0, a.length), a);
  assert.deepEqual(out.slice(a.length + gap, a.length + gap + b.length), b);
  const cAt = a.length + gap + b.length + gap;
  assert.deepEqual(out.slice(cAt, cAt + c.length), c);
});

test('무음 구간은 정확히 0이다 (슬라이서가 경계로 잡을 수 있어야 한다)', () => {
  const gap = Math.round(JOIN_GAP_SEC * SR);
  const out = joinSamples([tone(0.3, 0.5), tone(0.3, 0.5)], SR);
  const from = Math.round(0.3 * SR);
  for (let i = from; i < from + gap; i++) {
    assert.equal(out[i], 0, `${i}번 샘플이 0이 아니다`);
  }
  assert.ok(Math.abs(out[from - 1]) > 0 || Math.abs(out[from - 2]) > 0, '앞 조각이 잘렸다');
});

test('조각이 하나면 같은 배열을 그대로 돌려준다 (복사하지 않는다)', () => {
  const a = tone(0.4, 0.3);
  assert.equal(joinSamples([a], SR), a);
});

test('빈 조각은 건너뛴다', () => {
  const a = tone(0.3, 0.4);
  const gap = Math.round(JOIN_GAP_SEC * SR);
  // 첫 녹음이 실패해 빈 배열이 섞여도 무음만 늘어나지 않아야 한다
  assert.equal(joinSamples([new Float32Array(0), a], SR), a);
  assert.equal(joinSamples([a, new Float32Array(0), a], SR).length, a.length * 2 + gap);
  assert.equal(joinSamples([], SR).length, 0);
});

test('무음 길이를 0으로 줄일 수 있다', () => {
  const a = tone(0.2, 0.4);
  assert.equal(joinSamples([a, a], SR, 0).length, a.length * 2);
});

test('총 길이 상한이 녹음 한 번보다 넉넉하다', () => {
  // 상한이 한 번 녹음(30초)보다 짧으면 첫 녹음부터 거부된다
  assert.ok(MAX_TOTAL_SEC >= 60, `${MAX_TOTAL_SEC}초`);
});
