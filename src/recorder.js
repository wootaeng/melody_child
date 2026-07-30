export const MAX_RECORD_MS = 30000;

// 녹음을 이어붙일 때 사이에 넣는 무음. 두 이유로 필요하다: 슬라이서가 두 녹음을
// 별개 조각으로 잡아야 하고(붙여 두면 마지막 음절과 첫 음절이 한 덩이가 된다),
// 사람이 들을 때도 "문장이 나뉜" 느낌이 있어야 이어 말한 것처럼 뭉치지 않는다.
export const JOIN_GAP_SEC = 0.25;
// 이어붙일 수 있는 총 길이. 넘으면 분석·렌더가 길어지고 음절 수가 곡 길이를 밀어올린다.
export const MAX_TOTAL_SEC = 120;

// 녹음 여러 개를 하나로 잇는다. 브라우저 API를 모르는 순수 함수라 node --test로
// 검증한다 — AudioBuffer 만들기는 호출자(ui.js)가 한다.
//
// 앞뒤 무음을 다듬지 않는다: 녹음 시작·끝의 침묵은 voiceSpan이 이미 잘라내고,
// 여기서 손대면 "어디까지가 몇 번째 녹음인가"가 두 곳에서 결정된다.
export function joinSamples(chunks, sampleRate, gapSec = JOIN_GAP_SEC) {
  const parts = chunks.filter((c) => c && c.length > 0);
  if (parts.length === 0) return new Float32Array(0);
  if (parts.length === 1) return parts[0];
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
