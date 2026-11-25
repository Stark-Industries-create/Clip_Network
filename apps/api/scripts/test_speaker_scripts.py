"""Unit tests for diarization clustering and speaker-led framing.

Run: python -m unittest discover -s apps/api/scripts -p "test_*.py"   (needs NumPy only)
"""
import importlib.util
import pathlib
import unittest

import numpy as np

HERE = pathlib.Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


framing = load("speaker_framing", "speaker-framing.py")
diarize = load("diarize", "diarize.py")

TURNS = [
    {"start": 0, "end": 5, "speaker": "c0:S0"},
    {"start": 5, "end": 9, "speaker": "c0:S1"},
    {"start": 9, "end": 9.8, "speaker": "c0:S0"},  # interjection
    {"start": 9.8, "end": 14, "speaker": "c0:S1"},
    {"start": 14, "end": 14.8, "speaker": "c0:S0"},  # crosstalk begins
    {"start": 14.8, "end": 15.6, "speaker": "c0:S1"},
    {"start": 15.6, "end": 16.4, "speaker": "c0:S0"},
    {"start": 16.4, "end": 17, "speaker": "c0:S1"},
    {"start": 17, "end": 22, "speaker": "c0:S2"},  # offscreen narrator
]


def synthetic_observations(duration=22):
    """Two faces at x=0.3 and x=0.7. Each mouth moves only while its own voice speaks."""
    rows = []
    for i in range(int(duration * framing.RATE)):
        t = i / framing.RATE
        voice = next((turn["speaker"] for turn in TURNS if turn["start"] <= t < turn["end"]), None)
        motion = {0.3: 9.0 if voice == "c0:S0" else 1.0, 0.7: 9.0 if voice == "c0:S1" else 1.0}
        rows.append((0.1, motion, {0.3: 0.3, 0.7: 0.7}))
    return rows


class SpeakerFramingTest(unittest.TestCase):
    def test_matches_each_voice_to_its_face_and_leaves_the_narrator_wide(self):
        mapping = framing.match_voices(synthetic_observations(), TURNS)
        self.assertEqual(mapping, {"c0:S0": 0.3, "c0:S1": 0.7})

    def test_switches_only_on_sustained_turns_and_holds_wide_for_crosstalk(self):
        shots = framing.turn_shots(TURNS, {"c0:S0": 0.3, "c0:S1": 0.7}, 22)
        self.assertEqual(shots, [
            {"start": 0, "end": 5, "center": 0.3},
            {"start": 5, "end": 14, "center": 0.7},  # the 0.8 s interjection does not cut away
        ])

    def test_unmatched_voices_keep_the_full_scene(self):
        self.assertEqual(framing.turn_shots(TURNS[-1:], {}, 22), [])


class DiarizeClusteringTest(unittest.TestCase):
    def test_two_voices_split_and_one_voice_stays_whole(self):
        rng = np.random.default_rng(7)
        a, b = rng.normal(size=40), rng.normal(size=40)

        def unit(v):
            return v / np.linalg.norm(v)

        absolute = [unit(v + rng.normal(scale=0.05, size=40)) for v in [a, b, a, b, a]]
        centre = np.mean(absolute, axis=0)
        centred = [unit(v - centre) for v in absolute]
        self.assertEqual(diarize.assign(centred, absolute, 1.0), ["S0", "S1", "S0", "S1", "S0"])

        monologue = [unit(a + rng.normal(scale=0.05, size=40)) for _ in range(5)]
        centre = np.mean(monologue, axis=0)
        centred = [unit(v - centre) for v in monologue]
        self.assertEqual(set(diarize.assign(centred, monologue, 1.0)), {"S0"})

    def test_fills_unlabelled_cues_only_between_matching_neighbours(self):
        self.assertEqual(diarize.smooth(["S0", None, "S0", None, "S1"]), ["S0", "S0", "S0", None, "S1"])


if __name__ == "__main__":
    unittest.main()
