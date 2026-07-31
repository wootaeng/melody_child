import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinSamples, JOIN_GAP_SEC, MAX_TOTAL_SEC, JOIN_GAIN_MAX } from '../src/recorder.js';

const SR = 48000;
const tone = (sec, amp) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin(i));

// 이어붙이기는 "세션이 살아 있는 동안 여러 번 녹음해 한 곡으로" 만들기 위한 것이다.
// 실기 요청이라 조각 개수는 둘로 끝나지 않는다.

test('여러 조각을 순서대로 잇고 사이에 무음을 넣는다', () => {
  // 진폭을 통일한다 — 다르면 피크 맞추기가 값을 바꾸고(아래 별도 테스트) 이 테스트가
  // 검증하려는 것(각 조각의 위치)이 흐려진다.
  const a = tone(0.5, 0.5);
  const b = tone(0.3, 0.5);
  const c = tone(0.2, 0.5);
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

// 이어 녹음의 음량 격차. 슬라이서 임계값이 합친 녹음 전체의 최대 프레임에서 나오므로
// 격차를 그대로 두면 조용한 녹음이 음절로 잡히지 않고, 챈트 재생 범위(bounds)에 들지
// 못해 통째로 사라진다 — 실기 판정 "말한 내용 중 일부가 사라진다"의 한 갈래다.

const peakOf = (s, from = 0, to = s.length) => {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(s[i]));
  return peak;
};

test('조용한 녹음의 피크를 큰 녹음에 맞춘다', () => {
  const loud = tone(0.4, 0.6);
  const quiet = tone(0.4, 0.075); // 8배 작다
  const out = joinSamples([loud, quiet], SR);
  const quietAt = loud.length + Math.round(JOIN_GAP_SEC * SR);
  const loudPeak = peakOf(out, 0, loud.length);
  assert.ok(Math.abs(loudPeak - peakOf(loud)) < 1e-9, '큰 녹음이 바뀌었다');
  assert.ok(
    Math.abs(peakOf(out, quietAt) / loudPeak - 1) < 0.01,
    `조용한 녹음이 큰 녹음의 ${(peakOf(out, quietAt) / loudPeak).toFixed(2)}배에 머물렀다`,
  );
});

test('맞춘 뒤에도 피크가 원래 최대를 넘지 않는다 (클리핑 없음)', () => {
  const out = joinSamples([tone(0.3, 0.95), tone(0.3, 0.1), tone(0.3, 0.5)], SR);
  assert.ok(peakOf(out) <= 0.95 + 1e-6, `피크 ${peakOf(out)}`);
});

test('거의 무음인 녹음을 상한 이상으로 증폭하지 않는다', () => {
  const loud = tone(0.3, 0.8);
  const noise = tone(0.3, 0.001); // 800배 차이 — 실제로 더 크게 말해야 한다
  const out = joinSamples([loud, noise], SR);
  const at = loud.length + Math.round(JOIN_GAP_SEC * SR);
  assert.ok(
    peakOf(out, at) <= 0.001 * JOIN_GAIN_MAX + 1e-6,
    `잡음이 ${peakOf(out, at).toFixed(4)}까지 올라갔다`,
  );
});

test('무음만 든 녹음이 섞여도 터지지 않는다', () => {
  const voice = tone(0.2, 0.5);
  const out = joinSamples([voice, new Float32Array(Math.round(0.2 * SR))], SR);
  assert.ok(Number.isFinite(peakOf(out)));
  assert.equal(peakOf(out), peakOf(voice));
});

test('총 길이 상한이 녹음 한 번보다 넉넉하다', () => {
  // 상한이 한 번 녹음(30초)보다 짧으면 첫 녹음부터 거부된다
  assert.ok(MAX_TOTAL_SEC >= 60, `${MAX_TOTAL_SEC}초`);
});
