#!/usr/bin/env python3
# services/noise_detector.py — Clipora V9.5.0
# ============================================================
# Deteksi noise non-bicara: batuk, klik, keyboard, notifikasi,
# klakson, thud, napas — berbasis analisis spektral multi-fitur.
#
# Pendekatan:
#   1. Energy "excess" terhadap baseline (median filter)
#   2. Spectral Flatness  → noise = flat, speech = harmonic peak
#   3. Harmonic-to-Noise Ratio (autocorrelation peak)
#   4. Zero-Crossing Rate
#   5. Spectral Centroid  (untuk klasifikasi tipe noise)
#
# Return: list of { start, end, reason, noise_type, confidence }
# ============================================================

import os
import sys
import time
import shutil
import tempfile
import subprocess
import numpy as np

try:
    from scipy.io import wavfile
    from scipy.signal import resample as _scipy_resample
    from scipy.ndimage import median_filter as _median_filter
    from scipy.ndimage import binary_dilation
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    wavfile = None


# ============================================================
# THRESHOLD PROFILES per aggressiveness
# ============================================================
# energy_excess_db: seberapa besar spike energi di atas baseline
# flatness        : > threshold = broadband (noise)
# hnr             : < threshold = aperiodic (noise)
# min_duration    : durasi minimum event (detik)
# max_duration    : durasi maksimum event (detik)
NOISE_PROFILES = {
    "gentle": {
        "energy_excess_db": 8.0,
        "flatness": 0.50,
        "hnr": 0.15,
        "min_duration": 0.08,
        "max_duration": 1.8,
    },
    "balanced": {
        "energy_excess_db": 5.5,
        "flatness": 0.35,
        "hnr": 0.20,
        "min_duration": 0.5,
        "max_duration": 2.2,
    },
    "content": {  # aggressive (default content creator)
        "energy_excess_db": 4.0,
        "flatness": 0.25,
        "hnr": 0.25,
        "min_duration": 0.04,
        "max_duration": 2.5,
    },
}

# Minimum confidence untuk dianggap noise valid
# Event dengan confidence di bawah ini akan dibuang
MIN_CONFIDENCE = float(os.getenv("NOISE_MIN_CONFIDENCE", "0.25"))

# Config umum
FRAME_MS = int(os.getenv("NOISE_FRAME_MS", "25"))
HOP_MS = int(os.getenv("NOISE_HOP_MS", "10"))
MERGE_GAP_SEC = float(os.getenv("NOISE_MERGE_GAP", "0.08"))   # ⬅️ dari 0.20 → 0.08
PADDING_SEC = float(os.getenv("NOISE_PADDING", "0.05"))
BASELINE_WIN_MS = int(os.getenv("NOISE_BASELINE_WIN_MS", "500"))


# ============================================================
# UTIL
# ============================================================
def _find_ffmpeg():
    """Cari FFmpeg dari env, PATH, atau default Windows."""
    # 1. Dari env var
    ffmpeg = os.getenv("FFMPEG_PATH")
    if ffmpeg and os.path.exists(ffmpeg):
        return ffmpeg

    # 2. Dari PATH
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg

    # 3. Default Windows
    if os.name == "nt":
        win_path = "C:\\ffmpeg\\bin\\ffmpeg.exe"
        if os.path.exists(win_path):
            return win_path

    return None


