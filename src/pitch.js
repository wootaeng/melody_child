// 정규화 자기상관으로 기본주파수를 찾는다.
// 후보는 자기상관 곡선의 국소 최대점만 쓴다. 값만 보고 "최댓값의 90% 이상인
// 가장 짧은 지연"을 고르면, 곡선이 진짜 주기까지 완만히 상승하는 탓에 피크에
// 닿기 전 상승 구간에 걸려 음이 일관되게 5%쯤 높게 나온다(실측).
//
// 국소 최대점들 중에서는 최고값의 90% 이상인 가장 짧은 주기를 택한다 —
// 진짜 주기의 정수배 지점도 상관값이 높아 옥타브 오류가 나기 때문.
//
// 반환값은 `sampleRate / 정수 지연`이라 고음에서 해상도가 거칠다. 48kHz에서
// 990Hz는 1000Hz로 읽힌다(오차 1%). 반음이 5.9%이므로 음정 판단에는 무해하다.
//
// 분석 창은 `maxLag * 2`(기본값 48kHz에서 28.5ms)로 고정된다. 음절이 300ms여도
// 앞 28.5ms만 본다 — 음절 시작부의 음높이를 그 음절의 대표값으로 쓰는 것이다.

export function detectF0Detail(samples, sampleRate, opts = {}) {
  const { minHz = 70, maxHz = 1000, minClarity = 0.3 } = opts;

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.floor(sampleRate / minHz);
  if (samples.length < maxLag * 2) return null;

  const n = Math.min(samples.length, maxLag * 2);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;

  const x = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    x[i] = samples[i] - mean;
    energy += x[i] * x[i];
  }
  if (energy <= 1e-9) return null;

  // lag 1부터 계산한다. minLag부터 시작하면 탐색 상한 근처의 진짜 주기가 배열
  // 첫 칸에 놓여 양옆 비교를 못 해 후보에서 빠진다(실측: 1000Hz가 500Hz로).
  const corrs = [];
  for (let lag = 1; lag <= maxLag && lag < n; lag++) {
    let dot = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      dot += x[i] * x[i + lag];
      e1 += x[i] * x[i];
      e2 += x[i + lag] * x[i + lag];
    }
    const norm = Math.sqrt(e1 * e2);
    corrs.push({ lag, c: norm > 0 ? dot / norm : 0 });
  }

  // lag 0에서 내려오는 주 로브를 건너뛴다. 이 구간은 주기와 무관하게 상관값이
  // 높아서, 후보로 두면 저음에서 짧은 지연이 뽑힌다(실측: 70Hz가 1000Hz로).
  let from = 1;
  while (from < corrs.length && corrs[from].c > 0) from++;

  const peaks = [];
  for (let i = from; i < corrs.length; i++) {
    if (corrs[i].lag < minLag) continue;
    const risesFromLeft = corrs[i].c > corrs[i - 1].c;
    const holdsAgainstRight = i === corrs.length - 1 || corrs[i].c >= corrs[i + 1].c;
    if (risesFromLeft && holdsAgainstRight) peaks.push(corrs[i]);
  }
  if (peaks.length === 0) return null;

  const best = peaks.reduce((a, b) => (b.c > a.c ? b : a));
  if (best.c < minClarity) return null;
  const picked = peaks.find((p) => p.c >= best.c * 0.9);
  return { hz: sampleRate / picked.lag, clarity: best.c };
}

export function detectF0(samples, sampleRate, opts = {}) {
  const detail = detectF0Detail(samples, sampleRate, opts);
  return detail ? detail.hz : null;
}

const MIN_GRAIN_PERIODS = 3;

// 음절에서 유지음으로 쓸 그레인을 찾는다.
//
// 음절 전체를 하나의 비율로 밀면 그 안의 억양이 살아남아 음정이 흐른다
// (실측: 한 음 안에서 172→86→177Hz, 곡 전체 3옥타브 산포). 안정 구간의 짧은
// 그레인을 주기의 정수배로 잘라 루프하면 음정이 고정되고 이음매도 매끄럽다.
//
// 앞 35%는 건너뛴다 — 자음과 성문 어택이 있어 가장 불안정한 구간이다.
export function findGrain(samples, sampleRate, seg, opts = {}) {
  const { skipHead = 0.35, windowMs = 70, minClarity = 0.5 } = opts;

  const win = Math.round((sampleRate * windowMs) / 1000);
  const from = seg.start + Math.floor((seg.end - seg.start) * skipHead);
  if (seg.end - from < win) return null;

  const hop = Math.max(1, Math.floor(win / 2));
  let best = null;
  for (let s = from; s + win <= seg.end; s += hop) {
    const detail = detectF0Detail(samples.subarray(s, s + win), sampleRate);
    if (detail && detail.clarity >= minClarity && (!best || detail.clarity > best.clarity)) {
      best = { start: s, hz: detail.hz, clarity: detail.clarity };
    }
  }
  if (!best) return null;

  // 주기의 정수배로 자른다 — 루프 이음매에서 파형이 이어지도록
  const period = sampleRate / best.hz;
  let periods = Math.floor(win / period);
  while (periods >= MIN_GRAIN_PERIODS && best.start + Math.round(periods * period) > seg.end) {
    periods -= 1;
  }
  if (periods < MIN_GRAIN_PERIODS) return null;

  return { start: best.start, end: best.start + Math.round(periods * period), f0: best.hz };
}
