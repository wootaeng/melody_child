// 목소리 게인 라이드 — 조용한 음절만 끌어올려 말이 들리게 한다.
//
// 왜 이 방식인가: 멜로디를 건드리는 모든 수단이 직전 회차 지적과 제로섬이다.
//   - 레벨을 내리면 그대로 "멜로디가 작다"로 후퇴한다.
//   - 대역으로 비켜 갈 수도 없다. 피아노(octave+1, f0 311Hz)의 A가중 에너지는
//     기본음+2배음 56% / 3~9배음 44%인데, 뒤쪽이 곧 음성 포먼트(F2·F3) 대역이다.
//     차단을 내리면 지각 음량의 44%를 버려 "비프음"으로 돌아가고, 옥타브를 올리면
//     F1 대신 F2를(명료도에 더 중요한 대역을) 덮는다.
//   - 조각 단위 사이드체인 덕킹도 안 된다. 정렬된 조각은 발화 구간이 아니라
//     **타임라인의 분할**이라 시간의 99.2%를 덮는다(실측) — 곡 전체를 누르는 것과 같다.
// 남는 비제로섬 이동은 하나뿐이다: **목소리를, 안 들리는 그 구간에서만, 크게 만든다.**
//
// 그 구간이 존재하는 근거: 슬라이서 임계값은 최대 프레임의 -14dB이라(slicer.js)
// 그보다 조용한 어절 끝음절·조사·무성 자음은 **애초에 음절로 잡히지 않는다**. 조각
// 꼬리 안에서 재생되지만 어떤 bounds에도 속하지 않으므로 처방은 음절 단위가 아니라
// **프레임 단위**여야 한다. 그리고 녹음의 autoGainControl은 초 단위로 움직여 녹음
// 전체 레벨만 맞추고 음절 간 격차는 그대로 남긴다 — "글로벌은 맞았는데 부분이 안
// 들린다"는 실기 판정과 일치한다.
//
// 순수 모듈: 브라우저 API를 모른다. DynamicsCompressorNode를 쓰지 않는 이유도 여기
// 있다 — 스펙이 니 커브를 "단조증가 함수"로만 규정해 makeup 게인이 구현 정의이고,
// 고정 룩어헤드 지연이 붙고, 목소리 피크 불변식이 깨져 mixLevels의 클리핑 방어가
// 무효가 되며, node --test로 검증할 수 없다. 이건 그것의 순수·오프라인 버전이다.

// 프레임 간격. 슬라이서와 같은 20ms를 쓴다 — 두 모듈이 같은 프레임을 봐야
// "음절로 잡힌 것/못 잡힌 것"을 같은 기준으로 말할 수 있다.
export const RIDE_HOP_MS = 20;
// 기준보다 이만큼 아래까지는 손대지 않는다 — 말의 자연스러운 강약을 뭉개지 않는다.
// 슬라이서 임계(-14dB)보다 낮게 잡아 음절로 잡히지 못한 구간이 대상에 들어오게 한다.
export const RIDE_RANGE_DB = 10;
// 한 프레임에 줄 수 있는 최대 부스트. **청취로 조정할 값이다.** 상한의 근거는
// 숨소리·잡음이 함께 올라오기 시작하는 지점이고, 9dB면 -20dB 음절이 -11dB로 온다.
export const RIDE_MAX_DB = 9;
// 기준보다 이보다 낮은 프레임은 잡음으로 보고 건드리지 않는다 —
// mixLevels의 VOICE_GAIN_MAX(무음을 증폭하지 않는다)의 시간축 버전이다.
export const RIDE_FLOOR_DB = -32;
// 게인이 움직일 수 있는 최대 속도. 9dB를 75ms에 도달한다 — 이보다 느리면 150ms
// 짧은 음절이 다 지나간 뒤에 게인이 올라오고, 빠르면 게인 변화 자체가 파형에 실린다.
export const RIDE_SLOPE_DB_PER_SEC = 120;
// 기준 레벨의 분위. 최대 프레임을 기준으로 쓰면 마이크를 탁 친 한 프레임이 기준을
// 정한다 — 슬라이서가 이미 겪고 RETRY_FACTORS로 우회한 실패다.
export const RIDE_REF_PERCENTILE = 0.9;
// 기준 추정에서 제외할 바닥. 이보다 조용한 프레임은 쉼·잡음으로 보고 분위 계산에서 뺀다.
const VOICED_WINDOW_DB = 40;

