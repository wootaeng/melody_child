import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectF0 } from '../src/pitch.js';
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
