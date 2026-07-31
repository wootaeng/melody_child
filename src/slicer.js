// 프레임 RMS로 두 가지를 정한다: **음절 경계**(sliceSyllables — 리듬 단위)와
// **재생 범위**(coverQuietEdges — 챈트가 실제로 들려줄 구간). 둘을 한 모듈에 두는
// 이유는 같은 20ms 프레임 격자를 봐야 "음절로 잡힌 것/못 잡힌 것"을 같은 기준으로
// 말할 수 있기 때문이다(HOP_MS를 leveler도 쓴다).
//
// 임계값은 최대 프레임의 일정 비율로 잡아 녹음 볼륨에 자동으로 맞춘다.
//
// 백분위로 노이즈 플로어를 추정하지 않는 이유: 무음 구간이 없는 녹음
// (쉬지 않고 말한 경우, 한 음을 길게 낸 경우)에서는 백분위가 신호 자체 안에
// 들어앉아 RMS 리플을 무음으로 오판한다. 실측에서 220Hz 순음이 조용한 프레임
// 3연속 패턴을 만들어 minGap에 걸리고, 쪼개진 조각이 전부 최소 길이 미달로
// 걸러져 결과가 0개가 됐다.
//
// 배경 잡음이 최대치의 20%를 넘을 만큼 심하면 전체가 한 조각으로 뭉친다 —
// 음이 하나로 줄어들 뿐, 미검출로 실패하지는 않는다.

// 임계값을 낮춰가며 최대 세 번 시도한다. 진폭 기준 16배까지의 동적 범위를
// 구제하고, 그보다 조용한 발화는 빈 결과로 남긴다 — 그 경우엔 실제로 더 크게
// 말하는 편이 맞다.
const RETRY_FACTORS = [1, 0.25, 0.0625];

// 프레임 간격. **이 값을 세 곳이 공유한다**(sliceSyllables·coverQuietEdges의 기본값과
// leveler의 RIDE_HOP_MS). 리터럴로 흩어 두면 조용히 갈라지는데, coverQuietEdges는
// bounds가 이 격자에 양자화돼 있다고 가정하고 프레임 인덱스를 되돌리므로 갈라지는
// 순간 어긋난다 — 그래서 상수 하나에서 나온다.
export const HOP_MS = 20;

// 프레임 RMS. 마지막 hop 미만의 나머지 샘플(최대 HOP_MS)은 프레임을 이루지 못해 버린다.
// recorder의 레벨 맞추기도 이 함수를 쓴다 — 녹음 레벨과 음절 검출이 같은 격자를 봐야
// "이 녹음이 조용해서 음절이 안 잡혔다"는 진단이 성립한다.
export function frameRms(samples, hop) {
  const count = Math.floor(samples.length / hop);
  const frames = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    const from = f * hop;
    for (let i = from; i < from + hop; i++) sum += samples[i] * samples[i];
    frames[f] = Math.sqrt(sum / hop);
  }
  return frames;
}

function collectSegments(frames, hop, threshold, minGapFrames) {
  const segments = [];
  let start = -1;
  let quiet = 0;

  for (let f = 0; f < frames.length; f++) {
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
    segments.push({ start: start * hop, end: frames.length * hop });
  }
  return segments;
}

export function sliceSyllables(samples, sampleRate, opts = {}) {
  const {
    hopMs = HOP_MS,
    minSegMs = 80,
    minGapMs = 60,
    thresholdRatio = 0.2,
  } = opts;

  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const frames = frameRms(samples, hop);
  const frameCount = frames.length;
  if (frameCount === 0) return [];

  let peak = 0;
  for (let f = 0; f < frameCount; f++) peak = Math.max(peak, frames[f]);
  if (peak <= 1e-6) return [];

  const minGapFrames = Math.max(1, Math.round(minGapMs / hopMs));
  const minSegSamples = Math.round((sampleRate * minSegMs) / 1000);

  // peak이 임계값을 넘는다는 것만으로는 조각이 남는다는 보장이 안 된다 —
  // 그 프레임이 minSegMs를 못 채우면 걸러지기 때문이다. 마이크를 탁 치는 등
  // 한 순간만 크게 튄 녹음에서는 스파이크가 peak을 정하고 실제 발화가 전부
  // 임계값 미달이 되어 결과가 0개가 된다. 그래서 빈 결과일 때 임계값을 낮춰
  // 다시 훑는다.
  //
  // 대가: 낮춘 임계값이 배경 잡음까지 넘기면 쉼 구간이 메워져 여러 음절이 한
  // 조각으로 뭉칠 수 있다. 조각이 줄어들 뿐 실패는 아니므로 빈 결과보다 낫다고
  // 보고 이쪽을 택했다.
  for (const factor of RETRY_FACTORS) {
    const segments = collectSegments(
      frames,
      hop,
      peak * thresholdRatio * factor,
      minGapFrames,
    ).filter((s) => s.end - s.start >= minSegSamples);
    if (segments.length > 0) return segments;
  }
  return [];
}

