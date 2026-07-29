# melody_child — 목소리로 동요 만들기

작성일: 2026-07-29

## 목표

사용자가 마이크에 오늘 있었던 이야기를 말하면, 그 목소리 조각들을 그대로 써서 동요를 만들어 들려주고 WAV로 저장한다. 목소리는 합성하지 않고 **녹음된 실제 음성을 악기로 재사용**한다.

이야기가 길어도 잘라내지 않는다. 동요의 실제 구조 — **짧은 곡조를 절마다 반복** — 를 따라 8음 한 절을 만들고 음절 수만큼 절을 반복한다. 60음절을 말하면 8절짜리 노래가 된다.

백엔드 없음. 정적 파일만으로 동작하며 외부 유료 API를 쓰지 않는다.

## 비목표

- AI 음악 생성 API(Suno 등) 연동 — 유료이고 키를 숨길 서버가 필요하다
- 음절 경계 수동 보정 UI — 자동 분할로 시작하고, 품질이 부족하다고 판단될 때 별도 작업으로 다룬다
- 계정, 저장소, 공유 링크
- 모바일 전용 레이아웃 최적화 (동작은 해야 하지만 데스크톱 기준으로 만든다)

## 사용자 흐름

1. 큰 녹음 버튼을 누른다
2. 오늘 있었던 이야기를 말한다. 레벨 미터가 움직이고, 받아쓰기 텍스트가 실시간으로 뜬다. 30초가 되면 자동 정지
3. 결과 화면: 파형에 음절 경계선, 그 아래 받아쓰기 문장, 버튼 4개 — 재생 / 새 멜로디 / WAV 저장 / 다시 녹음
4. "새 멜로디"는 같은 목소리 조각으로 곡만 다시 생성한다 (재녹음 없음)

## 아키텍처

정적 단일 페이지. ES 모듈 7개.

```
녹음 ──> 음절 분할 ──> 음높이 추정 ──┐
                                  ├──> 연주(재생) ──> 스피커
              조각 개수 ──> 멜로디 생성 ┘
                                  └──> 오프라인 렌더 ──> WAV 인코딩 ──> 다운로드
```

| 모듈 | 책임 | 브라우저 의존 |
|---|---|---|
| `src/recorder.js` | 마이크 캡처, STT 병행, AudioBuffer 산출 | O |
| `src/slicer.js` | 파형 → 음절 조각 경계 | X (순수) |
| `src/pitch.js` | 조각 → 기본주파수 f0 | X (순수) |
| `src/composer.js` | 조각 개수 → 멜로디·화성 | X (순수) |
| `src/synth.js` | 조각+멜로디 → 오디오 그래프 구성, 재생·오프라인 렌더 | O |
| `src/exporter.js` | Float32 채널 → WAV Blob | X (순수) |
| `src/ui.js` | 상태 머신(idle/recording/result), DOM | O |

순수 모듈 4개는 브라우저 API를 모른다. `node --test`로 직접 검증한다.

## 모듈 인터페이스