def _extract_audio_to_wav(input_path, wav_path):
    """Extract audio dari video → WAV 16kHz mono via FFmpeg."""
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        print("[NoiseDetect] FFmpeg tidak ditemukan", file=sys.stderr)
        return False

    try:
        cmd = [
            ffmpeg, "-y",
            "-i", str(input_path),
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            str(wav_path),
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            err_snip = (result.stderr or "")[-300:]
            print(f"[NoiseDetect] FFmpeg extract gagal: {err_snip}", file=sys.stderr)
            return False
        return os.path.exists(wav_path) and os.path.getsize(wav_path) > 1000
    except Exception as e:
        print(f"[NoiseDetect] Extract exception: {e}", file=sys.stderr)
        return False


def _read_wav(audio_path):
    """Baca audio (WAV). Auto-extract via FFmpeg kalau input bukan WAV."""
    if not HAS_SCIPY:
        print("[NoiseDetect] scipy tidak tersedia", file=sys.stderr)
        return None, None

    audio_path = str(audio_path)
    temp_wav = None
    actual_path = audio_path

    # Cek header file — RIFF/RIFX/RF64 = WAV asli
    try:
        with open(audio_path, "rb") as f:
            header = f.read(12)
        is_wav = header[:4] in (b"RIFF", b"RIFX", b"RF64")
    except Exception as e:
        print(f"[NoiseDetect] Gagal baca header: {e}", file=sys.stderr)
        return None, None

    # Kalau bukan WAV → auto-extract via FFmpeg
    if not is_wav:
        print("[NoiseDetect] Input bukan WAV — extract audio via FFmpeg...", file=sys.stderr)
        temp_dir = tempfile.gettempdir()
        temp_wav = os.path.join(
            temp_dir,
            f"noise_extract_{os.getpid()}_{int(time.time())}.wav"
        )
        if not _extract_audio_to_wav(audio_path, temp_wav):
            print("[NoiseDetect] Extraction gagal", file=sys.stderr)
            return None, None
        actual_path = temp_wav
        size_kb = os.path.getsize(temp_wav) / 1024
        print(f"[NoiseDetect] ✅ Audio extracted: {size_kb:.1f} KB", file=sys.stderr)

    # Baca WAV
    try:
        sr, data = wavfile.read(actual_path)

        # Convert ke float32
        if data.dtype == np.int16:
            data = data.astype(np.float32) / 32768.0
        elif data.dtype == np.int32:
            data = data.astype(np.float32) / 2147483648.0
        else:
            data = data.astype(np.float32)

        # Stereo → mono
        if data.ndim > 1:
            data = data.mean(axis=1)

        return sr, data

    except Exception as e:
        print(f"[NoiseDetect] Gagal baca WAV: {e}", file=sys.stderr)
        return None, None

    finally:
        # Cleanup temp file
        if temp_wav and os.path.exists(temp_wav):
            try:
                os.unlink(temp_wav)
            except Exception:
                pass


def _frame_signal(signal, frame_len, hop_len):
    n_frames = 1 + (len(signal) - frame_len) // hop_len
    if n_frames <= 0:
        return np.zeros((0, frame_len), dtype=np.float32)
    idx = np.arange(frame_len)[None, :] + hop_len * np.arange(n_frames)[:, None]
    return signal[idx]


def _rms_db(frames, eps=1e-10):
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + eps)
    return 20.0 * np.log10(rms + eps)


def _zcr(frames):
    signs = np.sign(frames)
    return np.mean(np.abs(np.diff(signs, axis=1)) / 2.0, axis=1)


def _spectral_flatness(frames, eps=1e-10):
    window = np.hanning(frames.shape[1])[None, :]
    spec = np.abs(np.fft.rfft(frames * window, axis=1)) ** 2 + eps
    spec = spec[:, 1:]  # buang DC
    geo = np.exp(np.mean(np.log(spec), axis=1))
    arith = np.mean(spec, axis=1)
    return geo / (arith + eps)


def _spectral_centroid(frames, sr, eps=1e-10):
    window = np.hanning(frames.shape[1])[None, :]
    spec = np.abs(np.fft.rfft(frames * window, axis=1))
    freqs = np.fft.rfftfreq(frames.shape[1], 1.0 / sr)
    num = np.sum(spec * freqs[None, :], axis=1)
    den = np.sum(spec, axis=1) + eps
    return num / den


def _hnr(frames, sr):
    """Harmonic-to-Noise Ratio approx via autocorrelation peak."""
    n = frames.shape[1]
    x = frames - frames.mean(axis=1, keepdims=True)
    fft_size = 1 << int(np.ceil(np.log2(2 * n)))
    X = np.fft.rfft(x, n=fft_size, axis=1)
    acf = np.fft.irfft(np.abs(X) ** 2, n=fft_size, axis=1)[:, :n]
    acf_norm = acf / (acf[:, 0:1] + 1e-10)
    min_lag = max(2, int(0.002 * sr))
    if acf_norm.shape[1] <= min_lag:
        return np.zeros(acf_norm.shape[0])
    peaks = np.max(acf_norm[:, min_lag:], axis=1)
    return np.clip(peaks, 0.0, 1.0)