// 재생 범위로 인정하는 바닥. 최대 프레임의 -28dB이고, 슬라이서 임계(-14dB)보다 14dB
// 낮게 잡아 음절로 잡히지 못한 발화가 들어오게 한다.
//
// **-34dB에서 올렸다.** 그 값에서는 룸톤이 임계를 넘어 확장이 녹음 전체로 폭주했다
// (실측: 룸톤 -50dBFS·목소리 피크 0.10인 조용한 녹음에서 프레임 SNR이 -34dB이라 앞
// 1.2초·뒤 1.0초를 전부 흡수 → 곡이 증폭된 룸톤으로 1.2초 시작하고 길이가 2.9배).
// 발동 조건이 "조용히 말한 녹음"이라 고치려던 사용자와 정확히 겹쳤다. 지금 값은 그
// 실측 SNR보다 위에 있고, 대가는 -28dB보다 조용한 발화를 놓치는 것이다 — 그쪽은
// 라이드도 끌어올리지 못하는 영역이라(아래) 놓쳐도 들리지 않는다.
//
// **leveler의 RIDE_FLOOR_DB(-32dB)와 짝이다**: 이 함수는 소리를 재생 범위에 넣는 데까지고,
// 실제로 들리게 만드는 것은 라이드다. 그래서 이 바닥을 더 내려도 라이드 바닥 아래의
// 소리는 범위에만 들고 여전히 안 들린다(실측: -32dB 발화는 흡수되지만 라이드가 +0.0dB).
// 둘은 기준계가 달라 산술로 묶을 수 없으니(여기는 최대 프레임 기준, 라이드는 유성
// 90분위 기준) 한쪽을 만질 때 다른 쪽을 함께 봐야 한다.
//
// 이 값이 슬라이서의 최종 재시도 임계(0.2 × 0.0625 = 0.0125)보다 높다는 점은 의도다:
// 충격음이 최대 프레임을 정해 RETRY_FACTORS로 구제된 녹음에서는 확장이 검출보다 엄격해
// 과소 흡수 쪽으로 틀린다 — 아래 피크 가드와 같은 방향의 보수성이다.
export const COVER_FLOOR_RATIO = 0.04;

// 한 방향으로 흡수할 수 있는 최대 길이. 실측된 손실이 앞 240ms·뒤 161~353ms였으므로
// 그것을 덮되, 바닥 추정이 틀렸을 때(룸톤이 임계를 넘는 저SNR 녹음) 피해를 이 값으로
// 묶는다 — 상한이 없으면 녹음 전체가 재생 범위가 된다.
const COVER_MAX_MS = 400;

