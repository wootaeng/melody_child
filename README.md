# melody_child

오늘 있었던 이야기를 말하면, 그 목소리를 음절 단위로 잘라 각 조각을 멜로디 음정으로 옮겨 동요를 만드는 정적 웹페이지.
목소리를 합성하지 않고 실제 녹음을 악기로 재사용한다. 외부 API·백엔드·의존성 없음.

8음 한 절을 만들고 음절 수만큼 절을 반복한다 — 동요가 원래 같은 곡조를 절마다 반복하는 구조라서,
이야기가 길어져도 곡이 산만해지지 않는다. 녹음은 30초까지.

## 실행

ES 모듈을 쓰기 때문에 `file://`로 열면 동작하지 않는다. 정적 서버로 띄운다.

```bash
python3 -m http.server 8000
```

- 앱: http://localhost:8000/
- 마이크 없이 파이프라인 확인: http://localhost:8000/index.html?dev=sample
- 모듈별 로그가 필요할 때: http://localhost:8000/dev.html

## 테스트

```bash
node --test
```

순수 모듈(`devsample`·`slicer`·`pitch`·`composer`·`exporter`)만 자동 테스트한다.
브라우저에 묶인 `recorder`·`synth`·`ui`는 위 개발 경로로 확인한다.

## 브라우저 지원

Chrome·Edge·Safari에서 전 기능. Firefox는 Web Speech API를 지원하지 않아 가사 표시만 빠지고 노래는 정상 동작한다.

## 배포

GitHub Pages 등 정적 호스팅에 그대로 올리면 된다. 서버 코드는 없다.
HTTPS가 필요하다 — 마이크와 음성인식 모두 보안 컨텍스트를 요구한다.
