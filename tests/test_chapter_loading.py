import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import app as galib


ROOT = Path(__file__).resolve().parents[1]


class ChapterCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.library = Path(self.temp.name) / "library"
        self.series = self.library / "One Piece"
        self.series.mkdir(parents=True)
        self.patches = [
            mock.patch.object(galib, "DEFAULT_FOLDER", str(self.library)),
            mock.patch.object(galib, "CONTAINER_MODE", True),
            mock.patch.object(galib, "AUTH_ENABLED", False),
        ]
        for patch in self.patches:
            patch.start()
        self.client = galib.app.test_client()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def test_large_chapter_listing_never_opens_cbz_files(self):
        for number in range(1, 1101):
            (self.series / f"Chapter {number:04d}.cbz").touch()

        with mock.patch.object(
            galib.zipfile,
            "ZipFile",
            side_effect=AssertionError("chapter listing opened a CBZ"),
        ):
            response = self.client.get("/api/series/One%20Piece/chapters")

        self.assertEqual(response.status_code, 200)
        chapters = response.get_json()["chapters"]
        self.assertEqual(len(chapters), 1100)
        self.assertEqual(chapters[0], {"file": "Chapter 0001.cbz", "pages": None})
        self.assertEqual(chapters[-1], {"file": "Chapter 1100.cbz", "pages": None})

    def test_pages_route_still_counts_only_the_opened_chapter(self):
        chapter = self.series / "Chapter 0001.cbz"
        with zipfile.ZipFile(chapter, "w") as archive:
            archive.writestr("001.jpg", b"page")
            archive.writestr("002.jpg", b"page")
            archive.writestr("ComicInfo.xml", b"metadata")

        response = self.client.get(
            "/api/series/One%20Piece/chapters/Chapter%200001.cbz/pages"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"pages": 2})


class ChapterPickerTests(unittest.TestCase):
    def test_window_starts_near_current_chapter_and_extends_both_directions(self):
        script = """
          const { ChapterWindow, displayName } = require("./static/chapter-picker.js");
          const chapters = Array.from({ length: 1100 }, (_, i) => i + 1);
          const window = new ChapterWindow(50);
          const initial = window.reset(chapters, 700);
          const before = window.before();
          const after = window.after();
          process.stdout.write(JSON.stringify({
            initial,
            before,
            after,
            names: [
              displayName("Chapter 0001.cbz"),
              displayName("Chapter 0012.500.cbz"),
              displayName("Special 000.cbz"),
            ],
          }));
        """
        result = subprocess.run(
            ["node", "-e", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)

        self.assertEqual(payload["initial"]["items"], list(range(676, 726)))
        self.assertEqual(payload["before"]["items"], list(range(626, 676)))
        self.assertEqual(payload["after"]["items"], list(range(726, 776)))
        self.assertEqual(
            payload["names"],
            ["Chapter 1", "Chapter 12.5", "Special 0"],
        )

    def test_javascript_syntax_and_load_order(self):
        subprocess.run(
            ["node", "--check", ROOT / "static" / "chapter-picker.js"],
            cwd=ROOT,
            check=True,
        )
        subprocess.run(
            ["node", "--check", ROOT / "static" / "app.js"],
            cwd=ROOT,
            check=True,
        )
        html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        self.assertLess(
            html.index('src="chapter-picker.js"'),
            html.index('src="app.js"'),
        )
        service_worker = (ROOT / "static" / "sw.js").read_text(encoding="utf-8")
        self.assertIn('"/chapter-picker.js"', service_worker)


if __name__ == "__main__":
    unittest.main()
