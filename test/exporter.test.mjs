import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../src/exporter.js';

const SR = 44100;

async function parse(blob) {
  const view = new DataView(await blob.arrayBuffer());
  const str = (off, len) =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(off + i)));
  return {
    view,
    riff: str(0, 4),
    wave: str(8, 4),
    fmt: str(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: str(36, 4),
    dataSize: view.getUint32(40, true),
    chunkSize: view.getUint32(4, true),
  };
}

test('모노 WAV 헤더가 올바르다', async () => {
  const blob = encodeWav([new Float32Array(100)], SR);
  const h = await parse(blob);
  assert.equal(h.riff, 'RIFF');
  assert.equal(h.wave, 'WAVE');
  assert.equal(h.fmt, 'fmt ');
  assert.equal(h.audioFormat, 1);
  assert.equal(h.channels, 1);
  assert.equal(h.sampleRate, SR);
  assert.equal(h.bitsPerSample, 16);
  assert.equal(h.blockAlign, 2);
  assert.equal(h.byteRate, SR * 2);
  assert.equal(h.data, 'data');
  assert.equal(h.dataSize, 200);
  assert.equal(h.chunkSize, blob.size - 8);
  assert.equal(blob.size, 44 + 200);
  assert.equal(blob.type, 'audio/wav');
});

test('스테레오는 채널을 인터리브한다', async () => {
  const left = Float32Array.from([1, 0]);
  const right = Float32Array.from([-1, 0]);
  const h = await parse(encodeWav([left, right], SR));
  assert.equal(h.channels, 2);
  assert.equal(h.blockAlign, 4);
  assert.equal(h.dataSize, 2 * 2 * 2);
  assert.equal(h.view.getInt16(44, true), 32767); // L[0]
  assert.equal(h.view.getInt16(46, true), -32768); // R[0]
});

test('±1을 넘는 값은 클리핑한다', async () => {
  const h = await parse(encodeWav([Float32Array.from([2.5, -2.5])], SR));
  assert.equal(h.view.getInt16(44, true), 32767);
  assert.equal(h.view.getInt16(46, true), -32768);
});

test('빈 채널 배열은 예외', () => {
  assert.throws(() => encodeWav([], SR), RangeError);
});
