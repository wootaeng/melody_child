import { sliceSyllables } from './slicer.js';
import { detectF0 } from './pitch.js';
import { composeMelody, chordsFor } from './composer.js';
import { buildGraph, renderOffline } from './synth.js';
import { encodeWav } from './exporter.js';
import { startRecording, isSpeechRecognitionSupported, MAX_RECORD_MS } from './recorder.js';
import { makeDevSample } from './devsample.js';

const MIN_NOTES = 8; // 한 절

const el = (id) => document.getElementById(id);
const screens = { idle: el('screen-idle'), recording: el('screen-recording'), result: el('screen-result') };

let session = null; // { audioBuffer, segments, f0s, transcript, rawCount }
let seed = 1;
let handle = null;
let playing = null; // AudioContext

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

function drawWaveform(samples, segments) {
  const canvas = el('waveform');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = '#e8f0fe';
  ctx.fillRect(0, 0, width, height);

  const step = Math.max(1, Math.floor(samples.length / width));
  ctx.strokeStyle = '#3b6fd4';
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    let peak = 0;
    const from = x * step;
    for (let i = from; i < from + step && i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    const h = peak * height * 0.45;
    ctx.moveTo(x, height / 2 - h);
    ctx.lineTo(x, height / 2 + h);
  }
  ctx.stroke();

  ctx.strokeStyle = '#d94f4f';
  ctx.lineWidth = 1;
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

function analyze(audioBuffer, transcript) {
  const samples = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const found = sliceSyllables(samples, sampleRate);
  if (found.length === 0) return null;

  const segments = normalizeSegments(found);
  const f0s = segments.map((seg) => detectF0(samples.subarray(seg.start, seg.end), sampleRate));
  drawWaveform(samples, found);
  return { audioBuffer, segments, f0s, transcript, rawCount: found.length };
}

function stopPlayback() {
  if (playing) {
    playing.close();
    playing = null;
  }
}

async function play() {
  stopPlayback();
  const melody = composeMelody(session.segments.length, seed);
  const ctx = new AudioContext();
  playing = ctx;
  await ctx.resume();
  buildGraph(ctx, {
    audioBuffer: session.audioBuffer,
    segments: session.segments,
    f0s: session.f0s,
    melody,
    chords: chordsFor(melody),
  });
}

async function save() {
  const melody = composeMelody(session.segments.length, seed);
  const rendered = await renderOffline({
    audioBuffer: session.audioBuffer,
    segments: session.segments,
    f0s: session.f0s,
    melody,
    chords: chordsFor(melody),
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
  const melody = composeMelody(session.segments.length, seed);
  const notes = [`${melody.verseCount}절 노래가 됐어요.`];
  if (session.rawCount < MIN_NOTES) notes.push('소리가 적어서 몇 번 반복했어요.');
  el('result-note').textContent = notes.join(' ');
  show('result');
}

async function startSession() {
  setNotice('');
  try {
    handle = await startRecording({
      onLevel: (level) => {
        el('level').style.width = `${Math.min(100, level * 400)}%`;
      },
      onTranscript: (text) => {
        el('live-transcript').textContent = text;
      },
      onAutoStop: () => {
        finishSession();
      },
    });
  } catch {
    setNotice('마이크를 쓸 수 없어요. 브라우저에서 마이크를 허용해 주세요.');
    show('idle');
    return;
  }
  el('live-transcript').textContent = '';
  el('level').style.width = '0%';
  el('stt-warning').hidden = isSpeechRecognitionSupported();
  show('recording');
}

async function finishSession() {
  if (!handle) return;
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
  showResult();
  play();
}

function loadDevSample() {
  const ctx = new AudioContext();
  const samples = makeDevSample(ctx.sampleRate);
  const audioBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  audioBuffer.copyToChannel(samples, 0);
  ctx.close();
  const analyzed = analyze(audioBuffer, '개발용 샘플');
  if (!analyzed) throw new Error('개발 샘플 분석 실패');
  session = analyzed;
  showResult();
}

el('start').addEventListener('click', startSession);
el('stop').addEventListener('click', finishSession);
el('replay').addEventListener('click', play);
el('remix').addEventListener('click', () => {
  seed += 1;
  play();
});
el('download').addEventListener('click', save);
el('again').addEventListener('click', () => {
  stopPlayback();
  session = null;
  setNotice('');
  show('idle');
});

el('limit-hint').textContent = `${MAX_RECORD_MS / 1000}초까지 녹음돼요.`;

if (new URLSearchParams(location.search).get('dev') === 'sample') {
  loadDevSample();
} else {
  show('idle');
}
