import { sliceSyllables } from './slicer.js';
import { findGrain } from './pitch.js';
import { findPitchMarks } from './psola.js';
import { composeMelody, VERSE_LEN } from './composer.js';
import {
  renderOffline, progressAt, renderVoices, voiceSpan, alignToBeats, mixLevels, MELODY_TO_VOICE,
} from './synth.js';
import { ridePlan } from './leveler.js';
import { encodeWav } from './exporter.js';
import {
  startRecording, isSpeechRecognitionSupported, MAX_RECORD_MS, joinSamples, MAX_TOTAL_SEC,
} from './recorder.js';
import { makeDevSample } from './devsample.js';
import { INSTRUMENTS, DEFAULT_INSTRUMENT, pickInstrument } from './instruments.js';

const MIN_NOTES = VERSE_LEN; // 최소 한 절
const NARROW_DEGREES = [0, 2, 4]; // 도·레·미 — 옮기는 폭이 4반음 안에 머문다

// URL 손잡이. 음정을 옮기는 폭이 곧 목소리 왜곡의 양이라, 실기에서 귀로 비교할
// 수 있게 밖으로 뺐다. 기본은 chant(목소리를 자르지 않고 멜로디를 아래에 깐다) —
// 실기 판정으로 이 방향이 정해졌다. mode=full(음절을 음정으로 옮김) / narrow(도레미),
// pad=1(반주 아르페지오), debug=1(진단 숫자 — 폰에서는 콘솔을 볼 수 없다).
const urlParams = new URLSearchParams(location.search);
const mode = urlParams.get('mode') || 'chant';
const withPad = urlParams.has('pad');
const debugMode = urlParams.has('debug');
// 챈트에서 음절 시작을 박에 맞출지. 기본은 맞춘다(박에 안 맞는 게 거슬린다는
// 실기 지적) — `?align=0`이면 녹음을 통째로 흘려보내는 이전 방식이다.
const aligned = urlParams.get('align') !== '0';
// 멜로디 음량 비율(정규화한 목소리 RMS 대비). 화면 버튼으로 바꾸고 URL로 기본값을
// 정한다 — 악기와 같은 방식이다. 초기값을 synth의 기본과 같게 두면 버튼 선택 표시가
// 실제로 울리는 음량과 항상 일치한다.
let melodyRatio = Number(urlParams.get('mel')) > 0 ? Number(urlParams.get('mel')) : MELODY_TO_VOICE;
// 배음 세기(기본 1, 0이면 순수 사인파). 밝을수록 같은 진폭에서 더 크게 들린다.
// 존재 확인이 먼저다 — Number(null)은 0이라 파라미터가 없을 때 사인파로 떨어진다.
const melodyTone = urlParams.has('tone') && Number(urlParams.get('tone')) >= 0
  ? Number(urlParams.get('tone'))
  : undefined;
// 조용한 음절을 끌어올리는 상한(dB). `?ride=0`이면 완전히 우회해 라이드 이전과
// **비트 단위로 같은** 소리가 난다 — 폰에서 그 A/B가 성립해야 "안 들린다"의 원인이
// 동적 범위인지 가릴 수 있다. 청취로 맞추는 값이라 ?mel=·?tone=과 같이 URL로 뺀다.
//
// 존재 확인이 먼저다 — `Number(null)`은 0이라 파라미터가 없을 때 라이드가 꺼진다
// (?tone=과 같은 함정). 숫자가 아니면 없는 것으로 본다: NaN을 그대로 넘기면 라이드가
// 조용히 전체 우회되는데 진단 칩에는 `+0.0dB`로 찍혀 **"격차가 없는 녹음"과 구분되지
// 않고**, 그건 그 칩의 목적(0.0이면 원인이 동적 범위가 아니다)과 정면으로 충돌한다.
const rideDb = urlParams.has('ride') && Number.isFinite(Number(urlParams.get('ride')))
  ? Math.max(0, Number(urlParams.get('ride')))
  : undefined;
// 멜로디 악기. URL로 기본값을 정하고 화면 버튼으로 바꾼다 — 아이폰에서 주소를
// 고치지 않고 A/B할 수 있어야 실기 청취가 굴러간다.
let instrument = INSTRUMENTS[urlParams.get('inst')] ? urlParams.get('inst') : DEFAULT_INSTRUMENT;

