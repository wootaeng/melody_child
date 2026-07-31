import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceSyllables, coverQuietEdges, HOP_MS } from '../src/slicer.js';
import { RIDE_HOP_MS } from '../src/leveler.js';
import { makeDevSample, DEV_SAMPLE_F0S, DEV_SAMPLE_BURST_SEC } from '../src/devsample.js';

const SR = 48000;

test('합성 신호에서 버스트 개수만큼 조각을 찾는다', () => {
  const segs = sliceSyllables(makeDevSample(SR), SR);
  assert.equal(segs.length, DEV_SAMPLE_F0S.length);
});

test('각 조각의 길이가 버스트 길이와 두 홉 이내로 일치한다', () => {
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

test('배경 잡음이 섞여도 버스트 개수를 찾는다', () => {
  let seed = 7;
  const noisy = Float32Array.from(makeDevSample(SR), (v) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return v + (seed / 0x3fffffff - 1) * 0.01;
  });
  assert.equal(sliceSyllables(noisy, SR).length, DEV_SAMPLE_F0S.length);
});

test('충격음이 섞여도 조용한 발화를 잃지 않는다', () => {
  // 10ms 스파이크(진폭 1.0) + 200ms 발화(진폭 0.05).
  // 스파이크가 기준을 정하면 발화가 전부 임계값 미달이 되어 사라진다.
  const n = Math.round(0.6 * SR);
  const s = new Float32Array(n);
  for (let i = 0; i < Math.round(0.01 * SR); i++) s[i] = i % 2 ? 1 : -1;
  const from = Math.round(0.3 * SR);
  for (let i = from; i < from + Math.round(0.2 * SR); i++) {
    s[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  const segs = sliceSyllables(s, SR);
  assert.equal(segs.length, 1, `조각 ${segs.length}개 — 발화가 사라졌다`);
  const len = segs[0].end - segs[0].start;
  assert.ok(
    len >= Math.round(0.15 * SR),
    `발화 조각이 너무 짧다: ${((len / SR) * 1000).toFixed(0)}ms`,
  );
});

// 조각 밖의 조용한 발화. 챈트 재생 범위는 bounds에서만 나오므로(synth.voiceSpan·
// alignToBeats) 조각 앞뒤에 남은 소리는 **재생되지 않는다** — 실기 판정 "말한 내용 중
// 일부가 사라진다"의 원인이다. 슬라이서 임계(-14dB)는 음절 경계를 찾는 값이고,
// 그보다 조용한 어절 끝음절·조사·무성 자음은 애초에 조각 밖에 남는다.

// 결정적 잡음. **정확한 0을 배경으로 쓰면 안 된다** — 확장은 "소리가 있는 프레임"에서만
// 갱신되므로 배경이 0이면 어떤 바닥 설정에서도 침묵을 흡수하지 않고, 그러면 "침묵을
// 들이지 않는다" 테스트가 실패할 수 없는 항등식이 된다(리뷰 지적). 실제 녹음의 룸톤은
// 0이 아니고, 그 사실이 확장 폭주 회귀를 만들었다.
function noisy(n, amp = 0.003) {
  let seed = 7;
  return Float32Array.from({ length: n }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x3fffffff - 1) * amp;
  });
}

// 조용한 발화(진폭 quiet)로 시작해 큰 발화로 갔다가 다시 조용해지는 녹음.
// 배경은 룸톤(noiseAmp)이고 lead 구간은 "말하기 전 침묵"이다.
function edgeSample({
  quiet = 0.05, loud = 0.5, quietSec = 0.2, loudSec = 0.3, leadSec = 0, noiseAmp = 0.003,
} = {}) {
  const n = Math.round((leadSec + quietSec * 2 + loudSec) * SR);
  const s = noisy(n, noiseAmp);
  const tone = (i, amp) => amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  const lead = Math.round(leadSec * SR);
  const q = Math.round(quietSec * SR);
  const l = Math.round(loudSec * SR);
  for (let i = 0; i < q; i++) s[lead + i] += tone(i, quiet);
  for (let i = 0; i < l; i++) s[lead + q + i] += tone(i, loud);
  for (let i = 0; i < q; i++) s[lead + q + l + i] += tone(i, quiet);
  return { samples: s, quietFrom: lead, quietTo: lead + q * 2 + l };
}

test('조각 앞뒤의 조용한 발화를 재생 범위에 넣는다', () => {
  const { samples, quietFrom, quietTo } = edgeSample();
  const found = sliceSyllables(samples, SR);
  assert.equal(found.length, 1, '큰 발화 하나만 조각으로 잡혀야 하는 픽스처다');
  // 확인: 조용한 앞뒤가 실제로 조각 밖에 있다 — 이게 사라지는 소리다
  assert.ok(found[0].start > quietFrom, '픽스처가 앞의 조용한 발화를 이미 포함한다');
  assert.ok(found[0].end < quietTo, '픽스처가 뒤의 조용한 발화를 이미 포함한다');

  const covered = coverQuietEdges(samples, SR, found);
  const hop = Math.round(0.02 * SR);
  assert.ok(
    covered[0].start <= quietFrom + hop,
    `앞의 조용한 발화가 ${(((covered[0].start - quietFrom) / SR) * 1000).toFixed(0)}ms 남았다`,
  );
  assert.ok(
    covered.at(-1).end >= quietTo - hop,
    `뒤의 조용한 발화가 ${(((quietTo - covered.at(-1).end) / SR) * 1000).toFixed(0)}ms 잘렸다`,
  );
});

test('녹음 앞의 긴 침묵은 들이지 않는다 (룸톤이 있어도)', () => {
  // 버튼을 누르고 말하기까지의 침묵. 이걸 흡수하면 곡이 침묵으로 시작한다.
  const { samples, quietFrom } = edgeSample({ leadSec: 1.0 });
  const covered = coverQuietEdges(samples, SR, sliceSyllables(samples, SR));
  assert.ok(
    covered[0].start >= quietFrom - Math.round(0.06 * SR),
    `침묵을 ${(((quietFrom - covered[0].start) / SR) * 1000).toFixed(0)}ms 들였다`,
  );
});

test('조용히 말한 녹음에서도 확장이 폭주하지 않는다', () => {
  // 룸톤 대비 목소리가 작으면(프레임 SNR ≈ -34dB) 바닥 추정이 흔들린다. 이 조건에서
  // 확장이 녹음 전체로 번져 곡이 증폭된 룸톤으로 1.2초 시작했다(리뷰 실측).
  const { samples, quietFrom, quietTo } = edgeSample({
    quiet: 0.02, loud: 0.10, leadSec: 1.2, noiseAmp: 0.003,
  });
  const found = sliceSyllables(samples, SR);
  const covered = coverQuietEdges(samples, SR, found);
  const grownBefore = (found[0].start - covered[0].start) / SR;
  const grownAfter = (covered.at(-1).end - found.at(-1).end) / SR;
  assert.ok(grownBefore <= 0.4 + 1e-9, `앞으로 ${(grownBefore * 1000).toFixed(0)}ms 번졌다`);
  assert.ok(grownAfter <= 0.4 + 1e-9, `뒤로 ${(grownAfter * 1000).toFixed(0)}ms 번졌다`);
  // 말하기 전 침묵(0~1.2초)에 발을 들이지 않는다
  assert.ok(
    covered[0].start >= quietFrom - Math.round(0.06 * SR),
    `침묵을 ${(((quietFrom - covered[0].start) / SR) * 1000).toFixed(0)}ms 들였다`,
  );
  assert.ok(covered.at(-1).end <= quietTo + Math.round(0.06 * SR));
});

test('조각 앞의 충격음을 흡수하지 않는다 (voiceGain 보호)', () => {
  // 버튼 탭·책상 소리. 슬라이서는 minSegMs로 걸러내지만 확장이 흡수하면 mixLevels가
  // 그 피크를 목소리 피크로 오인해 voiceGain이 11.1배 → 1.0배로 무너진다(실효 -14.3dB).
  const n = Math.round(1.2 * SR);
  const s = noisy(n);
  const tap = Math.round(0.02 * SR);
  for (let i = tap; i < tap + Math.round(0.01 * SR); i++) s[i] = i % 2 ? 0.9 : -0.9;
  const voiceFrom = Math.round(0.25 * SR);
  for (let i = voiceFrom; i < voiceFrom + Math.round(0.6 * SR); i++) {
    s[i] += 0.08 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  const found = sliceSyllables(s, SR);
  assert.equal(found.length, 1, '픽스처: 목소리만 조각으로 잡힌다');
  const covered = coverQuietEdges(s, SR, found);
  let peak = 0;
  for (let i = covered[0].start; i < covered[0].end; i++) peak = Math.max(peak, Math.abs(s[i]));
  assert.ok(peak < 0.5, `재생 범위가 충격음(피크 ${peak.toFixed(2)})을 삼켰다`);
});

// 숨소리·바람소리는 확장이 노리는 조용한 발화와 **같은 레벨대**에 있다(12차 실기:
// "사라지는 말은 없어졌는데 잡음이 붙는다"). 갈라지는 축은 레벨이 아니라 스펙트럼이고,
// 여기서는 제로 크로싱 비율로 본다.

// 성도를 통과한 숨소리 = 대역 잡음(2차 대역통과). **백색잡음의 1차 차분을 쓰면 안 된다**
// — 그 신호의 ZCR이 32,400/s로 실제 무성 마찰음(3,000~5,000/s)의 6~10배라, 그것으로
// 교정한 판별 지표가 현실에서 무동작이었다(12차에 되돌린 ZCR 가드). 픽스처의 교정이
// 곧 판정의 신뢰도다.
function breath(n, amp, centerHz = 1500, q = 1.2) {
  let seed = 11;
  const w = (2 * Math.PI * centerHz) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w);
  const a2 = 1 - alpha;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const x = seed / 0x3fffffff - 1;
    const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
    if (Math.abs(y) > peak) peak = Math.abs(y);
  }
  for (let i = 0; i < n; i++) out[i] *= amp / (peak || 1);
  return out;
}

