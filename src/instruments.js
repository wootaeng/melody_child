// 멜로디 악기 프리셋.
//
// 브라우저 API를 모르는 순수 데이터다(slicer·pitch·composer와 같은 경계) — 그래서
// 불변식을 node --test로 직접 검증할 수 있다. 실제 소리는 OfflineAudioContext가
// 필요해 브라우저에서만 잴 수 있고, 그 경계를 흐리면 "테스트는 통과하는데 소리는
// 안 바뀌는" 상태가 된다.
//
// 왜 이 방식인가: 실기 8차 지적이 "비프음만 나오는 멜로디가 별로다"였고, 진단 칩의
// midi 51~55(155~196Hz)가 원인을 특정했다. 배음이 6배음까지뿐이라 최고 성분이
// 933~1176Hz에 그쳐 **귀가 가장 민감한 1~3kHz가 비었고**, 화자 기본음(154Hz)과 같은
// 대역이라 마스킹까지 받았다. 저음역 정적 배음 + 얕은 감쇠는 오르간·신디의 정의다.
//
// 해법은 감산 합성이다. 배음이 풍부한 파형 하나를 만들고 저역통과 차단 주파수를 음이
// 울리는 동안 내리면 **고배음이 기본음보다 먼저 죽는다** — 그게 피아노다움의 핵심이다.
// 배음마다 오실레이터를 두는 가산 합성이 더 정확하지만, 프리셋을 귀로 맞출 때 손댈
// 숫자가 배음 수만큼 늘어난다. 네 악기를 청취로 토닝하는 단계에서는 비용이 이득을 넘는다.

// 필드:
//   label       화면 버튼 텍스트
//   octave      음역 오프셋(옥타브). 렌더할 때만 더한다 — melody.notes의 midi는
//               건드리지 않는다(화면 구슬 높이가 그 값을 쓴다)
//   harmonics   createPeriodicWave의 imag 배열. [DC, 기본음, 2배음, …]
//   attackSec   어택 시간
//   holdShare   감쇠가 시작되는 시점(음 길이 대비)
//   sustain     감쇠 목표(음량 대비 배율)
//   filterFrom  저역통과 시작 차단 주파수
//   filterTo    감쇠 후 차단 주파수. 없으면 고정 필터(엔벨로프 없음)
//   level       악기별 음량 배율
//
// 숫자는 실기 청취로 조정할 값이다. 데이터라서 한 줄만 고치면 된다.
export const INSTRUMENTS = {
  // 기본. 뾰족한 어택과 넓은 배음이 1~3kHz를 채우고, +1옥타브로 목소리를 비킨다.
  // level 1.2는 "멜로디가 더 컸으면"이라는 지적에 대한 몫이다.
  piano: {
    label: '피아노',
    octave: 1,
    harmonics: [0, 1, 0.6, 0.4, 0.28, 0.2, 0.14, 0.1, 0.07, 0.05],
    attackSec: 0.004,
    holdShare: 0.02,
    sustain: 0.35,
    filterFrom: 6000,
    filterTo: 900,
    level: 1.2,
  },

  // 벨. 4배음을 세워 종 느낌을 내고 빨리 죽는다. +2옥타브가 이 계열의 자연스러운
  // 자리라서 목소리와 가장 멀리 떨어진다.
  orgel: {
    label: '오르골',
    octave: 2,
    harmonics: [0, 1, 0.3, 0.15, 0.5, 0.1, 0.2],
    attackSec: 0.002,
    holdShare: 0.01,
    sustain: 0.08,
    filterFrom: 8000,
    filterTo: 2500,
    level: 1.0,
  },

  // 나무 타악. 마림바는 4배음이 특징이고 감쇠가 가장 빠르다.
  marimba: {
    label: '마림바',
    octave: 1,
    harmonics: [0, 1, 0.2, 0.1, 0.45, 0.08, 0.05],
    attackSec: 0.003,
    holdShare: 0.01,
    sustain: 0.05,
    filterFrom: 5000,
    filterTo: 1200,
    level: 1.1,
  },

  // 예전 소리를 그대로 보존한다 — 악기 교체의 A/B 기준선이다. 이 값이 움직이면
  // "바꿔서 좋아졌다"의 비교 대상이 사라진다. filterTo가 없어 필터가 고정이고
  // holdShare 0.6은 예전 엔벨로프(음 길이 60%까지 유지)와 같다.
  synth: {
    label: '신디',
    octave: 0,
    harmonics: [0, 1, 0.75, 0.55, 0.38, 0.24, 0.14],
    attackSec: 0.02,
    holdShare: 0.6,
    sustain: 0.75,
    filterFrom: 3500,
    level: 1.0,
  },
};

export const DEFAULT_INSTRUMENT = 'piano';

// 알 수 없는 이름은 조용히 무시하지 않고 기본 악기로 떨어진다 — URL 오타로 소리가
// 사라지면 원인을 짐작할 수 없다.
export function pickInstrument(name) {
  return INSTRUMENTS[name] || INSTRUMENTS[DEFAULT_INSTRUMENT];
}
