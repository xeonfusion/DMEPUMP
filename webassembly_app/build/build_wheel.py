#!/usr/bin/env python3
"""
Build an obfuscated, source-free wheel for the DMEPUMP TCI Pyodide engine.

This compiles core_tci.py and tcimodels.py to Python bytecode (.pyc) with
docstrings/asserts stripped (-OO) and packages ONLY the compiled bytecode
into a standard wheel (no .py source is included). Pyodide/CPython can
import sourceless ".pyc" modules directly, so no build step is required
inside the browser.

IMPORTANT: the bytecode magic number is tied to the CPython minor version.
This script must be run with a CPython interpreter whose minor version
matches the Python version bundled in the target Pyodide release (see
PYODIDE_PYTHON_VERSION below and the pyodide.js CDN version in index.html).

Usage:
    /path/to/python3.14 build/build_wheel.py
"""
from __future__ import annotations

import csv
import hashlib
import io
import py_compile
import sys
import zipfile
from base64 import urlsafe_b64encode
from pathlib import Path

# Pyodide v314.0.6 bundles CPython 3.14.2 - keep in sync with index.html.
PYODIDE_PYTHON_VERSION = (3, 14)

DIST_NAME = "dmepump_tci_core"
VERSION = "1.0.0"
MODULES = ["tcimodels.py", "core_tci.py"]

ROOT = Path(__file__).resolve().parent.parent
# Source lives OUTSIDE the webassembly_app/ publish folder so GitHub Pages
# (or any static host serving webassembly_app/ verbatim) never exposes it.
SRC_DIR = ROOT.parent / "webassembly_app_src"
DIST_DIR = ROOT / "python" / "dist"
WHEEL_NAME = f"{DIST_NAME}-{VERSION}-py3-none-any.whl"


def check_interpreter() -> None:
    if sys.version_info[:2] != PYODIDE_PYTHON_VERSION:
        got = f"{sys.version_info[0]}.{sys.version_info[1]}"
        want = ".".join(map(str, PYODIDE_PYTHON_VERSION))
        raise SystemExit(
            f"This script must be run with CPython {want} to match Pyodide's "
            f"bundled interpreter (got {got}). Re-run with the matching python binary."
        )


def record_row(arcname: str, data: bytes) -> tuple[str, str, str]:
    digest = urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return arcname, f"sha256={digest}", str(len(data))


def build() -> Path:
    check_interpreter()
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    wheel_path = DIST_DIR / WHEEL_NAME

    dist_info = f"{DIST_NAME}-{VERSION}.dist-info"
    metadata = (
        "Metadata-Version: 2.1\n"
        f"Name: {DIST_NAME}\n"
        f"Version: {VERSION}\n"
        "Summary: DMEPUMP TCI engine (compiled, source-hidden distribution)\n"
        "Author: John George K.\n"
        "Requires-Python: >=3.14\n"
        "Requires-Dist: numpy\n"
        "Requires-Dist: scipy\n"
    ).encode()
    wheel_meta = (
        "Wheel-Version: 1.0\n"
        "Generator: build_wheel.py (bytecode-only)\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
    ).encode()

    entries: list[tuple[str, bytes]] = []
    for src_name in MODULES:
        src_path = SRC_DIR / src_name
        module_name = src_path.stem
        pyc_bytes_io = io.BytesIO()
        code = py_compile.compile(
            str(src_path), cfile=None, doraise=True, optimize=2, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
        )
        # py_compile writes to disk; read it back, then delete the on-disk .pyc
        with open(code, "rb") as f:
            pyc_bytes_io.write(f.read())
        Path(code).unlink()
        entries.append((f"{module_name}.pyc", pyc_bytes_io.getvalue()))

    entries.append((f"{dist_info}/METADATA", metadata))
    entries.append((f"{dist_info}/WHEEL", wheel_meta))

    record_lines = [record_row(name, data) for name, data in entries]
    record_lines.append((f"{dist_info}/RECORD", "", ""))

    if wheel_path.exists():
        wheel_path.unlink()

    with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            zf.writestr(name, data)
        record_csv = io.StringIO()
        writer = csv.writer(record_csv, lineterminator="\n")
        for row in record_lines:
            writer.writerow(row)
        zf.writestr(f"{dist_info}/RECORD", record_csv.getvalue())

    print(f"Built {wheel_path} ({wheel_path.stat().st_size} bytes)")
    print("Contents:")
    for name, data in entries:
        print(f"  {name}  ({len(data)} bytes)")
    return wheel_path


if __name__ == "__main__":
    build()