test('말끝 뒤의 숨소리를 흡수하지 않는다', () => {
  const n = Math.round(1.2 * SR);
  const s = noisy(n);
  for (let i = 0; i < Math.round(0.4 * SR); i++) {
    s[Math.round(0.1 * SR) + i] += 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  // 말이 끝나고 60ms 뒤 입으로 내쉬는 숨 300ms. 발화 대비 -23.7dB로, 조용한 조사
  // (-18.4dB)와 5dB밖에 차이가 없다 — 바닥이 그 사이를 지나야 한다.
  const breathFrom = Math.round(0.56 * SR);
  const puff = breath(Math.round(0.3 * SR), 0.05);
  for (let i = 0; i < puff.length; i++) s[breathFrom + i] += puff[i];

  const found = sliceSyllables(s, SR);
  const covered = coverQuietEdges(s, SR, found);
  assert.ok(
    covered.at(-1).end <= breathFrom + Math.round(0.06 * SR),
    `숨소리를 ${(((covered.at(-1).end - breathFrom) / SR) * 1000).toFixed(0)}ms 삼켰다`,
  );
  // 바닥이 실제로 이 판정을 하고 있다는 증거 — 바닥을 내리면 흡수된다. 이게 없으면
  // 픽스처가 우연히 통과하는 것과 구분되지 않는다(12차에 되돌린 ZCR 가드가 그랬다).
  const loose = coverQuietEdges(s, SR, found, { floorRatio: 0.02 });
  assert.ok(
    loose.at(-1).end > covered.at(-1).end,
    '바닥을 내려도 결과가 같다 — 이 테스트는 바닥을 검증하지 않는다',
  );
});

test('바람소리(저역 럼블)를 흡수하지 않는다', () => {
  const n = Math.round(1.2 * SR);
  const s = noisy(n);
  for (let i = 0; i < Math.round(0.4 * SR); i++) {
    s[Math.round(0.1 * SR) + i] += 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  // 저역 럼블은 스펙트럼 지표로는 발화와 갈라지지 않는다(저역통과가 판별 근거를
  // 걷어낸다) — 레벨로만 막을 수 있다. -20.1dB.
  const from = Math.round(0.56 * SR);
  const wind = breath(Math.round(0.3 * SR), 0.08, 120);
  for (let i = 0; i < wind.length; i++) s[from + i] += wind[i];

  const covered = coverQuietEdges(s, SR, sliceSyllables(s, SR));
  assert.ok(
    covered.at(-1).end <= from + Math.round(0.06 * SR),
    `바람소리를 ${(((covered.at(-1).end - from) / SR) * 1000).toFixed(0)}ms 삼켰다`,
  );
});

test('숨소리보다 큰 조용한 발화는 흡수한다 (창이 좁다)', () => {
  // 위 두 테스트와 같은 배치인데 꼬리가 잡음이 아니라 조용한 모음(-17dB)이다.
  //
  // **레벨이 유일한 축이므로 이 테스트와 위 두 개가 함께 바닥을 양쪽에서 조인다.**
  // 숨소리(입으로 -23.7dB)와 조용한 조사(-18.4dB) 사이 여유가 5dB뿐이고, 이보다 조용한
  // 발화는 잡음과 함께 버려진다 — 그게 이 기능의 한계이고 실기 판정이 택한 쪽이다.
  const n = Math.round(1.2 * SR);
  const s = noisy(n);
  for (let i = 0; i < Math.round(0.4 * SR); i++) {
    s[Math.round(0.1 * SR) + i] += 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  const tailFrom = Math.round(0.56 * SR);
  const tailTo = tailFrom + Math.round(0.2 * SR);
  for (let i = tailFrom; i < tailTo; i++) {
    const ph = (2 * Math.PI * 200 * (i - tailFrom)) / SR;
    s[i] += (0.07 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph))) / 1.5;
  }
  const found = sliceSyllables(s, SR);
  const covered = coverQuietEdges(s, SR, found);
  assert.ok(
    covered.at(-1).end >= tailTo - Math.round(0.04 * SR),
    `조용한 발화가 ${(((tailTo - covered.at(-1).end) / SR) * 1000).toFixed(0)}ms 잘렸다`,
  );
});

test('한 방향 확장에 상한이 있다', () => {
  // 바닥 추정이 틀리는 녹음에서도 피해를 상한으로 묶는다.
  const { samples } = edgeSample({ quietSec: 1.5, quiet: 0.06, loud: 0.5 });
  const found = sliceSyllables(samples, SR);
  const covered = coverQuietEdges(samples, SR, found);
  assert.ok((found[0].start - covered[0].start) / SR <= 0.4 + 1e-9);
  assert.ok((covered.at(-1).end - found.at(-1).end) / SR <= 0.4 + 1e-9);
});

test('어절 사이 쉼을 건너서도 조용한 발화를 찾는다', () => {
  // 큰 발화 → 150ms 쉼 → 조용한 끝음절. 쉼이 슬라이서의 minGap(60ms)을 넘으므로
  // 그 기준으로 멈추면 끝음절이 사라진다(실측 353ms).
  const n = Math.round(1.0 * SR);
  const s = new Float32Array(n);
  const tone = (i, amp) => amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  for (let i = 0; i < Math.round(0.3 * SR); i++) s[i] = tone(i, 0.5);
  const quietFrom = Math.round(0.45 * SR); // 150ms 쉼 뒤
  const quietTo = quietFrom + Math.round(0.2 * SR);
  for (let i = quietFrom; i < quietTo; i++) s[i] = tone(i - quietFrom, 0.06);

  const found = sliceSyllables(s, SR);
  assert.equal(found.length, 1, '픽스처: 큰 발화만 조각으로 잡힌다');
  const covered = coverQuietEdges(s, SR, found);
  assert.ok(
    covered.at(-1).end >= quietTo - Math.round(0.02 * SR),
    `쉼 뒤의 조용한 발화가 ${(((quietTo - covered.at(-1).end) / SR) * 1000).toFixed(0)}ms 잘렸다`,
  );
});

test('조각 사이는 건드리지 않는다 (겹침·병합 없음)', () => {
  const found = sliceSyllables(makeDevSample(SR), SR);
  const covered = coverQuietEdges(makeDevSample(SR), SR, found);
  assert.equal(covered.length, found.length);
  for (let i = 1; i < covered.length; i++) {
    assert.ok(covered[i].start >= covered[i - 1].end, `조각 ${i - 1}과 ${i}가 겹친다`);
  }
  // 가운데 조각은 그대로다 — 확장은 첫 조각의 앞과 마지막 조각의 뒤에서만 한다
  for (let i = 1; i < covered.length - 1; i++) {
    assert.deepEqual(covered[i], found[i]);
  }
});

test('조각이 없으면 그대로 돌려준다', () => {
  assert.deepEqual(coverQuietEdges(new Float32Array(SR), SR, []), []);
});

test('확장은 녹음 경계를 넘지 않는다', () => {
  const { samples } = edgeSample({ quiet: 0.05, quietSec: 0.15, loudSec: 0.25 });
  const found = sliceSyllables(samples, SR);
  const covered = coverQuietEdges(samples, SR, found);
  // 확장이 실제로 일어난 픽스처여야 한다 — 0이면 아래 두 assert는 공허하게 통과한다
  assert.ok(covered[0].start < found[0].start, '픽스처에서 확장이 일어나지 않았다');
  assert.ok(covered.at(-1).end > found.at(-1).end, '픽스처에서 확장이 일어나지 않았다');
  assert.ok(covered[0].start >= 0);
  assert.ok(covered.at(-1).end <= samples.length);
});

test('프레임 격자를 leveler와 공유한다', () => {
  // coverQuietEdges는 bounds가 이 격자에 양자화돼 있다고 보고 프레임 인덱스를 되돌린다.
  // 두 모듈의 홉이 갈라지면 조용히 어긋나므로 상수 하나에서 나와야 한다.
  assert.equal(HOP_MS, RIDE_HOP_MS);
});

test('무음 구간이 없는 연속 음성도 버퍼 끝까지 한 조각으로 검출한다', () => {
  const n = SR; // 1초 내내 소리
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const segs = sliceSyllables(s, SR);
  assert.equal(segs.length, 1, `조각 ${segs.length}개 — 연속 음성이 미검출됐다`);
  assert.ok(segs[0].end <= n, `end ${segs[0].end}이 버퍼 길이 ${n}을 넘는다`);
  assert.ok(segs[0].end - segs[0].start > 0.9 * n, '마지막 조각이 버퍼 끝까지 이어지지 않는다');
});
