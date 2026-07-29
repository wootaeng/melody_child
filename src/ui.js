import { sliceSyllables } from './slicer.js';
import { detectF0, findGrain } from './pitch.js';
import { composeMelody, VERSE_LEN } from './composer.js';
import { buildGraph, renderOffline, safeStartTime } from './synth.js';
import { encodeWav } from './exporter.js';
import { startRecording, isSpeechRecognitionSupported, MAX_RECORD_MS } from './recorder.js';
import { makeDevSample } from './devsample.js';

const MIN_NOTES = VERSE_LEN; // 최소 한 절

const el = (id) => document.getElementById(id);
const screens = { idle: el('screen-idle'), recording: el('screen-recording'), result: el('screen-result') };

let session = null; // { audioBuffer, segments, grains, transcript, bounds, rawCount, referenceHz, melody }
let seed = 1;
let handle = null;
let audioCtx = null;
let playingMaster = null;
let playToken = 0;
let beadRaf = 0;

function show(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.hidden = key !== name;
  }
}

function setNotice(text) {
  el('notice').textContent = text;
}

// 조각이 한 절(8개)보다 적으면 순환 반복해 채운다. 상한은 없다 —
// 이야기가 길면 절이 늘어난다. 이 정규화를 여기서 끝내므로
// synth.buildGraph는 개수 불일치를 다루지 않는다.
function normalizeSegments(segments) {
  const out = segments.slice();
  for (let i = 0; out.length < MIN_NOTES; i++) out.push(segments[i % segments.length]);
  return out;
}

const COLOR = {
  card: '#fdfefd',
  ink: '#16323c',
  voice: '#f0654a',
  voiceRest: '#f6c5b6',
  rule: '#b9d4ca',
};

// 캔버스를 화면에 보이는 크기 × 픽셀비로 맞춘다. 이걸 안 하면 구슬이 흐려진다.
function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const box = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width * dpr));
  const h = Math.max(1, Math.round(box.height * dpr));
  // 크기가 그대로면 건드리지 않는다 — 매 프레임 재할당하면 재생 중 버벅인다
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: box.width, height: box.height };
}

