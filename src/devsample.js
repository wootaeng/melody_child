// 마이크 없이 파이프라인을 검증하기 위한 합성 신호.
// 사람 모음처럼 f0가 뚜렷하도록 기본음 + 2·3배음을 섞고, 음절처럼 무음으로 구분한다.

export const DEV_SAMPLE_F0S = [220, 262, 220, 196, 247, 220];
export const DEV_SAMPLE_BURST_SEC = 0.25;
export const DEV_SAMPLE_GAP_SEC = 0.12;

export function makeDevSample(sampleRate = 48000) {
  const burst = Math.round(DEV_SAMPLE_BURST_SEC * sampleRate);
  const gap = Math.round(DEV_SAMPLE_GAP_SEC * sampleRate);
  const out = new Float32Array((burst + gap) * DEV_SAMPLE_F0S.length);
  const fade = Math.round(0.01 * sampleRate);

  let pos = 0;
  for (const f0 of DEV_SAMPLE_F0S) {
    for (let i = 0; i < burst; i++) {
      const t = i / sampleRate;
      const harmonics =
        Math.sin(2 * Math.PI * f0 * t) +
        0.5 * Math.sin(4 * Math.PI * f0 * t) +
        0.25 * Math.sin(6 * Math.PI * f0 * t);
      const env = Math.min(1, i / fade, (burst - i) / fade);
      out[pos + i] = 0.5 * env * (harmonics / 1.75);
    }
    pos += burst + gap;
  }
  return out;
}
