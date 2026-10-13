"""Packs tools/voice/<ID>.wav (16 kHz 16-bit mono, from make-voice.ps1) into src/voice_data.h, in the
order of lib/speech/src/clips.h.

Each clip is shaped for a small speaker before packing (2026-10-12, the 8 ohm 0.5 W speaker sounded quiet
and muffled with the raw Windows voice, which peaks around -4 dBFS but averages about -22 dBFS):
  1. silence at the start and end trimmed, so numbers run together ("twenty four grams");
  2. a 4th-order high-pass at 280 Hz: a small speaker can't play the bass, which only uses up headroom
     and makes the cone rattle;
  3. +5 dB around 3 kHz, where consonants live (clarity);
  4. a look-ahead compressor (5:1 above -20 dB), then every clip raised until its 99th-percentile
     sample is at 80 % of full scale, the rarest peaks rounded off by a soft limiter: speech is about
     9 dB louder on average (RMS -20.7 -> -12.0 dBFS) and all the words are equally loud;
  5. 5 ms fades, then 8-bit G.711 mu-law (cleaner than the 4-bit ADPCM used up to fw 0.1.4).

    py tools/pack-voice.py
"""
import math
import pathlib
import re
import struct
import sys
import wave

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLIPS = ROOT / "lib" / "speech" / "src" / "clips.h"
VOICE = ROOT / "tools" / "voice"
OUT = ROOT / "src" / "voice_data.h"
RATE = 16000

PEAK = 0.94            # the loudest any sample gets, of full scale
LEVEL = 0.80           # where each clip's 99th-percentile sample lands
KNEE = 0.70            # the soft limiter starts here
THRESHOLD = 10 ** (-20 / 20)
RATIO = 5.0
LOOKAHEAD = 48         # 3 ms
ATTACK = math.exp(-1 / (0.001 * RATE))
RELEASE = math.exp(-1 / (0.060 * RATE))


def trim(samples, threshold=350, pad=400):
    loud = [i for i, s in enumerate(samples) if abs(s) > threshold]
    if not loud:
        return samples[:1600]
    return samples[max(0, loud[0] - pad): min(len(samples), loud[-1] + pad)]


def biquad(x, b0, b1, b2, a0, a1, a2):
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    y = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, v in enumerate(x):
        o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, v, y1, o
        y[i] = o
    return y


