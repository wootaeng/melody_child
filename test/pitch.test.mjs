import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectF0, detectF0Detail, findGrain } from '../src/pitch.js';
import { makeDevSample, DEV_SAMPLE_F0S } from '../src/devsample.js';
import { sliceSyllables } from '../src/slicer.js';

const SR = 48000;

function sine(hz, sec, sampleRate = SR) {
  const out = new Float32Array(Math.round(sec * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.7 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

test('440Hz 사인파를 1% 오차 안에 검출한다', () => {
  const f0 = detectF0(sine(440, 0.3), SR);
  assert.ok(f0 !== null, 'null이 반환됐다');
  assert.ok(Math.abs(f0 - 440) / 440 < 0.01, `검출값 ${f0}`);
});

test('낮은 음(110Hz)도 1% 오차 안에 검출한다', () => {
  const f0 = detectF0(sine(110, 0.3), SR);
  assert.ok(f0 !== null && Math.abs(f0 - 110) / 110 < 0.01, `검출값 ${f0}`);
});

test('탐색 범위 상한(1000Hz)에서도 옥타브 오류가 없다', () => {
  const f0 = detectF0(sine(1000, 0.3), SR);
  assert.ok(f0 !== null, 'null이 반환됐다');
  assert.ok(Math.abs(f0 - 1000) / 1000 < 0.01, `검출값 ${f0} — 절반으로 읽혔을 수 있다`);
});

test('탐색 범위 하한(70Hz)도 검출한다', () => {
  const f0 = detectF0(sine(70, 0.3), SR);
  assert.ok(f0 !== null, 'null이 반환됐다');
  assert.ok(Math.abs(f0 - 70) / 70 < 0.01, `검출값 ${f0}`);
});

test('무음은 null', () => {
  assert.equal(detectF0(new Float32Array(SR * 0.3), SR), null);
});

test('백색소음은 null (무성 자음 대용)', () => {
  // 결정적 난수 — 테스트가 흔들리지 않게 LCG 사용
  let s = 42;
  const noise = new Float32Array(Math.round(0.3 * SR));
  for (let i = 0; i < noise.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = s / 0x3fffffff - 1;
  }
  assert.equal(detectF0(noise, SR), null);
});

test('너무 짧은 입력은 null', () => {
  assert.equal(detectF0(sine(440, 0.005), SR), null);
});

test('합성 신호의 각 조각에서 정답 음높이를 복원한다', () => {
  const samples = makeDevSample(SR);
  const segs = sliceSyllables(samples, SR);
  assert.equal(segs.length, DEV_SAMPLE_F0S.length);
  for (const [i, seg] of segs.entries()) {
    const f0 = detectF0(samples.subarray(seg.start, seg.end), SR);
    assert.ok(f0 !== null, `조각 ${i}에서 검출 실패`);
    const expected = DEV_SAMPLE_F0S[i];
    assert.ok(
      Math.abs(f0 - expected) / expected < 0.03,
      `조각 ${i}: 검출 ${f0}, 기대 ${expected}`,
    );
  }
});

test('detectF0Detail은 명료도를 함께 준다', () => {
  const d = detectF0Detail(sine(440, 0.3), SR);
  assert.ok(d !== null);
  assert.ok(Math.abs(d.hz - 440) / 440 < 0.01);
  assert.ok(d.clarity > 0.9, `명료도 ${d.clarity}`);
  assert.equal(detectF0Detail(new Float32Array(SR * 0.3), SR), null);
});

test('findGrain은 합성 신호의 각 조각에서 정답 음높이를 찾는다', () => {
  const samples = makeDevSample(SR);
  const segs = sliceSyllables(samples, SR);
  for (const [i, seg] of segs.entries()) {
    const grain = findGrain(samples, SR, seg);
    assert.ok(grain !== null, `조각 ${i}에서 그레인 실패`);
    const expected = DEV_SAMPLE_F0S[i];
    assert.ok(Math.abs(grain.f0 - expected) / expected < 0.03, `조각 ${i}: ${grain.f0} vs ${expected}`);
    assert.ok(grain.start >= seg.start && grain.end <= seg.end, '그레인이 조각을 벗어났다');
  }
});

test('그레인 길이는 주기의 정수배다 (루프 이음매가 매끄러워야 한다)', () => {
  const samples = makeDevSample(SR);
  for (const seg of sliceSyllables(samples, SR)) {
    const grain = findGrain(samples, SR, seg);
    const period = SR / grain.f0;
    const periods = (grain.end - grain.start) / period;
    assert.ok(Math.abs(periods - Math.round(periods)) < 0.02, `정수배가 아니다: ${periods}`);
    assert.ok(Math.round(periods) >= 3, `주기가 너무 적다: ${periods}`);
  }
});

test('억양이 흐르는 음절에서도 그레인 음정은 안정적이다', () => {
  // 200Hz에서 260Hz로 활강하는 음절 — 실제 말소리에 가까운 신호.
  // 앞 28.5ms만 재면 200Hz에 가깝게 나오지만, 중앙 그레인은 중간값에 가까워야 한다.
  const dur = 0.3;
  const n = Math.round(dur * SR);
  const s = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const hz = 200 + (60 * i) / n;
    phase += (2 * Math.PI * hz) / SR;
    s[i] = 0.6 * Math.sin(phase);
  }
  const grain = findGrain(s, SR, { start: 0, end: n });
  assert.ok(grain !== null, '그레인을 못 찾았다');
  assert.ok(grain.f0 > 215 && grain.f0 < 275, `온셋 음높이에 붙었다: ${grain.f0}`);
});

test('백색소음에서는 그레인이 없다', () => {
  let s = 42;
  const noise = new Float32Array(Math.round(0.3 * SR));
  for (let i = 0; i < noise.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = s / 0x3fffffff - 1;
  }
  assert.equal(findGrain(noise, SR, { start: 0, end: noise.length }), null);
});
