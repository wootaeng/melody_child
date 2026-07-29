// Float32 채널들을 16bit PCM WAV Blob으로 인코딩한다.

export function encodeWav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new RangeError('channels는 비어 있을 수 없다');
  }
  const numCh = channels.length;
  const frames = channels[0].length;
  // 길이가 다르면 짧은 채널에서 undefined를 읽어 조용히 0으로 기록된다.
  for (let c = 1; c < numCh; c++) {
    if (channels[c].length !== frames) {
      throw new RangeError(`채널 길이가 다르다: ${frames} vs ${channels[c].length}`);
    }
  }
  const dataSize = frames * numCh * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 청크 크기
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const clamped = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
