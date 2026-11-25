"""Find a stable side-positioned face in a sampled video segment."""

import json
import math
import statistics
import sys

import cv2


def detect(model, source, start, end):
    capture = cv2.VideoCapture(source)
    detector = cv2.FaceDetectorYN.create(model, "", (1920, 1080), 0.65, 0.3, 200)
    tracks = []
    sample_count = 9
    for index in range(sample_count):
        capture.set(cv2.CAP_PROP_POS_MSEC, (start + (end - start) * (index + 0.5) / sample_count) * 1000)
        ok, frame = capture.read()
        if not ok:
            continue
        height, width = frame.shape[:2]
        factor = min(1920 / width, 1080 / height)
        image = cv2.resize(frame, (round(width * factor), round(height * factor)))
        h, w = image.shape[:2]
        detector.setInputSize((w, h))
        _, faces = detector.detect(image)
        if faces is None:
            continue
        for x, y, fw, fh, *_ in faces:
            center_x, center_y = float(x + fw / 2), float(y + fh / 2)
            if 0.28 < center_x / w < 0.72 or not 18 < fw < 0.18 * w:
                continue
            nearby = next(
                (track for track in tracks if math.dist(track[0][1:3], (center_x, center_y)) < 65), None
            )
            hit = (index, center_x, center_y, float(fw), float(fh), w, h)
            if nearby is None:
                tracks.append([hit])
            elif nearby[-1][0] != index:
                nearby.append(hit)
    capture.release()
    tracks.sort(key=len, reverse=True)
    if not tracks or len(tracks[0]) < 4 or (len(tracks) > 1 and len(tracks[1]) >= len(tracks[0]) - 1):
        return None
    _, x, y, fw, fh, w, h = (statistics.median(values) for values in zip(*tracks[0]))
    crop_width = min(640, max(420, round(max(fw * 4.2, fh * 3.6))))
    crop_height = round(crop_width * 768 / 1080)
    if crop_width > w or crop_height > h:
        return None
    left = min(w - crop_width, max(0, x - crop_width / 2)) + (1920 - w) / 2
    top = min(h - crop_height, max(0, y - crop_height * 0.44)) + (1080 - h) / 2
    return {"x": round(left), "y": round(top), "width": crop_width, "height": crop_height}


if __name__ == "__main__":
    print(json.dumps(detect(sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))))
