export interface Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  format: number; // 1 = PCM, 3 = IEEE float
  data: Buffer;
  duration: number; // seconds
}

/**
 * Strictly parses a RIFF/WAVE buffer: exactly one `fmt ` chunk followed by exactly one `data` chunk,
 * PCM16 or 32-bit float, 1-2 channels, 8-48 kHz. Returns null for anything else. The duration is
 * computed from the sample bytes actually present, never from header fields alone. With the 25 MB
 * upload limit the 8 kHz floor also bounds a request to about 27 minutes.
 */
export function parseWav(buf: Buffer): Wav | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt: Omit<Wav, 'data' | 'duration'> | null = null;
  let data: Buffer | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (fmt || data || size < 16 || body + size > buf.length) return null;
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt || data) return null;
      // Streaming writers may leave the size as 0 or 0xFFFFFFFF; clamp to what we actually have.
      if (size === 0 || body + size > buf.length) size = buf.length - body;
      data = buf.subarray(body, body + size);
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) return null;
  const { format, channels, sampleRate, bitsPerSample } = fmt;
  const encoding = (format === 1 && bitsPerSample === 16) || (format === 3 && bitsPerSample === 32);
  if (!encoding || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 48000) return null;
  const frameBytes = (channels * bitsPerSample) / 8;
  const frames = Math.floor(data.length / frameBytes);
  if (!frames) return null;
  return { ...fmt, data: data.subarray(0, frames * frameBytes), duration: frames / sampleRate };
}

/** Decodes PCM16/PCM32-float WAV into mono float samples in [-1, 1]. */
export function wavToMonoFloat(wav: Wav): Float32Array {
  const bytes = wav.bitsPerSample / 8;
  const frames = Math.floor(wav.data.length / (bytes * wav.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < wav.channels; ch++) {
      const o = (i * wav.channels + ch) * bytes;
      if (wav.format === 3 && bytes === 4) sum += wav.data.readFloatLE(o);
      else if (bytes === 2) sum += wav.data.readInt16LE(o) / 32768;
      else throw new Error(`unsupported WAV encoding (format ${wav.format}, ${wav.bitsPerSample} bit)`);
    }
    out[i] = sum / wav.channels;
  }
  return out;
}

/** Encodes mono float samples as a plain 44-byte-header PCM16 WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768) || 0)), 44 + i * 2);
  }
  return out;
}

/**
 * Validates an upload and rebuilds it as a canonical mono PCM16 WAV, so upstreams decode exactly
 * the samples whose duration we bill. Returns null when the audio is not a supported WAV.
 */
export function normalizeAudio(buf: Buffer): { wav: Buffer; duration: number } | null {
  const wav = parseWav(buf);
  return wav && { wav: encodeWav(wavToMonoFloat(wav), wav.sampleRate), duration: wav.duration };
}

export const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;