def highpass(x, f0, q):
    w = 2 * math.pi * f0 / RATE
    c, alpha = math.cos(w), math.sin(w) / (2 * q)
    return biquad(x, (1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha)


def peaking(x, f0, q, db):
    w = 2 * math.pi * f0 / RATE
    c, alpha, a = math.cos(w), math.sin(w) / (2 * q), 10 ** (db / 40)
    return biquad(x, 1 + alpha * a, -2 * c, 1 - alpha * a, 1 + alpha / a, -2 * c, 1 - alpha / a)


def normalise(x, peak):
    m = max((abs(v) for v in x), default=0.0) or 1.0
    return [v * peak / m for v in x]


def compress(x):
    """Gain follows a peak envelope taken LOOKAHEAD samples early, so it is down before a peak arrives."""
    env, out = 0.0, []
    padded = x + [0.0] * LOOKAHEAD
    for i in range(len(x)):
        a = abs(padded[i + LOOKAHEAD])
        env = a + (env - a) * (ATTACK if a > env else RELEASE)
        g = 1.0 if env <= THRESHOLD else (THRESHOLD / env) ** (1 - 1 / RATIO)
        out.append(x[i] * g)
    return out


def louden(x):
    """Raise the clip until its 99th-percentile sample is at LEVEL; round peaks above KNEE off to PEAK."""
    a = sorted(abs(v) for v in x)
    p99 = a[int(len(a) * 0.99)] if a else 0.0
    g = LEVEL / p99 if p99 > 0 else 1.0
    room = PEAK - KNEE
    out = []
    for v in x:
        v *= g
        m = abs(v)
        if m > KNEE:
            m = KNEE + room * math.tanh((m - KNEE) / room)
            v = m if v > 0 else -m
        out.append(v)
    return out


def fade(x, n=80):
    n = min(n, len(x) // 2)
    for i in range(n):
        x[i] *= i / n
        x[-1 - i] *= i / n
    return x


def shape(samples):
    x = [s / 32768 for s in samples]
    x = highpass(highpass(x, 280, 0.5412), 280, 1.3066)  # 4th-order Butterworth
    x = peaking(x, 3000, 0.9, 5.0)
    x = compress(normalise(x, 1.0))
    x = fade(louden(x))
    return [max(-32767, min(32767, round(v * 32767))) for v in x]


BIAS, CLIP = 0x84, 32635


def ulaw(s):
    sign = 0x80 if s < 0 else 0
    s = min(-s if s < 0 else s, CLIP) + BIAS
    exponent = 7
    while exponent > 0 and not s & (0x4000 >> (7 - exponent)):
        exponent -= 1
    mantissa = (s >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF


def unulaw(u):
    u = ~u & 0xFF
    s = (((u & 0x0F) << 3) + BIAS) << ((u >> 4) & 7)
    return BIAS - s if u & 0x80 else s - BIAS


def dbfs(x):
    if not x:
        return -99.0
    rms = math.sqrt(sum(v * v for v in x) / len(x)) / 32768
    return 20 * math.log10(rms) if rms > 0 else -99.0


def main():
    # The decoder in src/audio.cpp is the textbook one; check this encoder against it.
    for s in (-32768, -20000, -1000, -1, 0, 1, 37, 1000, 20000, 32767):
        assert abs(unulaw(ulaw(s)) - max(-CLIP, min(CLIP, s))) <= max(16, abs(s) // 16), s

    ids = re.findall(r'CLIP\((\w+),\s*"[^"]*"\)', CLIPS.read_text(encoding="utf-8"))
    table, data, before, after = [], bytearray(), [], []
    for cid in ids:
        path = VOICE / f"{cid}.wav"
        if not path.exists():
            sys.exit(f"missing {path} - run tools/make-voice.ps1 first")
        with wave.open(str(path), "rb") as w:
            if w.getframerate() != RATE or w.getsampwidth() != 2 or w.getnchannels() != 1:
                sys.exit(f"{path}: must be 16 kHz 16-bit mono")
            raw = w.readframes(w.getnframes())
        samples = trim(list(struct.unpack(f"<{len(raw) // 2}h", raw)))
        shaped = shape(samples)
        before.append(dbfs(samples))
        after.append(dbfs(shaped))
        table.append((len(data), len(shaped), cid))
        data += bytes(ulaw(s) for s in shaped)
    lines = [
        "// Generated by tools/pack-voice.py from tools/voice/*.wav (make-voice.ps1). Do not edit.",
        "// G.711 mu-law, 16 kHz mono, 8 bits per sample; shaped for a small speaker (see the tool);",
        "// order = lib/speech/src/clips.h.",
        "#pragma once",
        "#include <stdint.h>",
        "",
        "struct VoiceClip {",
        "  uint32_t offset;",
        "  uint32_t samples;",
        "};",
        "",
        f"static const VoiceClip kVoiceClips[{len(table)}] = {{",
    ]
    for off, n, cid in table:
        lines.append(f"    {{{off}, {n}}},  // {cid}")
    lines.append("};")
    lines.append("")
    lines.append(f"static const uint8_t kVoiceData[{len(data)}] = {{")
    for i in range(0, len(data), 24):
        lines.append("    " + ", ".join(f"0x{b:02x}" for b in data[i: i + 24]) + ",")
    lines.append("};")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    secs = sum(n for _, n, _ in table) / RATE
    avg = lambda v: sum(v) / len(v)
    print(f"{len(table)} clips, {secs:.1f} s of speech, {len(data) / 1024:.0f} KB -> {OUT}")
    print(f"average loudness {avg(before):.1f} dBFS -> {avg(after):.1f} dBFS (RMS)")


if __name__ == "__main__":
    main()
