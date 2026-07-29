// 정규화 자기상관으로 기본주파수를 찾는다.
// 후보는 자기상관 곡선의 국소 최대점만 쓴다. 값만 보고 "최댓값의 90% 이상인
// 가장 짧은 지연"을 고르면, 곡선이 진짜 주기까지 완만히 상승하는 탓에 피크에
// 닿기 전 상승 구간에 걸려 음이 일관되게 5%쯤 높게 나온다(실측).
//
// 국소 최대점들 중에서는 최고값의 90% 이상인 가장 짧은 주기를 택한다 —
// 진짜 주기의 정수배 지점도 상관값이 높아 옥타브 오류가 나기 때문.

export function detectF0(samples, sampleRate, opts = {}) {
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

  const corrs = [];
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
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

  const peaks = [];
  for (let i = 1; i < corrs.length - 1; i++) {
    if (corrs[i].c > corrs[i - 1].c && corrs[i].c >= corrs[i + 1].c) peaks.push(corrs[i]);
  }
  if (peaks.length === 0) return null;

  const best = peaks.reduce((a, b) => (b.c > a.c ? b : a));
  if (best.c < minClarity) return null;
  const picked = peaks.find((p) => p.c >= best.c * 0.9);
  return sampleRate / picked.lag;
}
