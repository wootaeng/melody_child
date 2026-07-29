// 마이크 없이 파이프라인을 검증하기 위한 합성 신호.
// 사람 모음처럼 f0가 뚜렷하도록 기본음 + 2·3배음을 섞고, 음절처럼 무음으로 구분한다.

export const DEV_SAMPLE_F0S = Object.freeze([220, 262, 220, 196, 247, 220]);
export const DEV_SAMPLE_BURST_SEC = 0.25;
export const DEV_SAMPLE_GAP_SEC = 0.12;

export function makeDevSample(sampleRate = 48000, { glideCents = 0 } = {}) {
  const burst = Math.round(DEV_SAMPLE_BURST_SEC * sampleRate);
  const gap = Math.round(DEV_SAMPLE_GAP_SEC * sampleRate);
  const out = new Float32Array((burst + gap) * DEV_SAMPLE_F0S.length);
  const fade = Math.round(0.01 * sampleRate);

  let pos = 0;
  for (const f0 of DEV_SAMPLE_F0S) {
    // 위상을 누적해야 활강 중에도 파형이 끊기지 않는다
    let phase = 0;
    for (let i = 0; i < burst; i++) {
      // glideCents가 0이면 기존과 동일한 정상상태 신호다
      const hz = f0 * Math.pow(2, (glideCents * (i / burst - 0.5)) / 1200);
      phase += (2 * Math.PI * hz) / sampleRate;
      const harmonics =
        Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase);
      const env = Math.min(1, i / fade, (burst - i) / fade);
      out[pos + i] = 0.5 * env * (harmonics / 1.75);
    }
    pos += burst + gap;
  }
  return out;
}