const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));

// 프레임별 게인(dB)을 정한다. 각 단계의 순서가 곧 불변식이다.
// 반환 `maxBoostDb`는 **실제로 적용된 최댓값**이고 `opts.maxBoostDb`는 상한이다 —
// 이름이 같지만 뜻이 다르니 결과를 옵션으로 되먹이지 말 것.
export function ridePlan(samples, sampleRate, fromSample, lengthSamples, opts = {}) {
  const {
    hopMs = RIDE_HOP_MS,
    rangeDb = RIDE_RANGE_DB,
    maxBoostDb = RIDE_MAX_DB,
    floorDb = RIDE_FLOOR_DB,
    slopeDbPerSec = RIDE_SLOPE_DB_PER_SEC,
    refPercentile = RIDE_REF_PERCENTILE,
  } = opts;

  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const from = Math.max(0, Math.min(fromSample, samples.length));
  const end = Math.min(samples.length, from + Math.max(0, lengthSamples));
  const frameCount = Math.floor((end - from) / hop);
  const empty = {
    gains: new Float32Array(0),
    hop,
    from,
    refDb: -Infinity,
    spreadBeforeDb: 0,
    spreadAfterDb: 0,
    meanBoostDb: 0,
    maxBoostDb: 0,
  };
  if (frameCount === 0 || !(maxBoostDb > 0)) {
    return { ...empty, gains: new Float32Array(frameCount).fill(1) };
  }

  // 1) 프레임 RMS와 프레임 피크
  const rmsDb = new Float64Array(frameCount);
  const peaks = new Float64Array(frameCount);
  let globalPeak = 0;
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    let peak = 0;
    for (let i = from + f * hop; i < from + (f + 1) * hop; i++) {
      const a = samples[i];
      sum += a * a;
      if (Math.abs(a) > peak) peak = Math.abs(a);
    }
    rmsDb[f] = toDb(Math.sqrt(sum / hop));
    peaks[f] = peak;
    if (peak > globalPeak) globalPeak = peak;
  }

  // 2) 기준 레벨 = 유성 프레임의 분위. 최대에서 40dB 아래까지만 유성으로 본다.
  const top = Math.max(...rmsDb);
  const voiced = Array.from(rmsDb).filter((d) => d > top - VOICED_WINDOW_DB);
  const sorted = voiced.slice().sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const refDb = pick(refPercentile);

  // 3) 원하는 부스트. 잡음 바닥(기준 + floorDb 아래)은 건드리지 않는다.
  // 4) 피크 상한. 창을 ±1프레임으로 잡는 이유: 샘플 게인은 인접 프레임 게인 사이를
  //    보간하므로 프레임 f의 샘플이 받을 수 있는 최대 게인이 max(g_{f-1..f+1})이고,
  //    그 각각이 f의 피크를 포함한 창으로 제한돼 있으면 보간 결과도 전체 피크를
  //    넘지 못한다 — 피크 안전성이 산술로 보장된다(테스트가 파열음으로 이걸 짚는다).
  const gainDb = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    if (rmsDb[f] < refDb + floorDb) continue;
    const deficit = refDb - rangeDb - rmsDb[f];
    if (!(deficit > 0)) continue;
    let windowPeak = peaks[f];
    if (f > 0) windowPeak = Math.max(windowPeak, peaks[f - 1]);
    if (f + 1 < frameCount) windowPeak = Math.max(windowPeak, peaks[f + 1]);
    const capDb = toDb(globalPeak) - toDb(windowPeak);
    gainDb[f] = Math.max(0, Math.min(deficit, maxBoostDb, capDb));
  }

  // 6) 콘 침식으로 기울기를 제한한다. 값을 **내리기만** 하므로 4번 상한을 깨지 않고,
  //    후진 패스가 공짜 룩어헤드를 준다 — 오프라인이라 미래를 안다(실시간 컴프레서가
  //    고정 6ms 룩어헤드로 흉내내는 것을 여기서는 무제한으로 한다).
  //    양 끝은 가상 프레임 0dB에서 출발한다: 구간 밖은 게인 1이므로 첫·마지막 프레임이
  //    큰 부스트를 받으면 경계가 딱 소리를 낸다.
  const step = (slopeDbPerSec * hop) / sampleRate;
  let prev = 0;
  for (let f = 0; f < frameCount; f++) {
    gainDb[f] = Math.min(gainDb[f], prev + step);
    prev = gainDb[f];
  }
  prev = 0;
  for (let f = frameCount - 1; f >= 0; f--) {
    gainDb[f] = Math.min(gainDb[f], prev + step);
    prev = gainDb[f];
  }

  const gains = new Float32Array(frameCount);
  let boostSum = 0;
  let boosted = 0;
  let maxApplied = 0;
  for (let f = 0; f < frameCount; f++) {
    gains[f] = Math.pow(10, gainDb[f] / 20);
    if (gainDb[f] > 0) {
      boostSum += gainDb[f];
      boosted++;
      if (gainDb[f] > maxApplied) maxApplied = gainDb[f];
    }
  }

  const spreadOf = (offset) => {
    const values = Array.from(rmsDb, (d, f) => d + offset(f)).filter((d) => d > top - VOICED_WINDOW_DB);
    const s = values.slice().sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return s.length ? at(0.9) - at(0.1) : 0;
  };

  return {
    gains,
    hop,
    from,
    refDb,
    spreadBeforeDb: spreadOf(() => 0),
    spreadAfterDb: spreadOf((f) => gainDb[f]),
    meanBoostDb: boosted ? boostSum / boosted : 0,
    maxBoostDb: maxApplied,
  };
}

