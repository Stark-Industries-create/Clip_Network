"""Label who speaks each timed cue in one recording span.

Usage: diarize.py <media> <cues.json> [threshold]

Prints a JSON list with one entry per input cue: a speaker label such as "S0", or null when the cue is
too short to judge. Labels are only comparable inside one call.

The voice embedding is deliberately simple (MFCC mean and spread after mean/variance normalization)
and needs only NumPy, which OpenCV already installs. It separates distinct voices in two-person
interviews and streams. It is not a replacement for a neural diarizer on large panels or heavy crosstalk.
"""
import json
import subprocess
import sys

import numpy as np

RATE = 16000
FRAME = 400  # 25 ms
HOP = 160  # 10 ms
MEL_BANDS = 40
CEPSTRA = 20
MIN_SECONDS = 0.6
# Only cues this long define voices. Shorter fragments are too noisy to seed a cluster, so they are
# attached to the nearest voice afterwards (or left unlabelled).
ANCHOR_SECONDS = 1.5
MAX_SPEAKERS = 6
# Uncentred cosine distance below which two clusters are one voice. Measured on two-voice and
# one-voice recordings: one voice stayed under 0.17 and two voices stayed above 0.21.
SAME_VOICE = 0.18


def load_audio(media):
    pcm = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", media, "-vn", "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-",
    ], timeout=120)
    return np.frombuffer(pcm, dtype=np.float32)


def mel_filterbank():
    def hz_to_mel(hz):
        return 2595 * np.log10(1 + hz / 700)

    def mel_to_hz(mel):
        return 700 * (10 ** (mel / 2595) - 1)

    bins = FRAME // 2 + 1
    points = mel_to_hz(np.linspace(hz_to_mel(60), hz_to_mel(7600), MEL_BANDS + 2))
    indices = np.floor((FRAME + 1) * points / RATE).astype(int)
    bank = np.zeros((MEL_BANDS, bins))
    for band in range(1, MEL_BANDS + 1):
        left, center, right = indices[band - 1], indices[band], indices[band + 1]
        for k in range(left, center):
            bank[band - 1, k] = (k - left) / max(1, center - left)
        for k in range(center, right):
            bank[band - 1, k] = (right - k) / max(1, right - center)
    return bank


def mfcc(samples, bank, dct):
    if samples.size < FRAME:
        return np.zeros((0, CEPSTRA))
    emphasized = np.append(samples[0], samples[1:] - 0.97 * samples[:-1]).astype(np.float64)
    count = 1 + (emphasized.size - FRAME) // HOP
    frames = np.lib.stride_tricks.as_strided(
        emphasized, shape=(count, FRAME), strides=(emphasized.strides[0] * HOP, emphasized.strides[0]),
    ) * np.hamming(FRAME)
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2 / FRAME
    energy = power.sum(axis=1)
    # Keep voiced frames only, so pauses inside a cue do not blur its voice.
    voiced = energy > max(1e-10, np.percentile(energy, 30))
    log_mel = np.log(power[voiced] @ bank.T + 1e-10)
    return (log_mel @ dct.T)[:, 1:CEPSTRA + 1]


def embed(audio, cues):
    bank = mel_filterbank()
    n = np.arange(MEL_BANDS)
    dct = np.cos(np.pi / MEL_BANDS * (n + 0.5)[None, :] * np.arange(CEPSTRA + 1)[:, None])
    features = []
    for cue in cues:
        start, end = int(cue["startSec"] * RATE), int(cue["endSec"] * RATE)
        frames = mfcc(audio[start:end], bank, dct) if cue["endSec"] - cue["startSec"] >= MIN_SECONDS else None
        features.append(frames if frames is not None and len(frames) >= 20 else None)
    pooled = [f for f in features if f is not None]
    if not pooled:
        return [None] * len(cues), [None] * len(cues)
    stacked = np.vstack(pooled)
    mean, spread = stacked.mean(axis=0), stacked.std(axis=0) + 1e-6
    raw = [None if frames is None else np.concatenate([
        ((frames - mean) / spread).mean(axis=0), ((frames - mean) / spread).std(axis=0),
    ]) for frames in features]
    # Centre on the span's average voice. Every cue shares the same room and microphone, so what is
    # left after centring is mostly who is talking.
    centre = np.mean([vector for vector in raw if vector is not None], axis=0)
    vectors, absolute = [], []
    for vector in raw:
        if vector is None:
            vectors.append(None)
            absolute.append(None)
            continue
        shifted = vector - centre
        vectors.append(shifted / (np.linalg.norm(shifted) + 1e-9))
        absolute.append(vector / (np.linalg.norm(vector) + 1e-9))
    return vectors, absolute


def assign(vectors, absolute, threshold, anchors=None):
    """Average-linkage agglomerative clustering on cosine distance.

    Centred vectors split voices sharply, but in a monologue they only amplify noise. Clusters whose
    uncentred voices are nearly identical are therefore merged back into one speaker.
    """
    usable = [i for i, v in enumerate(vectors) if v is not None]
    labels = [None] * len(vectors)
    indices = [i for i in usable if anchors is None or anchors[i]]
    if len(indices) < 2:
        indices = usable
    if not indices:
        return labels
    matrix = np.array([vectors[i] for i in indices])
    pairwise = 1 - matrix @ matrix.T
    groups = [[k] for k in range(len(indices))]
    while len(groups) > 1:
        best = None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                d = pairwise[np.ix_(groups[a], groups[b])].mean()
                if best is None or d < best[0]:
                    best = (d, a, b)
        if best[0] > threshold and len(groups) <= MAX_SPEAKERS:
            break
        _, a, b = best
        groups[a].extend(groups.pop(b))
    plain = np.array([absolute[i] for i in indices])
    same_voice = 1 - plain @ plain.T
    merged = True
    while merged and len(groups) > 1:
        merged = False
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                if same_voice[np.ix_(groups[a], groups[b])].mean() < SAME_VOICE:
                    groups[a].extend(groups.pop(b))
                    merged = True
                    break
            if merged:
                break
    # Name speakers by first appearance so labels read in timeline order.
    groups.sort(key=min)
    for name, group in enumerate(groups):
        for k in group:
            labels[indices[k]] = f"S{name}"
    # Attach each short fragment to the closest voice when it is clearly that voice.
    for i in set(usable) - set(indices):
        distances = [np.mean([1 - vectors[i] @ vectors[indices[k]] for k in group]) for group in groups]
        best = int(np.argmin(distances))
        if distances[best] <= threshold:
            labels[i] = f"S{best}"
    return labels


def smooth(labels):
    """Give an unlabelled short cue its neighbours' voice when both neighbours agree."""
    result = list(labels)
    for i in range(1, len(result) - 1):
        if result[i] is None and result[i - 1] and result[i - 1] == result[i + 1]:
            result[i] = result[i - 1]
    return result


def diarize(media, cues, threshold=1.0):
    if not cues:
        return []
    vectors, absolute = embed(load_audio(media), cues)
    anchors = [cue["endSec"] - cue["startSec"] >= ANCHOR_SECONDS for cue in cues]
    return smooth(assign(vectors, absolute, threshold, anchors))


if __name__ == "__main__":
    with open(sys.argv[2], encoding="utf8") as handle:
        timed = json.load(handle)
    limit = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    print(json.dumps(diarize(sys.argv[1], timed, limit)))
