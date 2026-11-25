"""Return sustained on-screen speaker intervals in clip-relative seconds.

Usage: speaker-framing.py <yunet.onnx> <media> <start> <end> [speaker-turns.json]

With diarized turns ([{"start", "end", "speaker"}] in clip seconds), each voice is matched to the one
face whose mouth moves when that voice speaks, across the whole clip. Shots then follow the turns:
a switch needs a sustained turn, short interjections keep the current shot, rapid crosstalk holds the
wide two-shot, and a voice with no matching face (offscreen narration) keeps the full scene.

Without turns, or when no voice can be matched, the script falls back to per-second correlation of
loudness and mouth motion.
"""
import json
import subprocess
import sys

import numpy as np

RATE = 6
SLOT_TOLERANCE = 0.08
SUSTAINED_TURN = 2.0
MIN_SHOT = 1.5
# Detect at 1280 px wide: in a seated two-shot each face is only ~3.5% of the frame width.
DETECT_WIDTH = 1280
MIN_FACE = 0.025  # of frame width


def observe(model, source, start, end):
    import cv2

    pcm = subprocess.check_output([
        "ffmpeg", "-v", "error", "-ss", str(start), "-i", source, "-t", str(end-start),
        "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"
    ], timeout=20)
    audio = np.frombuffer(pcm, dtype=np.float32)
    capture = cv2.VideoCapture(source)
    detector = cv2.FaceDetectorYN.create(model, "", (DETECT_WIDTH, DETECT_WIDTH*9//16), 0.7)
    previous = {}
    observations = []
    for frame_index in range(int((end-start)*RATE)):
        t = frame_index/RATE
        capture.set(cv2.CAP_PROP_POS_MSEC, (start+t)*1000)
        ok, image = capture.read()
        if not ok:
            break
        height, width = image.shape[:2]
        image = cv2.resize(image, (DETECT_WIDTH, max(1, round(height*DETECT_WIDTH/width))))
        detector.setInputSize((DETECT_WIDTH, image.shape[0]))
        faces = detector.detect(image)[1]
        current, motion, centers = {}, {}, {}
        for face in ([] if faces is None else faces):
            x, y, w, h = face[:4]
            if w < MIN_FACE*DETECT_WIDTH:
                continue
            cx = float((x+w/2)/DETECT_WIDTH)
            # Match spatially adjacent faces between samples.
            key = min(previous, key=lambda k: abs(k-cx), default=cx)
            if abs(key-cx) > SLOT_TOLERANCE:
                key = cx
            mx, my = (face[10:12]+face[12:14])/2
            patch = image[max(0, int(my-h*.10)):int(my+h*.10), max(0, int(mx-w*.20)):int(mx+w*.20)]
            if not patch.size:
                continue
            patch = cv2.resize(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY), (24, 12)).astype(float)
            patch -= patch.mean()
            current[key] = patch
            centers[key] = cx
            if key in previous:
                motion[key] = float(np.abs(patch-previous[key]).mean())
        samples = audio[int(t*8000):int((t+1/RATE)*8000)]
        level = float(np.sqrt(np.mean(samples**2))) if samples.size else 0
        observations.append((level, motion, centers))
        previous = current
    capture.release()
    return observations


def motion_intervals(observations):
    intervals = []
    for i in range(0, len(observations)-RATE+1, RATE):
        group = observations[i:i+RATE]
        levels = np.array([row[0] for row in group])
        if levels.max() < .015 or levels.std() < .003:
            continue
        scores = []
        for key, center in group[-1][2].items():
            values = [row[1].get(key, 0) for row in group]
            if sum(v > 0 for v in values) < 5 or np.std(values) < 1:
                continue
            correlation = np.corrcoef(levels, values)[0, 1]
            if correlation > .45:
                scores.append((correlation, center))
        scores.sort(reverse=True)
        if not scores or (len(scores) > 1 and scores[0][0]-scores[1][0] < .25):
            continue
        center = round(scores[0][1], 2)
        if intervals and intervals[-1]["end"] == i/RATE and abs(intervals[-1]["center"]-center) < SLOT_TOLERANCE:
            intervals[-1]["end"] += 1
        else:
            intervals.append({"start": i/RATE, "end": i/RATE+1, "center": center})
    return [row for row in intervals if row["end"]-row["start"] >= 2]


def face_slots(observations):
    """Group face centres seen across the clip into stable on-screen positions."""
    centres = sorted(c for _, _, centers in observations for c in centers.values())
    slots, group = [], []
    for c in centres:
        if group and c - group[-1] > SLOT_TOLERANCE:
            slots.append(float(np.mean(group)))
            group = []
        group.append(c)
    if group:
        slots.append(float(np.mean(group)))
    return slots


def slot_motion(observations, slots):
    """Per sample, mouth motion for each slot (NaN when that face is not visible)."""
    table = np.full((len(observations), len(slots)), np.nan)
    for i, (_, motion, centers) in enumerate(observations):
        for key, centre in centers.items():
            if key not in motion or not slots:
                continue
            slot = int(np.argmin([abs(centre-s) for s in slots]))
            if abs(slots[slot]-centre) <= SLOT_TOLERANCE:
                table[i, slot] = motion[key]
    return table


def match_voices(observations, turns):
    """Map each diarized voice to the face whose mouth moves during that voice's turns."""
    slots = face_slots(observations)
    if not slots:
        return {}
    table = slot_motion(observations, slots)
    speaking = {}
    for turn in turns:
        lo, hi = int(turn["start"]*RATE), min(len(observations), int(np.ceil(turn["end"]*RATE)))
        speaking.setdefault(turn["speaker"], set()).update(range(max(0, lo), hi))
    candidates = []
    for voice, samples in speaking.items():
        others = set().union(*(s for v, s in speaking.items() if v != voice)) - samples
        own = sorted(samples)
        for slot in range(len(slots)):
            inside = table[own, slot] if own else np.array([])
            visible = inside[~np.isnan(inside)]
            if not own or len(visible) < max(3, 0.5*len(own)):
                continue
            column = table[:, slot]
            spread = np.nanstd(column) + 1e-6
            # Preferred evidence: while this voice speaks, does this mouth move more than the other
            # visible mouths in the same frames? That cancels camera moves and shared body motion.
            rows = table[own]
            shared = rows[(~np.isnan(rows[:, slot])) & ((~np.isnan(rows)).sum(axis=1) >= 2)]
            if len(shared) >= max(3, 0.5*len(own)):
                others_mean = (np.nansum(shared, axis=1) - shared[:, slot]) / ((~np.isnan(shared)).sum(axis=1) - 1)
                candidates.append(((shared[:, slot]-others_mean).mean()/spread, voice, slot))
                continue
            # One face on screen: compare its motion with the times other voices speak.
            outside = table[sorted(others), slot] if others else np.array([])
            outside = outside[~np.isnan(outside)]
            baseline = outside.mean() if outside.size else np.nanmean(column)
            candidates.append(((visible.mean()-baseline)/spread, voice, slot))
    # Labels are scoped per analysis chunk ("c3:S0"), so one person can carry a different label on each
    # side of a chunk boundary. A face is exclusive to one voice within a scope only.
    mapping, used = {}, set()
    for score, voice, slot in sorted(candidates, reverse=True):
        scope = voice.split(":")[0]
        if score < .35 or voice in mapping or (scope, slot) in used:
            continue
        mapping[voice] = round(slots[slot], 2)
        used.add((scope, slot))
    return mapping


def turn_shots(turns, mapping, duration):
    """Follow sustained turns. Interjections keep the shot; crosstalk and offscreen voices go wide."""
    turns = sorted(turns, key=lambda turn: turn["start"])
    starts = [turn["start"] for turn in turns]
    plan = []  # (time, centre, or None for the wide shot)
    current = "unset"
    for turn in turns:
        rapid = sum(1 for s in starts if abs(s-turn["start"]) <= 2) >= 3
        centre = mapping.get(turn["speaker"])
        if rapid:
            target = None
        elif turn["end"]-turn["start"] >= SUSTAINED_TURN or current == "unset":
            target = centre
        else:
            target = current
        if target != current:
            plan.append((max(0.0, turn["start"]), target))
            current = target
    shots = []
    for index, (start, centre) in enumerate(plan):
        end = plan[index+1][0] if index+1 < len(plan) else duration
        if centre is not None and end-start >= MIN_SHOT:
            shots.append({"start": round(start, 2), "end": round(end, 2), "center": centre})
    return shots


def analyze(model, source, start, end, turns=None):
    observations = observe(model, source, start, end)
    if turns:
        mapping = match_voices(observations, turns)
        if mapping:
            return turn_shots(turns, mapping, end-start)
    return motion_intervals(observations)


if __name__ == "__main__":
    speaker_turns = None
    if len(sys.argv) > 5:
        with open(sys.argv[5], encoding="utf8") as handle:
            speaker_turns = json.load(handle)
    print(json.dumps(analyze(sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), speaker_turns)))