// 흡수를 멈추는 제로 크로싱 비율(초당 부호 변화). 레벨만으로는 숨소리를 발화와 구분할
// 수 없다 — 12차 실기 판정이 "사라지는 말은 없어졌는데 숨소리·바람소리가 붙는다"였고,
// 그 둘은 확장이 노리는 조용한 발화와 **같은 레벨대**에 있다.
//
// 구분되는 축은 스펙트럼이다. 유성음은 f0의 두 배 근처(사람 목소리 80~400Hz →
// 160~800)에 머물고 마찰성 잡음은 광대역이라 한 자릿수 이상 벌어진다.
//
// **재기 전에 저역통과를 건다**(COVER_ZCR_LP_HZ). 원신호로 재면 룸톤의 고역 성분이
// 교차를 만들어 **조용한 발화일수록 값이 올라간다** — 그게 곧 이 확장이 노리는 대상이라
// 가드가 목표를 죽인다. 실측(룸톤 0.003 섞은 프레임, 초당 교차 / 원본 → 저역통과 후):
//   모음 0.50  1,885 → 395     모음 0.05  4,105 → 755     모음 0.02  5,780 → 1,285
//   숨소리     31,855 → 24,545                 룸톤만     23,915 → 8,725
// 저역통과 후에는 아무리 조용한 모음도 1,285에 머물고 숨소리는 24,545다. 룸톤만 있는
// 프레임(8,725)도 함께 걸러지는 것은 덤이다 — 확장 폭주를 한 겹 더 막는다.
//
// **대가**: 조각 밖의 무성 자음(어두 "ㅅ", 말끝 종성 파열)도 함께 걸러진다 — 숨소리와
// 같은 축에 있어 이 지표로는 갈라지지 않는다. 조각 **안**은 손대지 않으므로 대부분의
// 무성 자음은 영향받지 않고(뒤에 모음이 붙어 조각에 들어온다), 남는 손실은 발화 바깥에
// 홀로 선 무성음뿐이다. 숨소리가 곡에 실리는 것보다 낫다고 보고 택했다.
const COVER_MAX_ZCR = 2500;
// ZCR을 재기 전에 거는 1차 저역통과의 차단 주파수. 음성의 f0·F1이 남고 잡음의 고역이
// 빠지는 자리다(위 실측표가 이 값으로 잰 것이다).
const COVER_ZCR_LP_HZ = 1000;

// 이만큼 조용한 구간을 건너 소리를 찾는다. 슬라이서의 minGap(60ms, "음절이 끊겼다")을
// 쓰면 안 된다 — 여기서 정하는 것은 음절 경계가 아니라 **같은 발화인가**이고, 어절
// 사이 쉼(실측 100~200ms)이 60ms를 넘어 확장이 거기서 멈춘다(실측: 마지막 조각 뒤
// 100ms 쉼 다음의 조용한 음절 353ms가 그대로 사라졌다).
//
// 한도를 넘겨도 **침묵이 재생 범위에 들어오지는 않는다**: 확장은 소리가 있는 프레임을
// 만날 때만 갱신되므로 녹음 앞의 긴 침묵은 소리가 없어 애초에 갱신을 일으키지 않는다.
// 한도가 정하는 것은 "얼마나 멀리 떨어진 소리까지 같은 발화로 볼 것인가"뿐이고, 그
// 대가는 흡수한 소리와 조각 사이의 무음(최대 이 값)이 앞뒤에 붙는 것이다.
//
// recorder.JOIN_GAP_SEC(250ms)보다 크다 — 이어 녹음의 조인 무음을 건너야 조각이 하나도
// 잡히지 않은 녹음을 회수할 수 있다. 그 관계는 산술이 아니라 test/join-cover.test.mjs가
// 지킨다(순수 모듈이 recorder를 import하지 않기 위해). 여유가 50ms뿐이므로 **이 값을
// 내리거나 JOIN_GAP_SEC을 올리면 그 테스트가 먼저 깨진다.**
const COVER_GAP_MS = 300;

