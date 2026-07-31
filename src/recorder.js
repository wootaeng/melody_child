import { frameRms, HOP_MS } from './slicer.js';

export const MAX_RECORD_MS = 30000;

// 녹음을 이어붙일 때 사이에 넣는 무음. 두 이유로 필요하다: 슬라이서가 두 녹음을
// 별개 조각으로 잡아야 하고(붙여 두면 마지막 음절과 첫 음절이 한 덩이가 된다),
// 사람이 들을 때도 "문장이 나뉜" 느낌이 있어야 이어 말한 것처럼 뭉치지 않는다.
export const JOIN_GAP_SEC = 0.25;
// 이어붙일 수 있는 총 길이. 넘으면 분석·렌더가 길어지고 음절 수가 곡 길이를 밀어올린다.
export const MAX_TOTAL_SEC = 120;

// 조용한 녹음을 여기까지만 끌어올린다. 이 값에 걸릴 만큼 작았다면 실제로 더 크게 다시
// 말하는 편이 맞다.
//
// **mixLevels의 VOICE_GAIN_MAX(24)와 같이 움직일 값이 아니다.** 그쪽은 "절대 목표 피크에
// 닿기 위한" 상한이라 8에서 24로 올렸고(synth.js에 근거가 있다), 이쪽은 "녹음 사이의 상대
// 격차를 어디까지 메우는가"다. 격차가 8배를 넘는 두 녹음을 같은 레벨로 만들면 조용한 쪽의
// 잡음 바닥이 큰 쪽의 목소리와 비슷해진다.
export const JOIN_GAIN_MAX = 8;

// 게인이 1에서 이만큼은 벗어나야 실제로 적용한다. 1에 가까운 게인은 소리를 바꾸지
// 않으면서 배열 복사만 하므로, 기준이 된 녹음은 그대로 통과시킨다.
const GAIN_EPSILON = 0.01;
// 맞춘 뒤 허용하는 최대 피크. 90분위를 기준으로 올리므로 트랜지언트가 든 녹음은 피크가
// 1을 넘을 수 있고, 그러면 exporter의 ±1 클램프에서 왜곡이 된다.
const PEAK_CEILING = 0.99;
// 녹음 레벨을 재는 분위. leveler의 RIDE_REF_PERCENTILE과 같은 값·같은 이유다.
const LEVEL_PERCENTILE = 0.9;
// 분위 계산에서 뺄 바닥(최대 프레임 대비). 쉼과 잡음 프레임이 분위를 끌어내리는 것을
// 막는다 — leveler의 유성 창과 같은 40dB다.
const VOICED_WINDOW_DB = 40;

// 녹음 하나의 레벨. **유성 프레임 RMS의 90분위**다.
//
// 표본 절대 최대(피크)를 쓰면 안 된다. 이 리포가 두 번 겪은 실패다 — slicer의
// RETRY_FACTORS는 "마이크를 탁 친 한 프레임이 기준을 정해 실제 발화가 전부 임계값
// 미달이 되는" 것을 우회하려고 있고, leveler의 RIDE_REF_PERCENTILE도 같은 이유로
// 최대 대신 90분위를 쓴다. 여기서 피크를 쓰면 조용한 녹음에 든 플로시브·책상 툭 소리
// **한 샘플**이 레벨을 정해 게인이 1로 떨어지고, 그 녹음은 그대로 사라진다(실측:
// 클릭 하나로 390ms 손실이 되살아났다).
function voicedLevel(samples, sampleRate) {
  const frames = frameRms(samples, Math.max(1, Math.round((sampleRate * HOP_MS) / 1000)));
  if (frames.length === 0) return 0;
  let top = 0;
  for (const v of frames) top = Math.max(top, v);
  if (!(top > 0)) return 0;
  const floor = top * Math.pow(10, -VOICED_WINDOW_DB / 20);
  const voiced = Array.from(frames)
    .filter((v) => v > floor)
    .sort((a, b) => a - b);
  if (voiced.length === 0) return 0;
  return voiced[Math.min(voiced.length - 1, Math.floor(voiced.length * LEVEL_PERCENTILE))];
}

// 이어붙일 녹음들의 레벨을 가장 큰 녹음에 맞춘다.
//
// **왜 필요한가**: 슬라이서 임계값은 합친 녹음 **전체**의 최대 프레임에서 나온다
// (slicer.js). 그래서 음량이 다른 녹음을 그냥 이으면 조용한 쪽이 전부 임계값 미달이
// 되어 음절이 하나도 잡히지 않고, 챈트 재생 범위는 bounds에서 나오므로 **그 녹음이
// 통째로 사라진다**(실측: 8배 작은 두 번째 녹음 1.05초 전부. 슬라이서의 RETRY_FACTORS는
// 결과가 0개일 때만 발동하므로 큰 녹음에서 조각이 잡히면 구제되지 않는다).
// 마이크 거리와 목소리 크기는 녹음마다 다르니 이어 녹음에서는 상시 발생하는 조건이다.
//
// **호출자는 원본 녹음 전부를 매번 넘겨야 한다.** 이미 맞춰진 결과에 새 녹음을 붙여 다시
// 부르면 상한이 곱해진다(실측: 0.01→0.08→0.64를 두 개씩 이어 붙이면 첫 녹음이 원본의
// 64배 — JOIN_GAIN_MAX의 뜻이 무너진다). ui.js가 세션 청크 배열을 들고 있는 이유가 이것이다.
export function matchLevels(parts, sampleRate) {
  const levels = parts.map((p) => voicedLevel(p, sampleRate));
  const target = Math.max(...levels);
  if (!(target > 0)) return parts;

  const gains = levels.map((level) => (level > 0 ? Math.min(JOIN_GAIN_MAX, target / level) : 1));

  // 클리핑 방어는 **전체를 같은 비율로 줄여서** 한다. 녹음별로 게인을 깎으면 트랜지언트
  // 하나가 그 녹음의 레벨 맞추기를 무력화한다 — 클릭 하나에 게인이 1로 떨어져 조용한
  // 녹음이 그대로 사라지는, 피크 기준일 때와 똑같은 실패다(실측: 클릭 0.5짜리 녹음이
  // 8배가 아니라 2배만 올라 검출에 실패). 전체 비율로 줄이면 녹음 간 균형이 보존되고,
  // 절대 레벨이 낮아지는 것은 문제가 아니다 — 렌더가 mixLevels에서 목소리 피크를 다시
  // 정규화한다(synth.js의 VOICE_PEAK).
  let worst = 0;
  for (const [i, part] of parts.entries()) {
    let peak = 0;
    for (const v of part) peak = Math.max(peak, Math.abs(v));
    worst = Math.max(worst, peak * gains[i]);
  }
  const trim = worst > PEAK_CEILING ? PEAK_CEILING / worst : 1;

  return parts.map((part, i) => {
    const gain = gains[i] * trim;
    return Math.abs(gain - 1) > GAIN_EPSILON ? Float32Array.from(part, (v) => v * gain) : part;
  });
}