def _classify_noise_type(flatness, zcr, hnr, centroid):
    """
    Klasifikasi tipe noise dari fitur spektral.
    Lebih permisif — hindari 'unknown' berlebihan.
    """
    f = float(np.mean(flatness)) if len(flatness) else 0.0
    z = float(np.mean(zcr)) if len(zcr) else 0.0
    h = float(np.mean(hnr)) if len(hnr) else 0.0
    c = float(np.mean(centroid)) if len(centroid) else 0.0

    # 1. CLICK: transient tinggi + centroid tinggi (keyboard, mouse, tutup pintu)
    if z > 0.30 and c > 3500:
        return "click"

    # 2. THUD: energi rendah-mid + HNR sangat rendah (batuk, hentakan, benda jatuh)
    if h < 0.15 and c < 2500:
        return "thud"

    # 3. HISSS: broadband tinggi (desis, napas, angin)
    if f > 0.45 and h < 0.25:
        return "hiss"

    # 4. BROADBAND: noise flat (klakson, siren, mesin)
    if f > 0.35:
        return "broadband"

    # 5. PLOSIVE: transient pendek dengan ZCR sedang (P, B, T, D tidak wajar)
    if z > 0.20 and c < 3000 and h < 0.40:
        return "plosive"

    # 6. UNKNOWN (fallback) — tapi coba klasifikasi longgar
    if h < 0.35:
        return "aperiodic"  # aperiodik — bukan speech normal

    return "unknown"