// 계획을 샘플에 먹인다. 길이·인덱스를 보존하므로 조각 오프셋(초)이 그대로 유효하다.
// 부스트가 없으면 **같은 배열을 그대로** 돌려준다 — `?ride=0`의 A/B가 비트 단위여야
// 폰에서 원인을 좁힐 수 있다.
export function applyRide(samples, plan) {
  if (!plan || plan.meanBoostDb <= 0) return samples;
  const { gains, hop, from } = plan;
  const out = Float32Array.from(samples);
  // 프레임 중심 사이를 선형 보간한다. 중심 밖(첫 중심 이전·마지막 중심 이후)은 그
  // 프레임 게인을 그대로 쓴다.
  //
  // 분석 구간 밖은 게인 1이라 경계에 계단이 남는다. 침식이 양 끝을 한 걸음(20ms에
  // 2.4dB)까지만 내리므로 **계단은 최대 2.4dB**다(실측 최댓값 2.40dB). 실전에서는
  // 시작 경계가 첫 음절 온셋이라 조각 0의 페이드 인(게인 0)에 가려지고, 끝 경계는
  // 룸톤이라 절대 진폭이 작다 — 들릴 위험은 낮지만 0은 아니다.
  //
  // 마지막 hop 미만의 나머지 샘플은 프레임을 이루지 못해 게인 1로 남는다(slicer.js와
  // 같은 관례). 그 구간은 최대 20ms이고 분석 구간 끝, 즉 마지막 음절 뒤 여운이다.
  const half = hop / 2;
  for (let f = 0; f < gains.length; f++) {
    const start = f === 0 ? from : from + Math.round(f * hop + half - hop);
    const stop = f === gains.length - 1 ? from + gains.length * hop : from + Math.round(f * hop + half);
    const centerA = from + (f - 1) * hop + half;
    const centerB = from + f * hop + half;
    const gA = f === 0 ? gains[0] : gains[f - 1];
    for (let i = Math.max(from, start); i < Math.min(stop, samples.length); i++) {
      const t = Math.min(1, Math.max(0, (i - centerA) / (centerB - centerA)));
      out[i] = samples[i] * (gA + (gains[f] - gA) * t);
    }
  }
  return out;
}