// 시그니처 요소. 음절 하나가 구슬 하나, 높이가 음높이, 크기가 음 길이다.
// melody가 없으면(아직 말하기 전) 점선만 그려 자리를 알려준다.
function drawBeads(melody, activeIndex = -1) {
  const { ctx, width, height } = fitCanvas(el('beads'));
  ctx.clearRect(0, 0, width, height);

  const padX = 14;
  const midY = height / 2;

  if (!melody) {
    ctx.strokeStyle = COLOR.rule;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 9]);
    ctx.beginPath();
    ctx.moveTo(padX, midY);
    ctx.lineTo(width - padX, midY);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const notes = melody.notes;
  const midis = notes.map((n) => n.midi);
  const low = Math.min(...midis);
  const span = Math.max(1, Math.max(...midis) - low);
  const top = 26;
  const bottom = height - 26;

  const xAt = (i) => padX + ((width - padX * 2) * i) / Math.max(1, notes.length - 1);
  const yAt = (i) => bottom - ((midis[i] - low) / span) * (bottom - top);

  // 절 경계 눈금 — 같은 곡조가 여기서 다시 시작한다는 사실을 표시한다
  ctx.strokeStyle = COLOR.rule;
  ctx.lineWidth = 1;
  for (let i = melody.verseLen; i < notes.length; i += melody.verseLen) {
    const x = (xAt(i - 1) + xAt(i)) / 2;
    ctx.beginPath();
    ctx.moveTo(x, top - 12);
    ctx.lineTo(x, bottom + 12);
    ctx.stroke();
  }

  // 구슬을 잇는 실
  ctx.strokeStyle = COLOR.rule;
  ctx.lineWidth = 2;
  ctx.beginPath();
  notes.forEach((_, i) => (i ? ctx.lineTo(xAt(i), yAt(i)) : ctx.moveTo(xAt(i), yAt(i))));
  ctx.stroke();

  notes.forEach((note, i) => {
    const r = note.beats >= 1 ? 8 : 5.5;
    const isActive = i === activeIndex;
    ctx.beginPath();
    ctx.arc(xAt(i), yAt(i), isActive ? r + 3 : r, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? COLOR.voice : COLOR.voiceRest;
    ctx.fill();
    if (isActive) {
      ctx.strokeStyle = COLOR.card;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  });
}

function drawWaveform(samples, segments) {
  const { ctx, width, height } = fitCanvas(el('waveform'));

  ctx.fillStyle = COLOR.card;
  ctx.fillRect(0, 0, width, height);

  const step = Math.max(1, Math.floor(samples.length / width));
  ctx.strokeStyle = COLOR.ink;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    let peak = 0;
    const from = x * step;
    for (let i = from; i < from + step && i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    const h = peak * height * 0.42;
    ctx.moveTo(x, height / 2 - h);
    ctx.lineTo(x, height / 2 + h);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 음절 경계 — 어디서 잘렸는지가 곧 음이 몇 개인지다
  ctx.strokeStyle = COLOR.voice;
  for (const seg of segments) {
    for (const pos of [seg.start, seg.end]) {
      const x = (pos / samples.length) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }
}

// 멜로디는 한 곳에서만 만든다. 재생·저장·안내 문구가 같은 곡을 봐야 한다.
function refreshMelody() {
  session.melody = composeMelody(session.segments.length, seed, session.referenceHz);
}

function analyze(audioBuffer, transcript) {
  const samples = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const found = sliceSyllables(samples, sampleRate);
  if (found.length === 0) return null;

  const segments = normalizeSegments(found);
  const grains = segments.map((seg) => findGrain(samples, sampleRate, seg));
  const voiced = grains.filter(Boolean).map((g) => g.f0).sort((a, b) => a - b);
  const referenceHz = voiced.length ? voiced[Math.floor(voiced.length / 2)] : null;
  // 그리기는 여기서 하지 않는다 — 결과 화면이 아직 hidden이라 캔버스 크기가 0이다.
  // bounds는 정규화 전 경계다(반복으로 채운 조각은 같은 선을 두 번 그리게 된다).
  return {
    audioBuffer,
    segments,
    grains,
    transcript,
    bounds: found,
    rawCount: found.length,
    referenceHz,
  };
}

function stopBeads() {
  if (beadRaf) cancelAnimationFrame(beadRaf);
  beadRaf = 0;
}

// 구슬을 소리에 맞춰 켠다. 시각은 buildGraph가 준 것을 그대로 쓴다 —
// 여기서 다시 계산하면 화면과 소리가 어긋난다.
function followBeads(ctx, noteTimes, melody) {
  stopBeads();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    drawBeads(melody, -1);
    return;
  }
  const last = noteTimes[noteTimes.length - 1];
  const tick = () => {
    const t = ctx.currentTime;
    let active = -1;
    for (let i = 0; i < noteTimes.length; i++) if (t >= noteTimes[i]) active = i;
    drawBeads(melody, active);
    if (t > last + 1) {
      beadRaf = 0;
      drawBeads(melody, -1);
      return;
    }
    beadRaf = requestAnimationFrame(tick);
  };
  beadRaf = requestAnimationFrame(tick);
}

function stopPlayback() {
  stopBeads();
  if (playingMaster) {
    playingMaster.disconnect();
    playingMaster = null;
  }
  if (session?.melody) drawBeads(session.melody, -1);
}

// iOS는 재생이 끝나면 컨텍스트를 interrupted 상태로 두는 경우가 있다. 그 상태의
// 시계는 멈춰 있어서 그 시각에 스케줄하면 아무 소리도 나지 않는다 — "다시 듣기가
// 안 된다"는 증상이 여기서 나온다. resume 후에도 running이 아니면 새로 만든다.
async function playbackContext() {
  if (audioCtx && audioCtx.state === 'closed') audioCtx = null;
  if (!audioCtx) audioCtx = new AudioContext();
  await audioCtx.resume();
  if (audioCtx.state !== 'running') {
    try {
      await audioCtx.close();
    } catch {
      /* 이미 닫힌 경우 */
    }
    audioCtx = new AudioContext();
    await audioCtx.resume();
  }
  return audioCtx;
}

async function play() {
  const token = ++playToken;
  stopPlayback();
  const current = session;
  if (!current) return;

  const ctx = await playbackContext();
  const startTime = await safeStartTime(ctx);
  // await 사이에 다시 녹음·연타가 끼어들면 이 재생은 이미 무효다
  if (token !== playToken || session !== current) return;

  // 전역 audioCtx가 아니라 이 호출이 받은 ctx를 쓴다 — playbackContext가
  // 컨텍스트를 교체했을 수 있고, 그때 전역을 쓰면 엉뚱한 곳에 스케줄한다
  const { master, noteTimes } = buildGraph(
    ctx,
    {
      audioBuffer: current.audioBuffer,
      segments: current.segments,
      grains: current.grains,
      melody: current.melody,
    },
    startTime,
  );
  playingMaster = master;
  followBeads(ctx, noteTimes, current.melody);
}

async function save() {
  const rendered = await renderOffline({
    audioBuffer: session.audioBuffer,
    segments: session.segments,
    grains: session.grains,
    melody: session.melody,
  });
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c));
  const url = URL.createObjectURL(encodeWav(channels, rendered.sampleRate));
  const link = document.createElement('a');
  link.href = url;
  link.download = '내동요.wav';
  link.click();
  URL.revokeObjectURL(url);
}

