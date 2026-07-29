export const MAX_RECORD_MS = 30000;

export function isSpeechRecognitionSupported() {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// 받아쓰기는 음악 생성에 필요하지 않다 — 실패해도 녹음을 막지 않는다.
function startTranscription(onTranscript) {
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

  recognition.onerror = () => {}; // network/no-speech는 무시 — 음악은 계속된다

  recognition.onend = () => {
    state.committed = joined();
    state.current = '';
    if (state.done) return;
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
  onLevel = () => {},
  onTranscript = () => {},
  onAutoStop = () => {},
} = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();

  const frame = new Float32Array(analyser.fftSize);
  let rafId = requestAnimationFrame(function tick() {
    analyser.getFloatTimeDomainData(frame);
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    onLevel(Math.sqrt(sum / frame.length));
    rafId = requestAnimationFrame(tick);
  });

  const transcriber = startTranscription(onTranscript);

  const timer = setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
      onAutoStop();
    }
  }, maxMs);

  return {
    async stop() {
      clearTimeout(timer);
      cancelAnimationFrame(rafId);
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
      const audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      await ctx.close();
      return { audioBuffer, transcript: transcriber ? transcriber.text() : '' };
    },
  };
}
