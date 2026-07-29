// 프레임 RMS로 음절 경계를 찾는다. 임계값은 신호마다 다르므로
// 하위 20% 분위를 노이즈 플로어로 추정해 상대적으로 정한다.

export function sliceSyllables(samples, sampleRate, opts = {}) {
  const {
    hopMs = 20,
    minSegMs = 80,
    minGapMs = 60,
    floorMultiplier = 3,
  } = opts;

  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const frameCount = Math.floor(samples.length / hop);
  if (frameCount === 0) return [];

  const frames = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const from = f * hop;
    for (let i = from; i < from + hop; i++) sum += samples[i] * samples[i];
    frames[f] = Math.sqrt(sum / hop);
  }

  const sorted = Float64Array.from(frames).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const peak = sorted[sorted.length - 1];
  if (peak <= 1e-6) return [];
  // 플로어 기준과 피크 기준 중 큰 값 — 완전 무음 구간에서 floor가 0이 되는 경우를 막는다
  const threshold = Math.max(floor * floorMultiplier, peak * 0.1);

  const minGapFrames = Math.max(1, Math.round(minGapMs / hopMs));
  const segments = [];
  let start = -1;
  let quiet = 0;

  for (let f = 0; f < frameCount; f++) {
    if (frames[f] >= threshold) {
      if (start < 0) start = f;
      quiet = 0;
    } else if (start >= 0) {
      quiet++;
      if (quiet >= minGapFrames) {
        segments.push({ start: start * hop, end: (f - quiet + 1) * hop });
        start = -1;
        quiet = 0;
      }
    }
  }
  if (start >= 0) {
    segments.push({ start: start * hop, end: frameCount * hop });
  }

  const minSegSamples = Math.round((sampleRate * minSegMs) / 1000);
  return segments.filter((s) => s.end - s.start >= minSegSamples);
}