```js
// recorder.js
isSpeechRecognitionSupported() -> boolean
startRecording({ maxMs, onLevel, onTranscript }) -> Promise<RecordingHandle>
//   RecordingHandle: { stop(): Promise<Recording> }
//   Recording: { audioBuffer: AudioBuffer, transcript: string }

// slicer.js
sliceSyllables(samples: Float32Array, sampleRate: number, opts?) -> Segment[]
//   Segment: { start: number, end: number }   // 샘플 인덱스
//   opts 기본값: { hopMs: 20, minSegMs: 80, minGapMs: 60, thresholdRatio: 0.2 }
//   임계값은 노이즈 플로어와 최대치 "사이"를 비율로 가른다 — 플로어에 배수를 곱하면
//   배경 잡음이 크거나 무음 구간이 없는 녹음에서 임계값이 최대치를 넘어 전부 미검출된다

// pitch.js
detectF0(samples: Float32Array, sampleRate: number, opts?) -> number | null
//   자기상관. 탐색 범위 70~1000Hz. null = 무성음 또는 검출 실패
//   opts 기본값: { minHz: 70, maxHz: 1000, minClarity: 0.3 }

// composer.js
composeMelody(noteCount: number, seed: number) -> Melody
//   Melody: { notes: Note[], bpm: number, tonicMidi: number, verseLen: number, verseCount: number }
//   Note: { midi: number, beats: number }
//   notes.length === noteCount 를 항상 보장한다 (절을 반복해 채우고 남으면 자른다)
chordsFor(melody: Melody) -> Chord[]
//   Chord: { rootMidi: number, semitones: number[], startBeat: number, beats: number }

// synth.js
buildGraph(ctx, { audioBuffer, segments, f0s, melody, chords }) -> { durationSec }
//   ctx는 AudioContext 또는 OfflineAudioContext — 동일하게 동작해야 한다
renderOffline({ audioBuffer, segments, f0s, melody, chords }) -> Promise<AudioBuffer>

// exporter.js
encodeWav(channels: Float32Array[], sampleRate: number) -> Blob
//   16bit PCM, RIFF 헤더 직접 작성
```

`buildGraph`가 컨텍스트를 인자로 받는 이유는 재생과 WAV 렌더가 **같은 코드로 같은 소리**를 내야 하기 때문이다. 렌더 경로를 따로 쓰면 두 결과가 갈라진다.

## 핵심 알고리즘 결정

### 음높이 정규화 (이 프로젝트의 성패)

조각을 목표 음정으로 그냥 올리면 멜로디로 들리지 않는다. 말할 때 음높이가 계속 요동치므로 조각마다 출발점이 다르기 때문이다. 따라서 조각별로 f0를 검출하고, 목표 주파수와의 비율로 재생 속도를 정한다.

```
rate = midiToHz(note.midi) / f0
```

f0가 `null`인 조각(무성 자음 등)은 `rate = 1.0`으로 원음을 그대로 쓴다. 음정은 없지만 리듬은 맞으므로 타악기처럼 들리고, 동요에서는 오히려 자연스럽다.

### 길이 보정

Web Audio 스펙은 `playbackRate`와 `detune`을 곱해 하나의 재생 속도로 합산한다. 즉 음을 올리면 조각이 짧아진다. 그래뉼러 합성 없이 처리한다.

- 음 길이보다 짧으면: 조각 후반의 안정 구간을 루프
- 길면: 끝에 5ms 페이드아웃을 걸고 자른다

품질이 부족하다고 **들어보고 판단되면** 그때 overlap-add 방식을 별도로 붙인다. 지금은 넣지 않는다.

### 멜로디 생성 — 절 반복

- 장5음계(으뜸음 기준 0, 2, 4, 7, 9 반음)만 사용 — 어떤 순서로 나열해도 불협이 나지 않는다
- **한 절 = 8음** (4음 프레이즈 A + 4음 프레이즈 B). 절은 **같은 곡조로 반복**된다 — 이게 동요의 실제 구조이며, 이야기가 길어도 곡이 산만해지지 않는 이유다
- 음절 수가 8의 배수가 아니면 마지막 절은 중간에서 끝난다. 가짜 음절을 채워 넣지 않는다
- 마지막 음은 반드시 으뜸음 (끝난 느낌)
- 박자는 4/4, BPM 96~120 사이에서 시드로 결정
- `seed`를 인자로 받으므로 테스트가 결정적이고, "새 멜로디" 버튼은 시드만 바꿔 호출한다

### 반주

화성은 I-V-vi-IV 진행. 삼각파 오실레이터로 패드를 깔고, 필터를 통과시킨 짧은 노이즈 버스트로 셰이커를 8분음표마다 넣는다. 목소리 조각보다 6dB 낮게 섞어 가사가 묻히지 않게 한다.