// 조각 앞뒤에 남은 조용한 발화를 조각 안으로 끌어들인다.
//
// **왜 필요한가**: 챈트 모드에서 재생 범위는 bounds에서만 나온다(synth.voiceSpan은
// `bounds[0].start`부터, alignToBeats는 각 조각의 `from`부터 `readSec`만 읽는다).
// 그런데 슬라이서 임계값은 최대 프레임의 -14dB이라 그보다 조용한 발화 — 어절
// 끝음절·조사·무성 자음, 작게 시작하거나 흐리며 끝나는 말 — 는 애초에 조각으로
// 잡히지 않는다. **첫 조각 앞과 마지막 조각 뒤는 어떤 조각의 재료도 아니어서 사라진다.**
// 실측(합성 픽스처): 조용하게 시작한 발화의 앞 240ms, 말끝을 흐린 발화의 뒤 161ms,
// 어절 쉼 뒤 조용한 끝음절 353ms가 재생되지 않았다.
//
// 조각 **사이**의 그런 소리는 대체로 앞 조각의 재료 구간에 들어 있어 재생되지만
// **항상은 아니다**: alignToBeats의 `dur = min(spans, allotted)`이 내림 편향 때문에
// 재료 끝을 최대 `0.75×격자`까지 읽지 않는다(리뷰 실측: 격자·bpm 135조합 중 26개에서
// 발화가 미재생, 경계당 최대 58ms·한 녹음 합계 최대 230ms). 그 손실은 이 함수가 손대는
// 곳이 아니고 — 잘라내는 위치를 에너지로 고르게 만들어야 한다 — 아직 열려 있다.
//
// 이어 녹음에서 조용한 쪽이 통째로 사라지는 갈래는 **여기서 막지 못한다** — 그 녹음이
// 가운데에 오면 양 끝이 아니기 때문이다. 그쪽은 recorder.matchLevels가 담당한다.
//
// 임계값을 낮춰도 미검출이 남는 것 자체는 문제가 아니다 — 조각 개수는 리듬 단위이고
// 이 함수는 **재생 범위**만 넓힌다. 그래서 f0·피치 마크와 음정 이동에 쓰는 조각
// (ui.js의 `found` → `segments`)은 건드리지 않고 bounds만 확장한다.
//
// **대가**: 확장된 첫 원소의 `start`는 더 이상 슬라이서가 잡은 음절 온셋이 아니다.
// alignToBeats는 그것을 온셋으로 읽어 `at=0`에 놓으므로, 흡수한 리드인이 격자의 정수배가
// 아니면 그 뒤의 큰 음절 시작이 박에서 최대 격자의 절반(실측 73ms @156ms 격자)까지
// 밀린다. 조각 **내부**는 애초에 정렬 대상이 아니라(쉼 없이 이어 말하면 조각 하나에
// 여러 음절이 들어온다) 새로운 종류의 어긋남은 아니지만, 첫 조각에 그 현상을 추가한다.
// 소리가 사라지는 것보다 낫다고 보고 택했다 — 실기에서 거슬리면 리드인을 격자 칸으로
// 올림 배정하는 것이 다음 손잡이다(앞에 최대 한 칸의 무음이 붙는 대신 온셋이 격자에 남는다).
//
// 조각 사이는 건드리지 않는다: 확장이 이웃과 겹치면 조각을 병합하거나 경계를 옮겨야
// 하고, 그러면 온셋(=박에 맞출 지점)이 줄어 정렬이 거칠어진다.
export function coverQuietEdges(samples, sampleRate, bounds, opts = {}) {
  const {
    hopMs = HOP_MS,
    floorRatio = COVER_FLOOR_RATIO,
    gapMs = COVER_GAP_MS,
    maxMs = COVER_MAX_MS,
    maxZcr = COVER_MAX_ZCR,
    zcrLowpassHz = COVER_ZCR_LP_HZ,
  } = opts;
  if (!bounds || bounds.length === 0) return bounds;

  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const frames = frameRms(samples, hop);
  if (frames.length === 0) return bounds;
  let peak = 0;
  for (const v of frames) peak = Math.max(peak, v);
  if (peak <= 1e-6) return bounds;

  const threshold = peak * floorRatio;
  const gapFrames = Math.max(1, Math.round(gapMs / hopMs));
  const maxFrames = Math.max(1, Math.round(maxMs / hopMs));

  const first = bounds[0];
  const last = bounds[bounds.length - 1];

  // 프레임 피크. 흡수 판정에 RMS만 쓰면 **짧고 큰 소리가 들어온다** — 슬라이서는
  // minSegMs(80ms)로 그런 것을 조각에서 걸러내지만 여기에는 그 장치가 없었다.
  // 그렇게 들어온 충격음의 피크를 mixLevels가 목소리 피크로 오인해 voiceGain이 무너진다
  // (리뷰 실측: 첫 조각 앞 20ms 지점의 진폭 0.9 탭 소리 하나로 목소리 11.1배 → 1.0배,
  // 실효 -14.3dB. 목소리가 조용할수록 나빠져 피크 0.05에서 -18.1dB).
  const framePeak = (f) => {
    let p = 0;
    for (let i = f * hop; i < Math.min(samples.length, (f + 1) * hop); i++) {
      p = Math.max(p, Math.abs(samples[i]));
    }
    return p;
  };
  // 프레임의 초당 제로 크로싱 수(저역통과 후). 숨소리·마찰음은 발화와 레벨이 겹치지만
  // 여기서 갈린다. 필터는 프레임마다 새로 돌리되 앞쪽 5ms로 상태를 데운다 — 1차 IIR의
  // 시정수가 0.16ms이라 그것으로 충분하고, 신호 전체를 복사하지 않아도 된다.
  const lpAlpha = Math.exp((-2 * Math.PI * zcrLowpassHz) / sampleRate);
  const warmup = Math.round(sampleRate * 0.005);
  const frameZcr = (f) => {
    const from = f * hop;
    const to = Math.min(samples.length, from + hop);
    if (to <= from) return 0;
    let y = 0;
    for (let i = Math.max(0, from - warmup); i < from; i++) y = lpAlpha * y + (1 - lpAlpha) * samples[i];
    let prev = y;
    let crossings = 0;
    for (let i = from; i < to; i++) {
      y = lpAlpha * y + (1 - lpAlpha) * samples[i];
      if ((prev < 0) !== (y < 0)) crossings++;
      prev = y;
    }
    return (crossings * sampleRate) / (to - from);
  };
  // 흡수할 소리인가. 임계를 넘되 마찰성이 아니어야 한다. 마찰성 프레임은 **조용한
  // 프레임과 같이 취급한다**(멈추지 않고 quiet를 쌓는다) — 짧은 숨소리 너머에 발화가
  // 있으면 그것은 여전히 찾아야 하고, 길게 이어지면 gap 규칙이 알아서 멈춘다.
  const isSpeech = (f) => frames[f] >= threshold && frameZcr(f) <= maxZcr;
  // 조각 안의 피크. 조각 밖에 이보다 큰 소리가 있다면 그것은 발화가 아니다 —
  // 발화였다면 슬라이서가 (더 높은 임계값으로도) 조각으로 잡았을 것이다.
  const insidePeak = (seg) => {
    let p = 0;
    for (let i = Math.max(0, seg.start); i < Math.min(samples.length, seg.end); i++) {
      p = Math.max(p, Math.abs(samples[i]));
    }
    return p;
  };

  let start = first.start;
  let quiet = 0;
  const startCeiling = insidePeak(first);
  const startLimit = Math.max(0, Math.floor(first.start / hop) - maxFrames);
  for (let f = Math.floor(first.start / hop) - 1; f >= startLimit; f--) {
    if (framePeak(f) > startCeiling) break;
    if (isSpeech(f)) {
      quiet = 0;
      start = f * hop;
    } else if (++quiet >= gapFrames) break;
  }

  let end = last.end;
  quiet = 0;
  const endCeiling = insidePeak(last);
  const endLimit = Math.min(frames.length, Math.ceil(last.end / hop) + maxFrames);
  for (let f = Math.ceil(last.end / hop); f < endLimit; f++) {
    if (framePeak(f) > endCeiling) break;
    if (isSpeech(f)) {
      quiet = 0;
      // 마지막 프레임까지 소리가 이어졌으면 프레임을 이루지 못한 나머지 샘플도 그
      // 발화의 일부다 — 여기서 20ms를 또 버리면 고치려던 증상이 그만큼 남는다.
      end = f + 1 === frames.length ? samples.length : (f + 1) * hop;
    } else if (++quiet >= gapFrames) break;
  }

  // 전부 복사한다. 양 끝만 새 객체로 만들면 가운데 원소가 입력(=segments가 쓰는 조각)과
  // **같은 객체**가 되어, 나중에 누가 재생 범위 쪽 원소를 수정할 때 양 끝과 가운데가
  // 다르게 동작한다.
  const covered = bounds.map((seg) => ({ ...seg }));
  covered[0].start = start;
  covered[covered.length - 1].end = end;
  return covered;
}
