import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinSamples, JOIN_GAP_SEC, matchLevels, JOIN_GAIN_MAX } from '../src/recorder.js';
import { sliceSyllables, coverQuietEdges } from '../src/slicer.js';
import { alignToBeats } from '../src/synth.js';

// 이어 녹음에서 조용한 쪽이 사라지지 않는다 — **두 모듈의 계약**이라 여기서 함께 본다.
//
// 방어선이 둘이다:
//   1) recorder.matchLevels가 레벨을 맞춰 슬라이서가 조용한 녹음도 음절로 잡게 한다.
//   2) 그래도 못 잡으면 slicer.coverQuietEdges가 마지막 조각의 꼬리로 흡수한다 —
//      이쪽은 COVER_GAP_MS(300ms)가 JOIN_GAP_SEC(250ms)보다 커야 성립한다.
// 순수 모듈이 recorder를 import하지 않기 위해 그 관계를 산술이 아니라 이 파일이 지킨다.

const SR = 48000;

function speech(spec) {
  const total = spec.reduce((s, x) => s + x.sec + x.gap, 0);
  const out = new Float32Array(Math.round(total * SR));
  let pos = 0;
  for (const { sec, gap, amp, f0 = 220 } of spec) {
    const n = Math.round(sec * SR);
    const fade = Math.round(0.012 * SR);
    for (let i = 0; i < n; i++) {
      const ph = (2 * Math.PI * f0 * i) / SR;
      const env = Math.min(1, i / fade, (n - i) / fade);
      out[pos + i] = (amp * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph))) / 1.75;
    }
    pos += n + Math.round(gap * SR);
  }
  return out;
}

const syl = (amp, gap = 0.1) => ({ sec: 0.25, gap, amp });
const loudRec = () => speech([syl(0.5), syl(0.48), syl(0.46)]);
const quietRec = (amp) => speech([syl(amp), syl(amp), syl(amp)]);

// 합친 녹음에서 두 번째 녹음 구간이 실제로 재생되는 길이(초)
function playedInSecondHalf(chunks) {
  const joined = joinSamples(chunks, SR);
  const secondFrom = chunks[0].length + Math.round(JOIN_GAP_SEC * SR);
  const found = sliceSyllables(joined, SR);
  assert.ok(found.length > 0, '첫 녹음조차 검출되지 않는 픽스처다');
  const bounds = coverQuietEdges(joined, SR, found);
  const { placed } = alignToBeats(bounds, SR, 60 / 108);
  // 재생되는 원본 구간과 두 번째 녹음 구간의 교집합
  let played = 0;
  for (const c of placed) {
    const from = Math.max(c.from * SR, secondFrom);
    const to = Math.min((c.from + c.readSec) * SR, joined.length);
    if (to > from) played += (to - from) / SR;
  }
  return { played, total: (joined.length - secondFrom) / SR };
}

test('두 번째 녹음이 8배 작아도 재생된다', () => {
  const { played, total } = playedInSecondHalf([loudRec(), quietRec(0.0625)]);
  assert.ok(
    played >= total * 0.9,
    `두 번째 녹음 ${total.toFixed(2)}초 중 ${played.toFixed(2)}초만 재생된다`,
  );
});

test('두 번째 녹음에 충격음이 들어 있어도 재생된다', () => {
  // 레벨 기준이 표본 최대 피크였을 때는 이 클릭 하나가 게인을 1로 떨어뜨려
  // 조용한 녹음이 그대로 사라졌다(실측 390ms 손실 재발).
  const quiet = quietRec(0.05);
  const at = Math.round(0.02 * SR);
  for (let i = at; i < at + Math.round(0.008 * SR); i++) quiet[i] = i % 2 ? 0.5 : -0.5;
  const { played, total } = playedInSecondHalf([loudRec(), quiet]);
  assert.ok(
    played >= total * 0.9,
    `두 번째 녹음 ${total.toFixed(2)}초 중 ${played.toFixed(2)}초만 재생된다`,
  );
});

test('이어 녹음 앞에 뜸을 들여도 재생된다 (조인 무음 + 앞 침묵)', () => {
  // "이어서 녹음"을 누르고 200ms 뒤에 말하기 시작한 경우. 조인 무음 250ms와 합쳐
  // 450ms가 되므로 coverQuietEdges의 300ms만으로는 건널 수 없다 — matchLevels가
  // 검출을 살리는 것이 첫 방어선이어야 한다는 뜻이다.
  const quiet = joinSamples([new Float32Array(Math.round(0.2 * SR)), quietRec(0.06)], SR, 0);
  const { played, total } = playedInSecondHalf([loudRec(), quiet]);
  assert.ok(
    played >= total * 0.8,
    `두 번째 녹음 ${total.toFixed(2)}초 중 ${played.toFixed(2)}초만 재생된다`,
  );
});

const peakOf = (s) => {
  let p = 0;
  for (const v of s) p = Math.max(p, Math.abs(v));
  return p;
};

test('이어 녹음을 반복해도 상한을 넘지 않는다 (원본 청크를 매번 넘기는 계약)', () => {
  // ui.js는 원본 녹음을 모아 회차마다 전부 넘긴다. 그 계약이 깨지면(이미 맞춘 결과에
  // 새 녹음만 붙여 다시 부르면) 상한이 곱해져 첫 녹음이 원본의 64배까지 커진다 —
  // 잡음 바닥이 그만큼 올라온다.
  const originals = [quietRec(0.01), quietRec(0.08), loudRec()];
  let result = null;
  for (let n = 1; n <= originals.length; n++) result = matchLevels(originals.slice(0, n), SR);
  const gain = peakOf(result[0]) / peakOf(originals[0]);
  assert.ok(gain <= JOIN_GAIN_MAX * 1.05, `첫 녹음이 원본의 ${gain.toFixed(1)}배 — 상한 ${JOIN_GAIN_MAX}`);
});

test('맞춘 뒤 피크가 천장을 넘지 않는다 (트랜지언트가 있어도)', () => {
  const quiet = quietRec(0.03);
  const at = Math.round(0.05 * SR);
  for (let i = at; i < at + Math.round(0.006 * SR); i++) quiet[i] = i % 2 ? 0.6 : -0.6;
  const out = matchLevels([loudRec(), quiet], SR);
  for (const [i, part] of out.entries()) {
    assert.ok(peakOf(part) <= 1, `조각 ${i} 피크 ${peakOf(part).toFixed(3)}`);
  }
});