function showResult() {
  el('lyrics').textContent = session.transcript;
  el('lyrics').hidden = !session.transcript;

  // 칩은 사실만 담는다 — 절 수와 음절 수는 아이가 화면에서 확인할 수 있는 정보다
  const facts = [`${session.melody.verseCount}절`, `${session.segments.length}음절`];
  if (session.rawCount < MIN_NOTES) facts.push('짧아서 반복했어요');
  el('chips').replaceChildren(
    ...facts.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );

  // 캔버스는 CSS 폭을 재서 그리므로 화면을 먼저 띄운 뒤에 그린다
  show('result');
  drawBeads(session.melody, -1);
  drawWaveform(session.audioBuffer.getChannelData(0), session.bounds);
}

async function startSession() {
  setNotice('');
  el('start').disabled = true;
  try {
    handle = await startRecording({
      onTranscript: (text) => {
        el('live-transcript').textContent = text;
      },
      onAutoStop: () => {
        finishSession();
      },
      onTranscriptUnavailable: () => {
        el('stt-warning').hidden = false;
      },
    });
  } catch {
    setNotice('마이크를 쓸 수 없어요. 브라우저에서 마이크를 허용해 주세요.');
    show('idle');
    return;
  } finally {
    el('start').disabled = false;
  }
  el('live-transcript').textContent = '';
  el('stt-warning').hidden = isSpeechRecognitionSupported();
  show('recording');
  startCountdown();
}

// 남은 시간 게이지. 애니메이션을 다시 붙이려면 클래스를 떼고 리플로를 한 번
// 강제해야 한다 — 그러지 않으면 두 번째 녹음에서 게이지가 움직이지 않는다.
function startCountdown() {
  const bar = el('remaining');
  bar.classList.remove('counting');
  void bar.offsetWidth;
  bar.style.animationDuration = `${MAX_RECORD_MS}ms`;
  bar.classList.add('counting');
  el('countdown-label').textContent = `${MAX_RECORD_MS / 1000}초 안에 말해 주세요`;
}

function stopCountdown() {
  el('remaining').classList.remove('counting');
}

async function finishSession() {
  if (!handle) return;
  stopCountdown();
  const current = handle;
  handle = null;
  let recording;
  try {
    recording = await current.stop();
  } catch {
    setNotice('녹음을 읽지 못했어요. 다시 해볼까요?');
    show('idle');
    return;
  }
  const analyzed = analyze(recording.audioBuffer, recording.transcript);
  if (!analyzed) {
    setNotice('소리가 너무 작아요. 조금 더 크게 말해 주세요.');
    show('idle');
    return;
  }
  session = analyzed;
  seed = 1;
  refreshMelody();
  showResult();
  play().catch(() => setNotice('노래를 틀지 못했어요. 다시 듣기를 눌러 주세요.'));
}

function loadDevSample(glideCents) {
  const ctx = new AudioContext();
  const samples = makeDevSample(ctx.sampleRate, { glideCents });
  const audioBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  audioBuffer.copyToChannel(samples, 0);
  ctx.close();
  const analyzed = analyze(audioBuffer, '개발용 샘플');
  if (!analyzed) throw new Error('개발 샘플 분석 실패');
  session = analyzed;
  refreshMelody();
  showResult();
}

// 녹음 경로처럼 재생·저장 경로도 실패를 화면에 알린다. 감싸지 않으면 미처리
// 프로미스 거부로 콘솔에만 남고, 사용자에겐 아무 설명 없이 소리만 안 난다.
function guarded(action, message) {
  return async () => {
    try {
      await action();
    } catch {
      setNotice(message);
    }
  };
}

el('start').addEventListener('click', startSession);
el('stop').addEventListener('click', finishSession);
el('replay').addEventListener('click', guarded(play, '노래를 다시 틀지 못했어요.'));
el('remix').addEventListener(
  'click',
  guarded(() => {
    seed += 1;
    refreshMelody();
    return play();
  }, '새 멜로디를 만들지 못했어요.'),
);
el('download').addEventListener('click', guarded(save, 'WAV 파일을 만들지 못했어요.'));
el('again').addEventListener('click', () => {
  stopPlayback();
  session = null;
  setNotice('');
  drawBeads(null);
  show('idle');
});

// 회전·창 크기 변경 시 구슬과 파형을 다시 그린다 — 캔버스는 CSS 폭에 맞춰 그려진다
window.addEventListener('resize', () => {
  drawBeads(session?.melody ?? null, -1);
  if (session && !screens.result.hidden) {
    drawWaveform(session.audioBuffer.getChannelData(0), session.bounds);
  }
});

el('limit-hint').textContent = `${MAX_RECORD_MS / 1000}초까지 녹음돼요.`;

const devMode = new URLSearchParams(location.search).get('dev');
if (devMode === 'sample') {
  loadDevSample(0);
} else if (devMode === 'glide') {
  loadDevSample(400); // 음절 안에서 4반음 활강 — 실제 말소리에 가깝다
} else {
  drawBeads(null);
  show('idle');
}
