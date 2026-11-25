/**
 * Audio conversions between the app's own formats and a phone line.
 * Phone calls carry G.711 mu-law at 8 kHz; the app's voices produce PCM 16-bit
 * at 24 kHz (what the avatar faces expect), so speech is filtered and
 * downsampled by 3 before it goes down the line.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** One 16-bit PCM sample to one mu-law byte (ITU-T G.711). */
export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One mu-law byte to one 16-bit PCM sample. */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

/** Low-pass taps for 24 kHz audio, cut off near 3.4 kHz (the phone band), windowed sinc. */
const TAPS = (() => {
  const n = 31;
  const cutoff = 3400 / 24000;
  const taps: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = i - (n - 1) / 2;
    const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    taps.push(sinc * hamming);
  }
  const sum = taps.reduce((a, b) => a + b, 0);
  return taps.map((t) => t / sum);
})();

/** PCM 16-bit little-endian 24 kHz mono, as the voices return it, to mu-law 8 kHz for the phone line. */
export function pcm24kToMulaw8k(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const read = (i: number) => (i < 0 || i >= samples ? 0 : pcm.readInt16LE(i * 2));
  const half = (TAPS.length - 1) / 2;
  const out = Buffer.alloc(Math.floor(samples / 3));
  for (let o = 0; o < out.length; o++) {
    const center = o * 3;
    let acc = 0;
    for (let t = 0; t < TAPS.length; t++) acc += TAPS[t] * read(center + t - half);
    out[o] = linearToMulaw(acc);
  }
  return out;
}

/** Splits audio into 20 ms phone frames (160 bytes of mu-law at 8 kHz). */
export function frames(mulaw: Buffer, bytes = 160): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < mulaw.length; i += bytes) out.push(mulaw.subarray(i, i + bytes));
  return out;
}
