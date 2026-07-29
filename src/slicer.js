// 프레임 RMS로 음절 경계를 찾는다. 임계값은 최대 프레임의 일정 비율로 잡아
// 녹음 볼륨에 자동으로 맞춘다. 항상 threshold ≤ peak이므로 "아무것도 검출되지
// 않는" 상태가 구조적으로 생기지 않는다.
//
// 백분위로 노이즈 플로어를 추정하지 않는 이유: 무음 구간이 없는 녹음
// (쉬지 않고 말한 경우, 한 음을 길게 낸 경우)에서는 백분위가 신호 자체 안에
// 들어앉아 RMS 리플을 무음으로 오판한다. 실측에서 220Hz 순음이 조용한 프레임
// 3연속 패턴을 만들어 minGap에 걸리고, 쪼개진 조각이 전부 최소 길이 미달로
// 걸러져 결과가 0개가 됐다.
//
// 배경 잡음이 최대치의 20%를 넘을 만큼 심하면 전체가 한 조각으로 뭉친다 —
// 음이 하나로 줄어들 뿐, 미검출로 실패하지는 않는다.

export function sliceSyllables(samples, sampleRate, opts = {}) {
  const {
    hopMs = 20,
    minSegMs = 80,
    minGapMs = 60,
    thresholdRatio = 0.2,
  } = opts;

  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  // 마지막 hop 미만의 나머지 샘플(최대 hopMs)은 프레임을 이루지 못해 버린다
  const frameCount = Math.floor(samples.length / hop);
  if (frameCount === 0) return [];

  const frames = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const from = f * hop;
    for (let i = from; i < from + hop; i++) sum += samples[i] * samples[i];
    frames[f] = Math.sqrt(sum / hop);
  }

  let peak = 0;
  for (let f = 0; f < frameCount; f++) peak = Math.max(peak, frames[f]);
  if (peak <= 1e-6) return [];
  const threshold = peak * thresholdRatio;

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