# ============================================================
# MAIN DETECTOR
# ============================================================
def detect_noise_events(audio_path, aggressiveness="content", sr_target=16000):
    """
    Deteksi noise non-bicara.

    Returns list of dict:
      { start, end, reason='noise', noise_type, confidence }
    """
    if not HAS_SCIPY:
        return []

    profile = NOISE_PROFILES.get(aggressiveness, NOISE_PROFILES["content"])

    sr, signal = _read_wav(audio_path)
    if sr is None or len(signal) < sr // 2:
        return []

    # Resample ke 16k
    if sr != sr_target:
        try:
            n = int(len(signal) * sr_target / sr)
            signal = _scipy_resample(signal, n).astype(np.float32)
            sr = sr_target
        except Exception:
            pass

    frame_len = int(sr * FRAME_MS / 1000)
    hop_len = int(sr * HOP_MS / 1000)
    frames = _frame_signal(signal, frame_len, hop_len)
    n_frames = frames.shape[0]
    if n_frames < 20:
        print("[NoiseDetect] Audio terlalu pendek", file=sys.stderr)
        return []

    # === Hitung fitur per frame ===
    rms_db = _rms_db(frames)
    zcr = _zcr(frames)
    flatness = _spectral_flatness(frames)
    centroid = _spectral_centroid(frames, sr)
    hnr = _hnr(frames, sr)

    # === Baseline energi via median filter ===
    win_frames = max(5, int(BASELINE_WIN_MS / HOP_MS))
    if win_frames % 2 == 0:
        win_frames += 1
    baseline_db = _median_filter(rms_db, size=win_frames, mode="nearest")
    excess_db = rms_db - baseline_db

    # === Filter frame kandidat noise ===
    # 1. Energi spike di atas baseline
    loud = excess_db > profile["energy_excess_db"]
    # 2. Bukan speech (broadband ATAU aperiodic)
    non_speech = (flatness > profile["flatness"]) | (hnr < profile["hnr"])
    # 3. Tidak sangat pelan (bukan silence residual)
    audible = rms_db > (np.median(rms_db) - 12.0)

    is_noise = loud & non_speech & audible

    # ⭐ V9.5.1: Dilation — gabungkan frame noise yang tersebar
    # Frame noise sering tersebar (1-2 frame per event di 10ms hop),
    # dilation melebarkan ±50ms supaya kelompok frame terbentuk.
    n_before_dilate = int(np.sum(is_noise))
    dilate_frames = max(2, int(0.05 / (HOP_MS / 1000.0)))  # 50ms window
    structure = np.ones(dilate_frames, dtype=bool)
    is_noise = binary_dilation(is_noise, structure=structure)
    n_after_dilate = int(np.sum(is_noise))
    print(
        f"[NoiseDetect] Dilation: {n_before_dilate} → {n_after_dilate} frame "
        f"(+{n_after_dilate - n_before_dilate}, window={dilate_frames} frames)",
        file=sys.stderr,
    )

        # === DEBUG: statistik frame ===
    if os.getenv("NOISE_DEBUG", "false").lower() == "true":
        print(f"[NoiseDetect-DEBUG] === Statistik Frame ===", file=sys.stderr)
        print(f"[NoiseDetect-DEBUG] Total frames: {n_frames}", file=sys.stderr)
        print(f"[NoiseDetect-DEBUG] RMS median: {np.median(rms_db):.1f} dB, "
              f"max: {np.max(rms_db):.1f} dB, min: {np.min(rms_db):.1f} dB", file=sys.stderr)
        print(f"[NoiseDetect-DEBUG] Excess median: {np.median(excess_db):.1f} dB, "
              f"max: {np.max(excess_db):.1f} dB", file=sys.stderr)
        print(f"[NoiseDetect-DEBUG] Flatness median: {np.median(flatness):.3f}, "
              f"max: {np.max(flatness):.3f}", file=sys.stderr)
        print(f"[NoiseDetect-DEBUG] HNR median: {np.median(hnr):.3f}, "
              f"min: {np.min(hnr):.3f}", file=sys.stderr)
        print(f"[NoiseDetect-DEBUG] Threshold (content): "
              f"excess>{profile['energy_excess_db']}dB, "
              f"flat>{profile['flatness']}, "
              f"hnr<{profile['hnr']}", file=sys.stderr)
        print(f"[NoiseDetect-DEBUG] Frame lolos filter:", file=sys.stderr)
        print(f"  • loud (excess OK): {int(np.sum(loud))}/{n_frames}", file=sys.stderr)
        print(f"  • non_speech: {int(np.sum(non_speech))}/{n_frames}", file=sys.stderr)
        print(f"  • audible: {int(np.sum(audible))}/{n_frames}", file=sys.stderr)
        print(f"  • ALL 3 combined: {int(np.sum(is_noise))}/{n_frames}", file=sys.stderr)

    # === Grouping ===
    segments = []
    i = 0
    min_dur = profile["min_duration"]
    max_dur = profile["max_duration"]
    while i < n_frames:
        if not is_noise[i]:
            i += 1
            continue
        j = i
        while j < n_frames and is_noise[j]:
            j += 1
        # frame i..j-1 = event
        dur = (j - i) * HOP_MS / 1000.0
        if min_dur <= dur <= max_dur:
            start_t = i * hop_len / sr
            end_t = j * hop_len / sr
            # Confidence: seberapa jauh di atas threshold
            excess_mean = float(np.mean(excess_db[i:j]))
            conf = min(1.0, excess_mean / 15.0)  # 15dB = confident

            # ⭐ Filter confidence minimum — buang event yang terlalu lemah
            if conf < MIN_CONFIDENCE:
                i = j
                continue

            ntype = _classify_noise_type(
                flatness[i:j], zcr[i:j], hnr[i:j], centroid[i:j]
            )
            segments.append({
                "start": max(0.0, start_t - PADDING_SEC),
                "end": end_t + PADDING_SEC,
                "reason": f"noise:{ntype}",
                "noise_type": ntype,
                "confidence": round(conf, 2),
            })
        i = j


        # === Merge event berdekatan ===
    if segments:
        segments.sort(key=lambda x: x["start"])
        merged = [segments[0]]
        for s in segments[1:]:
            gap = s["start"] - merged[-1]["end"]
            if gap < MERGE_GAP_SEC:
                merged[-1]["end"] = max(merged[-1]["end"], s["end"])
                merged[-1]["confidence"] = max(
                    merged[-1]["confidence"], s["confidence"]
                )
            else:
                merged.append(s)
        segments = merged

    # ⭐ V9.5.2: Split segment yang masih terlalu panjang setelah merge
    # Noise realistis tidak pernah > 1.5s. Kalau hasil merge > max_hard_limit,
    # pecah jadi beberapa bagian dengan durasi wajar.
    MAX_HARD_DURATION = min(1.5, profile["max_duration"])
    final_segments = []
    for s in segments:
        dur = s["end"] - s["start"]
        if dur <= MAX_HARD_DURATION:
            final_segments.append(s)
        else:
            # Split jadi N bagian rata
            n_parts = int(np.ceil(dur / MAX_HARD_DURATION))
            part_dur = dur / n_parts
            for k in range(n_parts):
                new_start = s["start"] + k * part_dur
                new_end = new_start + part_dur
                final_segments.append({
                    "start": round(new_start, 3),
                    "end": round(min(new_end, s["end"]), 3),
                    "reason": s["reason"],
                    "noise_type": s["noise_type"],
                    "confidence": round(s["confidence"] * 0.85, 2),  # sedikit turun
                    "split": True,
                })
    segments = final_segments
    print(
        f"[NoiseDetect] Post-split: {len(segments)} segmen "
        f"(max_hard={MAX_HARD_DURATION}s)",
        file=sys.stderr,
    )

    print(
        f"[NoiseDetect] {len(segments)} event terdeteksi "
        f"(profile={aggressiveness}, min_conf>=0.0)",
        file=sys.stderr,
    )
    for s in segments[:8]:
        print(
            f"    • {s['noise_type']:10s} "
            f"@ {s['start']:6.2f}s→{s['end']:6.2f}s "
            f"(conf={s['confidence']})",
            file=sys.stderr,
        )
    if len(segments) > 8:
        print(f"    ... dan {len(segments) - 8} lainnya", file=sys.stderr)

    return segments