// 녹음 여러 개를 하나로 잇는다. 브라우저 API를 모르는 순수 함수라 node --test로
// 검증한다 — AudioBuffer 만들기는 호출자(ui.js)가 한다.
//
// 앞뒤 무음을 다듬지 않는다: 녹음 시작·끝의 침묵은 voiceSpan이 이미 잘라내고,
// 여기서 손대면 "어디까지가 몇 번째 녹음인가"가 두 곳에서 결정된다.
//
// 레벨 맞추기는 여기 있어야 한다(matchLevels의 주석에 근거가 있다): 잇기와 따로 두면
// 한쪽만 부르는 경로가 생기고, 그때 조용한 녹음이 조용히 사라진다.
export function joinSamples(chunks, sampleRate, gapSec = JOIN_GAP_SEC) {
  const filtered = chunks.filter((c) => c && c.length > 0);
  if (filtered.length === 0) return new Float32Array(0);
  if (filtered.length === 1) return filtered[0];
  const parts = matchLevels(filtered, sampleRate);
  const gap = Math.max(0, Math.round(gapSec * sampleRate));
  const total = parts.reduce((sum, c) => sum + c.length, 0) + gap * (parts.length - 1);
  const out = new Float32Array(total);
  let at = 0;
  for (const [i, part] of parts.entries()) {
    out.set(part, at);
    at += part.length + (i < parts.length - 1 ? gap : 0);
  }
  return out;
}

export function isSpeechRecognitionSupported() {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// 재시도해도 결과가 같은 오류들. 여기서 포기하지 않으면 30초 내내 스핀이 돈다.
const FATAL_SPEECH_ERRORS = new Set(['network', 'not-allowed', 'service-not-allowed']);
const MAX_RESTARTS = 10;

// 받아쓰기는 음악 생성에 필요하지 않다 — 실패해도 녹음을 막지 않는다.
function startTranscription(onTranscript, onUnavailable) {
  if (!isSpeechRecognitionSupported()) return null;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new Ctor();
  recognition.lang = 'ko-KR';
  recognition.continuous = true;
  recognition.interimResults = true;

  // Chrome은 침묵이 길면 스스로 종료하고, 재시작하면 event.results가 비워진다.
  // 따라서 세션이 끝날 때마다 확정 텍스트를 누적해 둔다.
  const state = { committed: '', current: '', done: false };
  const joined = () => `${state.committed} ${state.current}`.trim();

  recognition.onresult = (event) => {
    let finalText = '';
    let interim = '';
    for (const result of event.results) {
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    state.current = finalText;
    onTranscript(`${state.committed} ${finalText}${interim}`.trim());
  };

  let restarts = 0;

  recognition.onerror = (event) => {
    if (FATAL_SPEECH_ERRORS.has(event.error)) {
      state.done = true;
      onUnavailable();
    }
  };

  recognition.onend = () => {
    state.committed = joined();
    state.current = '';
    if (state.done || restarts >= MAX_RESTARTS) return;
    restarts += 1;
    try {
      recognition.start(); // 침묵으로 끊긴 것 — 다시 듣는다
    } catch {
      /* 이미 시작된 경우 무시 */
    }
  };

  try {
    recognition.start();
  } catch {
    return null;
  }
  return { recognition, state, text: joined };
}

export async function startRecording({
  maxMs = MAX_RECORD_MS,
  onTranscript = () => {},
  onAutoStop = () => {},
  onTranscriptUnavailable = () => {},
} = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  // 컨텍스트는 decodeAudioData 때문에만 필요하다. 녹음 중 레벨 표시는 CSS
  // 애니메이션이 하므로 analyser도 rAF 루프도 없다.
  const ctx = new AudioContext();

  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();

  const transcriber = startTranscription(onTranscript, onTranscriptUnavailable);

  const timer = setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
      onAutoStop();
    }
  }, maxMs);

  return {
    async stop() {
      clearTimeout(timer);
      if (recorder.state === 'recording') recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      if (transcriber) {
        transcriber.state.done = true; // onend에서 재시작하지 않게
        try {
          transcriber.recognition.stop();
        } catch {
          /* 이미 멈춘 경우 */
        }
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      try {
        const audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        return { audioBuffer, transcript: transcriber ? transcriber.text() : '' };
      } finally {
        // 디코딩이 실패해도 분석용 컨텍스트는 닫는다 — 실패가 반복되면 쌓인다
        await ctx.close();
      }
    },
  };
}