const el = (id) => document.getElementById(id);
const screens = { idle: el('screen-idle'), recording: el('screen-recording'), result: el('screen-result') };

// renderOffline에 이 객체를 그대로 넘긴다 — 필드를 골라 옮기면 재생과 저장이
// 갈라진다. songUrl·songBlob·noteTimes는 렌더 결과 캐시(멜로디가 바뀌면 버린다).
let session = null; // { audioBuffer, segments, grains, pitchMarks, transcript, bounds, rawCount, referenceHz, melody, voices, songUrl, songBlob, noteTimes }
let seed = 1;
let handle = null;
let player = null;
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
//
// 조각이 아니라 인덱스를 반복한다: 분석(f0·피치 마크)은 원본 조각 수만큼만 하고
// 반복분은 결과를 같이 가리키게 된다. 조각을 먼저 늘리면 1음절 녹음에서 같은
// 조각을 여덟 번 분석한다.
function normalizeIndices(count) {
  const indices = Array.from({ length: count }, (_, i) => i);
  for (let i = 0; indices.length < MIN_NOTES; i++) indices.push(i % count);
  return indices;
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
// progress는 0~1 재생 위치(구슬 사이를 시간으로 보간한 값) — 음악 앱처럼 선이
// 지나간다. -1이면 그리지 않는다(정지 상태).
function drawBeads(melody, activeIndex = -1, progress = -1) {
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

  // 재생 위치. 구슬보다 먼저 그려 구슬이 선 위에 온다.
  if (progress >= 0) {
    const x = padX + (width - padX * 2) * Math.min(1, progress);
    ctx.strokeStyle = COLOR.voiceRest;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, top - 16);
    ctx.lineTo(x, bottom + 16);
    ctx.stroke();
  }

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
// 목소리 버퍼도 여기서 함께 만든다 — 멜로디가 바뀔 때만 다시 만들면 되고,
// 재생 직전에 만들면 시작 시각을 잡은 뒤 수십 ms를 먹어 첫 음이 밀린다.
function refreshMelody() {
  dropSong();
  const degrees = mode === 'narrow' ? NARROW_DEGREES : undefined;
  const chant = mode === 'chant';

  // 챈트는 목소리를 음절 단위로 다시 배치하지 않으므로 음 개수가 음절 수에
  // 묶이지 않는다 — 목소리 길이를 덮을 만큼 만든다. 박 길이를 알려면 bpm이
  // 필요하고 bpm은 시드에서만 나오므로 한 음짜리로 한 번 떠본다(같은 시드면 같은 bpm).
  let noteCount = session.segments.length;
  if (chant) {
    const beatSec = 60 / composeMelody(1, seed, session.referenceHz, { degrees }).bpm;
    // 정렬하면 쉼이 박 단위로 올림되어 목소리가 길어진다 — 렌더와 같은 함수로 잰다
    const voiceSec = aligned
      ? alignToBeats(session.bounds, session.audioBuffer.sampleRate, beatSec).totalSec
      : voiceSpan(session.audioBuffer, session.bounds).sec;
    noteCount = Math.max(VERSE_LEN, Math.ceil(voiceSec / beatSec));
  }

  session.melody = composeMelody(noteCount, seed, session.referenceHz, { degrees });
  // 챈트는 음절을 옮기지 않으니 목소리 버퍼를 만들 필요가 없다
  session.voices = chant
    ? null
    : renderVoices(session.audioBuffer.getChannelData(0), session.audioBuffer.sampleRate, session);
}

// 렌더에 넘길 재료. 모드에 따라 목소리를 손대는 정도만 달라진다 —
// 박자·구슬·저장은 전부 같은 경로를 탄다.
function renderSpec() {
  // 챈트는 목소리를 자르지 않고 멜로디를 아래에 깐다(chant). align이면 음절 시작만
  // 박에 맞춘다. 나머지 모드는 음절을 음정으로 옮겨 배치하고 반주는 선택이다.
  return {
    ...session,
    chant: mode === 'chant',
    align: aligned,
    pad: withPad,
    melodyRatio,
    melodyTone,
    instrument,
    rideDb,
  };
}

function analyze(audioBuffer, transcript) {
  const samples = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const found = sliceSyllables(samples, sampleRate);
  if (found.length === 0) return null;

  // 피치 마크는 멜로디와 무관하다(조각과 그 음절의 f0에만 의존) — 여기서 한 번만
  // 찍는다. buildGraph는 재생·리믹스마다 불리므로 그 안에서 찍으면 같은 계산을
  // 반복한다. 그레인이 없는 무성 자음은 애초에 음정을 옮기지 않으므로 건너뛴다.
  const foundGrains = found.map((seg) => findGrain(samples, sampleRate, seg));
  const foundMarks = found.map((seg, i) =>
    foundGrains[i] ? findPitchMarks(samples, sampleRate, seg, { periodHint: sampleRate / foundGrains[i].f0 }) : null,
  );

  const indices = normalizeIndices(found.length);
  const segments = indices.map((i) => found[i]);
  const grains = indices.map((i) => foundGrains[i]);
  const pitchMarks = indices.map((i) => foundMarks[i]);
  const voiced = grains.filter(Boolean).map((g) => g.f0).sort((a, b) => a - b);
  const referenceHz = voiced.length ? voiced[Math.floor(voiced.length / 2)] : null;
  // 그리기는 여기서 하지 않는다 — 결과 화면이 아직 hidden이라 캔버스 크기가 0이다.
  // bounds는 정규화 전 경계다(반복으로 채운 조각은 같은 선을 두 번 그리게 된다).
  return {
    audioBuffer,
    segments,
    grains,
    pitchMarks,
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

// 구슬을 소리에 맞춰 켠다. 시각은 렌더가 준 noteTimes와 재생 중인 요소의
// currentTime을 쓴다 — 화면이 박자를 다시 계산하면 소리와 어긋난다.
function followBeads(media, noteTimes, melody) {
  stopBeads();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    drawBeads(melody, -1);
    return;
  }
  const last = noteTimes[noteTimes.length - 1];
  const tick = () => {
    const t = media.currentTime;
    let active = -1;
    for (let i = 0; i < noteTimes.length; i++) if (t >= noteTimes[i]) active = i;
    drawBeads(melody, active, progressAt(noteTimes, t));
    if (media.ended || media.paused || t > last + 1.5) {
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
  if (player) {
    player.pause();
    player.currentTime = 0;
  }
  if (session?.melody) drawBeads(session.melody, -1);
}

// 곡을 한 번 렌더해 WAV로 만들어 둔다. 재생과 저장이 같은 바이트를 쓰므로
// "들은 것"과 "내려받은 것"이 어긋날 수 없다. 멜로디가 바뀌면 버린다.
async function songUrl() {
  if (!session.songUrl) {
    const { buffer, noteTimes } = await renderOffline(renderSpec());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    session.songBlob = encodeWav(channels, buffer.sampleRate);
    session.songUrl = URL.createObjectURL(session.songBlob);
    session.noteTimes = noteTimes;
  }
  return session.songUrl;
}

function dropSong() {
  if (session?.songUrl) URL.revokeObjectURL(session.songUrl);
  if (session) {
    session.songUrl = null;
    session.songBlob = null;
  }
}

// Web Audio로 직접 재생하지 않고 <audio> 요소로 재생한다.
//
// 아이폰에서 "다시 듣기가 안 되는데 내려받은 WAV는 들린다"는 보고가 이 차이를
// 가리켰다: Web Audio 출력은 음소거 스위치와 오디오 세션 상태(iOS는 재생이 끝나면
// 컨텍스트를 interrupted로 두는 경우가 있고, 그 상태의 시계는 멈춰 있다)에 묶이는데
// 미디어 요소 재생은 그렇지 않다. 렌더한 WAV를 그대로 재생하면 그 경로를 아예
// 쓰지 않게 되고, 컨텍스트 되살리기·시계 대기 같은 우회 코드도 필요 없어진다.
async function play() {
  const token = ++playToken;
  stopPlayback();
  const current = session;
  if (!current) return;

  const url = await songUrl();
  // await 사이에 다시 녹음·연타가 끼어들면 이 재생은 이미 무효다
  if (token !== playToken || session !== current) return;

  if (!player) {
    player = new Audio();
    player.preload = 'auto';
  }
  if (player.src !== url) player.src = url;
  player.currentTime = 0;
  await player.play();
  followBeads(player, current.noteTimes, current.melody);
}

async function save() {
  await songUrl(); // 재생과 같은 렌더 결과를 쓴다
  const link = document.createElement('a');
  link.href = session.songUrl;
  link.download = '내동요.wav';
  link.click();
}

// 실기(아이폰)에서 소리가 이상할 때 원인을 좁히기 위한 숫자. 화면에서 읽어
// 전달할 수 있어야 하므로 콘솔이 아니라 칩으로 띄운다 — 폰에서는 콘솔을 못 본다.
// PSOLA가 몇 음에 실제로 적용됐는지가 핵심이다(폴백 그레인 루프가 곧 비프음이다).
function diagnostics() {
  const sr = session.audioBuffer.sampleRate;
  const midis = session.melody.notes.map((n) => n.midi);
  const lo = Math.min(...midis);
  const hi = Math.max(...midis);
  const preset = pickInstrument(instrument);
  const facts = [
    `mode ${mode}${withPad ? '+pad' : ''}`,
    `악기 ${instrument}`,
    `기준 ${Math.round(session.referenceHz || 0)}Hz`,
    `${session.melody.bpm}bpm`,
    `midi ${lo}~${hi}`,
  ];
  // 프리셋이 음역을 옮기면 실제로 울리는 음이 작곡값과 다르다. 실기 8차에서 midi
  // 51~55(155~196Hz)가 목소리 기본음과 겹쳐 묻힌 것이 "멜로디가 작다"의 원인이었으니,
  // 폰에서 어느 음역을 듣고 있는지 읽을 수 있어야 한다.
  if (preset.octave > 0) facts.push(`울림 ${lo + preset.octave * 12}~${hi + preset.octave * 12}`);
  if (!session.voices) {
    // 챈트 진단: 목소리 길이와 멜로디 음량(목소리 RMS에서 나온다)
    const span = voiceSpan(session.audioBuffer, session.bounds);
    const { melodyLevel, voiceGain } = mixLevels(
      session.audioBuffer.getChannelData(0),
      Math.round(span.from * sr),
      Math.round(span.sec * sr),
      melodyRatio,
    );
    facts.push(
      `목소리 ${span.sec.toFixed(1)}초`,
      `증폭 ${voiceGain.toFixed(1)}배`,
      // 상한에 붙으면 비율(?mel=)을 더 올려도 변화가 없다 — 그 사실을 드러낸다
      `멜로디 ${melodyLevel.toFixed(2)}${melodyLevel >= 1 ? ' 상한' : ''}`,
    );
    // 라이드가 실제로 무엇을 했는지. **+0.0dB로 나오면 이 녹음에는 음절 간 격차가
    // 없었다는 뜻**이고, 그러면 "안 들린다"의 원인이 동적 범위가 아니다 — 폰 화면에서
    // 그걸 바로 읽을 수 있어야 다음 가설로 넘어갈 수 있다.
    const ride = ridePlan(
      session.audioBuffer.getChannelData(0),
      sr,
      Math.round(span.from * sr),
      Math.round(span.sec * sr),
      { maxBoostDb: rideDb },
    );
    facts.push(
      `라이드 +${ride.meanBoostDb.toFixed(1)}dB` +
        (ride.meanBoostDb > 0 ? ` (${Math.round(ride.spreadBeforeDb)}→${Math.round(ride.spreadAfterDb)})` : ''),
    );
    if (aligned && session.bounds.length) {
      const { totalSec, gridSec } = alignToBeats(
        session.bounds,
        sr,
        60 / session.melody.bpm,
      );
      facts.push(`격자 ${Math.round(gridSec * 1000)}ms`, `정렬 ${totalSec.toFixed(1)}초`);
    } else {
      facts.push('통째로');
    }
    return facts;
  }
  const spans = session.pitchMarks.map((pm) => (pm ? pm.marks[pm.marks.length - 1] - pm.marks[0] : 0));
  const used = session.voices.map((v, i) => (v && spans[i] > 0 ? i : -1)).filter((i) => i >= 0);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  facts.push(
    `psola ${session.voices.filter(Boolean).length}/${session.voices.length}`,
    `재료 ${Math.round((avg(used.map((i) => spans[i])) / sr) * 1000)}ms`,
    `채움 ${avg(used.map((i) => session.voices[i].length / spans[i])).toFixed(1)}배`,
  );
  return facts;
}

// 칩은 사실만 담는다 — 절 수와 음절 수는 아이가 화면에서 확인할 수 있는 정보다.
// 악기를 바꿀 때도 다시 그린다(진단 칩의 악기·울림 음역이 따라와야 한다).
function renderChips() {
  const facts = [`${session.melody.verseCount}절`, `${session.segments.length}음절`];
  if (session.rawCount < MIN_NOTES) facts.push('짧아서 반복했어요');
  if (debugMode) facts.push(...diagnostics());
  el('chips').replaceChildren(
    ...facts.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
}

function showResult() {
  el('lyrics').textContent = session.transcript;
  el('lyrics').hidden = !session.transcript;
  renderChips();

  // 캔버스는 CSS 폭을 재서 그리므로 화면을 먼저 띄운 뒤에 그린다
  show('result');
  drawBeads(session.melody, -1);
  drawWaveform(session.audioBuffer.getChannelData(0), session.bounds);
}

// 멜로디 음량 단계. 실기에서 "지금보다 조금 줄이거나 조절 버튼이 있으면 좋겠다"는
// 판정을 받아 넣었다 — 목소리와의 균형은 녹음마다 다르게 들리므로 **아이가 화면에서
// 바로 고치는 것**이 URL 손잡이(?mel=)보다 실용적이다. `보통`이 synth의 기본값이라
// 값을 두 곳에 적지 않는다.
const MELODY_LEVELS = [
  { label: '아주 작게', ratio: 1.2 },
  { label: '작게', ratio: 1.8 },
  { label: '보통', ratio: MELODY_TO_VOICE },
  { label: '크게', ratio: 3.2 },
];

// 음량 버튼도 악기와 같은 규칙이다: **곡은 그대로 두고 렌더 결과만 버린다.**
function buildMelodyLevelPicker() {
  el('melody-levels').append(
    ...MELODY_LEVELS.map(({ label, ratio }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.ratio = String(ratio);
      button.addEventListener(
        'click',
        guarded(() => selectMelodyLevel(ratio), '멜로디 음량을 바꾸지 못했어요.'),
      );
      return button;
    }),
  );
  syncMelodyLevelPicker();
}

function syncMelodyLevelPicker() {
  for (const button of el('melody-levels').querySelectorAll('button')) {
    // ?mel=로 단계에 없는 값을 준 경우 아무 버튼도 눌리지 않는다 — 그 사실이 보이는 게
    // 맞다(임의의 버튼을 눌린 것으로 표시하면 화면이 거짓말을 한다).
    button.setAttribute('aria-pressed', String(Number(button.dataset.ratio) === melodyRatio));
  }
}

async function selectMelodyLevel(ratio) {
  if (ratio !== melodyRatio) {
    melodyRatio = ratio;
    syncMelodyLevelPicker();
    dropSong();
    if (session) renderChips();
  }
  if (session) await play();
}

// 악기 버튼은 프리셋 테이블에서 만든다 — 악기를 추가하면 화면에 자동으로 나타나고
// 이름을 HTML과 JS 두 곳에 적지 않는다.
function buildInstrumentPicker() {
  el('instruments').append(
    ...Object.entries(INSTRUMENTS).map(([name, preset]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = preset.label;
      button.dataset.inst = name;
      button.addEventListener('click', guarded(() => selectInstrument(name), '악기를 바꾸지 못했어요.'));
      return button;
    }),
  );
  syncInstrumentPicker();
}

function syncInstrumentPicker() {
  for (const button of el('instruments').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.inst === instrument));
  }
}

// 악기만 바꾸고 **멜로디는 그대로 둔다** — refreshMelody를 부르면 곡이 새로 작곡돼
// 같은 곡으로 악기를 비교할 수 없다. 버릴 것은 렌더 결과(WAV)뿐이다.
async function selectInstrument(name) {
  if (name !== instrument) {
    instrument = name;
    syncInstrumentPicker();
    dropSong();
    if (session) renderChips();
  }
  if (session) await play();
}

// 다음 녹음을 기존 목소리 뒤에 이어붙일지. 결과 화면의 "이어서 녹음"이 켜고
// finishSession이 소비한다 — 녹음 화면은 두 경우가 완전히 같아서(같은 카운트다운, 같은
// 자동 정지) 화면을 나누지 않는다.
let appendNext = false;

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
  // 이어붙이기: 기존 목소리 뒤에 무음을 두고 새 녹음을 잇는다. **전체를 다시 분석한다** —
  // 조각 경계를 오프셋만 옮겨 합치면 이음매의 음절이 두 규칙(예전 분석/새 분석)으로
  // 갈라지고, 슬라이서의 임계값이 최대 프레임 기준이라 붙인 뒤의 값이 달라진다.
  const prev = appendNext && session ? session : null;
  appendNext = false;
  let buffer = recording.audioBuffer;
  let transcript = recording.transcript;
  if (prev) {
    const sr = prev.audioBuffer.sampleRate;
    const joined = joinSamples(
      [prev.audioBuffer.getChannelData(0), recording.audioBuffer.getChannelData(0)],
      sr,
    );
    if (joined.length / sr > MAX_TOTAL_SEC) {
      setNotice(`노래가 ${MAX_TOTAL_SEC}초를 넘어요. 저장한 뒤 새로 시작해 주세요.`);
      showResult();
      return;
    }
    buffer = makeBuffer(joined, sr);
    transcript = [prev.transcript, recording.transcript].filter(Boolean).join(' ');
  }

  const analyzed = analyze(buffer, transcript);
  if (!analyzed) {
    setNotice('소리가 너무 작아요. 조금 더 크게 말해 주세요.');
    // 이어붙이기가 실패해도 앞서 만든 노래는 남긴다 — 처음 녹음일 때만 첫 화면으로
    if (session) showResult();
    else show('idle');
    return;
  }
  session = analyzed;
  // 이어 녹음할 때는 시드를 유지한다 — 같은 시드면 앞부분 멜로디가 그대로라 곡이
  // 길어지는 것으로 들린다. 시드까지 바뀌면 매번 다른 노래가 된다.
  if (!prev) seed = 1;
  refreshMelody();
  showResult();
  play().catch(() => setNotice('노래를 틀지 못했어요. 다시 듣기를 눌러 주세요.'));
}

// 샘플 배열을 AudioBuffer로. 버퍼를 만들 뿐이라 오프라인 컨텍스트로 충분하다.
function makeBuffer(samples, sampleRate) {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

function loadDevSample(glideCents) {
  // 버퍼를 만들 뿐이라 오프라인 컨텍스트로 충분하다. 라이브 AudioContext를
  // 열면 사용자 제스처 없는 로드 시점이라 자동재생 정책 경고가 뜬다.
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const samples = makeDevSample(ctx.sampleRate, { glideCents });
  const audioBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  audioBuffer.copyToChannel(samples, 0);
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

buildInstrumentPicker();
buildMelodyLevelPicker();

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
// 이어서 녹음: 세션을 **버리지 않고** 다음 녹음을 뒤에 붙인다. "다시 녹음"과 다른
// 점은 그것뿐이라 녹음 화면·카운트다운·자동 정지를 그대로 쓴다.
el('append').addEventListener('click', () => {
  stopPlayback();
  setNotice('');
  appendNext = true;
  startSession();
});

el('again').addEventListener('click', () => {
  stopPlayback();
  dropSong();
  session = null;
  appendNext = false; // 이어붙이기를 눌렀다가 다시 녹음으로 왔을 때 남지 않게
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

const devMode = urlParams.get('dev');
if (devMode === 'sample') {
  loadDevSample(0);
} else if (devMode === 'glide') {
  loadDevSample(400); // 음절 안에서 4반음 활강 — 실제 말소리에 가깝다
} else {
  drawBeads(null);
  show('idle');
}