## 에러 처리

| 상황 | 처리 |
|---|---|
| 마이크 권한 거부 | 안내 문구 후 idle 복귀 |
| 조각 0개 (너무 조용) | "조금 더 크게 말해주세요" 후 idle 복귀 |
| 조각 8개 미만 | 한 절(8음)이 될 때까지 조각을 순환 반복 |
| 조각 개수 상한 | **없다.** 조각이 많으면 절이 늘어난다 |
| — | 위 정규화는 `ui.js`가 `composeMelody` 호출 **전에** 수행한다. 따라서 `synth.buildGraph`에 들어가는 시점에는 항상 `segments.length === melody.notes.length`이며, `synth`는 개수 불일치를 처리하지 않는다 |
| Chrome 음성인식이 도중에 멈춤 | `onend`에서 재시작한다. 30초 녹음 중 침묵이 길면 인식기가 스스로 종료하기 때문 |
| STT 미지원 (Firefox 등) | 가사 영역만 숨기고 음악 기능은 전부 정상 동작 |
| `decodeAudioData` 실패 | 안내 후 idle 복귀 |
| 모든 조각의 f0 검출 실패 | 전부 rate 1.0으로 리듬만 재생 (침묵하지 않는다) |

원칙: 어떤 실패도 화면을 멈추지 않고, 가능한 만큼 낮춰서 동작한다.

## 테스트 전략

`node --test`, 의존성 없음.

- `slicer` — 합성 신호(0.2초 톤 3개 + 무음)를 넣어 조각 3개가 검출되는지, 경계가 ±1홉 안인지
- `pitch` — 440Hz 사인파 → 오차 1% 이내. 백색소음 → `null`
- `composer` — 요청 음 개수와 결과 개수 일치, 모든 음이 5음계 소속, 마지막 음 = 으뜸음, 같은 시드 → 같은 결과
- `exporter` — RIFF/WAVE 헤더 바이트, 샘플 수, 클리핑 경계값(±1.0)

브라우저 경로는 자동 테스트가 불가능하다. 그래서 **내장 샘플 오디오로 전체 파이프라인을 돌리는 개발용 진입점**(`?dev=sample`)을 둔다. 마이크 없이 분할→피치→작곡→연주→WAV까지 검증할 수 있고, 콘솔 에러와 스크린샷으로 확인한다. 이 진입점이 없으면 "동작할 것"이라고 말할 수밖에 없다.

## 배포

ES 모듈을 쓰므로 `file://`로 열면 CORS로 모듈 로드부터 실패한다. 정적 서버가 필요하다 — 서버 **코드**는 0줄이다.

로컬:

```bash
cd /mnt/d/ws/study/melody_child && python3 -m http.server 8000
```

배포는 GitHub Pages (`https://github.com/wootaeng/melody_child`). HTTPS이므로 마이크와 음성인식 모두 동작한다.

브라우저 지원: Chrome·Edge·Safari 전 기능. Firefox는 가사 표시만 빠지고 나머지 동작.

## 리스크

1. **음높이 정규화 품질** — 가장 큰 미지수. 자기상관 f0 검출이 아이 목소리·잡음 환경에서 얼마나 안정적인지는 실제로 들어봐야 안다. 완화: `?dev=sample` 진입점으로 조기에 소리를 확인하고, 실패하면 무성음 폴백이 최소한 리듬은 지켜준다.
2. **음절 분할 정확도** — 연음("사랑해"가 한 덩어리로 붙는 경우)이 있으면 조각이 뭉친다. 완화: 뭉쳐도 곡은 성립한다(음이 적어질 뿐). 심각하면 수동 보정 UI를 별도 작업으로 추가한다.
3. **STT와 조각 수 불일치** — 받아쓰기 글자 수와 오디오 조각 수는 일치하지 않는다. 가사는 조각에 1:1로 매핑하지 않고 전체 문장으로만 표시한다.
