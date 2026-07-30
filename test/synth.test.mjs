import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressAt, voiceSpan } from '../src/synth.js';

// 챈트가 목소리를 어디까지 흘려보내는지. 음절 사이를 건드리지 않는다는 것이
// 이 함수의 요점이다 — 조각을 잘라 이어붙이면 말이 뚝뚝 끊긴다(실기 지적).
test('앞뒤 침묵만 잘라내고 음절 사이는 그대로 둔다', () => {
  const buffer = { sampleRate: 48000, duration: 10 };
  const bounds = [
    { start: 48000, end: 72000 }, // 1.0~1.5초
    { start: 120000, end: 144000 }, // 2.5~3.0초
  ];
  const span = voiceSpan(buffer, bounds);
  assert.equal(span.from, 1);
  // 마지막 음절 끝(3.0초) + 여운 0.25초까지 = 2.25초 분량. 사이의 1초 공백도
  // 그대로 포함된다(자연스러운 이음새라 잘라내면 안 된다).
  assert.equal(+span.sec.toFixed(3), 2.25);
});

test('꼬리 여운이 녹음 끝을 넘지 않는다', () => {
  const buffer = { sampleRate: 48000, duration: 2 };
  const span = voiceSpan(buffer, [{ start: 0, end: 96000 }]);
  assert.equal(span.from, 0);
  assert.equal(span.sec, 2);
});

test('조각이 없으면 녹음 전체', () => {
  const buffer = { sampleRate: 48000, duration: 3.5 };
  assert.deepEqual(voiceSpan(buffer, []), { from: 0, sec: 3.5 });
  assert.deepEqual(voiceSpan(buffer, null), { from: 0, sec: 3.5 });
});

// 진행선의 위치 계산. 캔버스 그리기는 이 하네스에서 관측할 수 없다(창이 가려져
// 있으면 rAF가 1초에 0프레임 — 실측). 그래서 시간→위치 매핑만 여기서 못 박고
// 선이 실제로 보이는지는 실기에서 확인한다.

test('첫 음 이전은 0, 마지막 음 이후는 1', () => {
  const times = [10, 11, 12, 13];
  assert.equal(progressAt(times, 9), 0);
  assert.equal(progressAt(times, 10), 0);
  assert.equal(progressAt(times, 13), 1);
  assert.equal(progressAt(times, 99), 1);
});

test('음 사이를 시간으로 보간한다 (구슬 간격 = 1/(음수-1))', () => {
  const times = [0, 1, 2, 3, 4]; // 구슬 5개 → 간격 0.25
  assert.equal(progressAt(times, 1), 0.25);
  assert.equal(progressAt(times, 1.5), 0.375);
  assert.equal(progressAt(times, 3), 0.75);
});

test('음 길이가 달라도 각 구슬에 정확히 그 시각에 닿는다', () => {
  // 8분음표 짝(0.25초)과 4분음표(0.5초)가 섞인 배치
  const times = [0, 0.5, 0.75, 1, 1.5];
  for (const [i, t] of times.entries()) {
    assert.equal(progressAt(times, t), i / (times.length - 1), `구슬 ${i}`);
  }
  // 구간 중간은 그 구간 안에서만 움직인다
  const mid = progressAt(times, 0.625);
  assert.ok(mid > 0.25 && mid < 0.5, `${mid}`);
});

test('음이 하나뿐이면 0 (나눌 구간이 없다)', () => {
  assert.equal(progressAt([5], 5), 0);
  assert.equal(progressAt([5], 99), 0);
  assert.equal(progressAt([], 1), 0);
});
