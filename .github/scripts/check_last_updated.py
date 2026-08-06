"""
Verifies that the built docs show per-page git dates rather than the build date.

Used by the Windows smoke workflow to confirm the fix for the
``doc2path`` separator bug on Windows.

For each of a handful of source files (one top-level, several nested), the
script:

1. Reads the "Last updated" date from the built HTML page.
2. Computes the expected git date for the source .rst file.
3. Prints a table and fails if any nested page shows today's build date
   instead of the correct git date, or if the two don't match.
"""

from __future__ import annotations

import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BUILD_DIR = REPO_ROOT / "docs" / "_build" / "dirhtml"
SOURCE_DIR = REPO_ROOT / "docs" / "source"

# (source .rst path relative to docs/source, corresponding HTML path relative
# to _build/dirhtml). Mix of top-level (Anna's working case) and nested pages
# (Anna's broken case) so the check would have caught the original bug.
PAGES = [
    ("commands.rst",              "commands/index.html"),
    ("configuration/index.rst",   "configuration/index.html"),
    ("configuration/multiversion.rst", "configuration/multiversion/index.html"),
    ("getting-started/index.rst", "getting-started/index.html"),
    ("deployment/index.rst",      "deployment/index.html"),
]

LAST_UPDATED_RE = re.compile(r"Last updated on\s*([^<.]+?)\s*\.", re.IGNORECASE)


def git_date(source_rel: str) -> str | None:
    """Format matches ``html_last_updated_fmt`` in docs/source/conf.py."""
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "log", "-1", "--format=%at", "--", f"docs/source/{source_rel}"],
        capture_output=True, text=True, check=True,
    )
    stamp = result.stdout.strip()
    if not stamp:
        return None
    return datetime.fromtimestamp(int(stamp), tz=timezone.utc).strftime("%d %b %Y")


def html_date(html_rel: str) -> str | None:
    path = BUILD_DIR / html_rel
    if not path.exists():
        return f"<MISSING: {path}>"
    match = LAST_UPDATED_RE.search(path.read_text(encoding="utf-8"))
    return match.group(1).strip() if match else None


def main() -> int:
    today = datetime.now(tz=timezone.utc).strftime("%d %b %Y")
    print(f"Today (build date): {today}")
    print(f"{'source':<32}{'expected (git)':<20}{'shown (html)':<20}{'ok?'}")
    print("-" * 80)

    failures: list[str] = []
    for src, html in PAGES:
        expected = git_date(src)
        shown = html_date(html)
        ok = expected is not None and shown == expected
        marker = "OK" if ok else "FAIL"
        print(f"{src:<32}{str(expected):<20}{str(shown):<20}{marker}")
        if not ok:
            reason = "shows build date" if shown == today else f"mismatch (expected {expected!r}, got {shown!r})"
            failures.append(f"  - {src}: {reason}")

    print()
    if failures:
        print("FAILURES:")
        for line in failures:
            print(line)
        return 1
    print("All pages show their git commit date. Fix is working on Windows.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
