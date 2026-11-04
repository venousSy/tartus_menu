"""PostToolUse hook: check a file right after Claude writes or edits it.

This enforces the AGENTS.md Section 7 rule "After writing, re-read the file":
valid UTF-8, no BOM, no control characters, no garbled text, and line endings
that are not mixed (and LF where .gitattributes asks for eol=lf).

The write has already happened; a PostToolUse hook cannot undo it.
Exit code 2 sends the stderr text to Claude, who must then fix the file.
"""

import json
import os
import re
import subprocess
import sys

BOM = b"\xef\xbb\xbf"

# Allowed: tab (\x09), LF (\x0a) and CR (\x0d). Everything else below 0x20, and DEL.
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# Mojibake: UTF-8 bytes that were wrongly read as Windows-1252. Example: an
# e-acute turns into A-tilde + copyright sign. (Described in words, so that this
# file stays ASCII and passes its own check.)
# Bytes 0x80-0xBF (UTF-8 continuation bytes) turn into these characters:
CONTINUATION = "".join(bytes([b]).decode("cp1252", errors="ignore") for b in range(0x80, 0xC0))
# A lead byte (0xC2-0xF4) read as Windows-1252, followed by continuation characters.
LEADS = chr(0xC2) + "-" + chr(0xF4)
MOJIBAKE_CANDIDATE = re.compile("[" + LEADS + "][" + re.escape(CONTINUATION) + "]+")

MAX_REPORTED = 3  # Per problem type, so the message stays short.


def line_of(text, index):
    return text.count("\n", 0, index) + 1


def repair_mojibake(fragment):
    """Return the real text if the fragment is garbled UTF-8, else None."""
    for length in range(len(fragment), 1, -1):
        try:
            return fragment[:length].encode("cp1252").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
    return None


def requires_lf(path):
    """True if .gitattributes gives this file eol=lf (shell scripts, crontab)."""
    try:
        result = subprocess.run(
            ["git", "check-attr", "eol", "--", path],
            capture_output=True, text=True, timeout=5, cwd=os.path.dirname(path) or None,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.stdout.strip().endswith(": lf")


def find_problems(path, data):
    """Return a list of human-readable problems found in the file bytes."""
    problems = []
    if data.startswith(BOM):
        problems.append("starts with a UTF-8 BOM. Save it as UTF-8 without BOM.")
        data = data[len(BOM):]

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        line = data.count(b"\n", 0, error.start) + 1
        problems.append(f"is not valid UTF-8 (first bad byte on line {line}).")
        return problems

    lines = sorted({line_of(text, m.start()) for m in CONTROL_CHARS.finditer(text)})
    if lines:
        shown = ", ".join(str(n) for n in lines[:MAX_REPORTED])
        problems.append(f"has control characters on line {shown}.")

    found = 0
    for match in MOJIBAKE_CANDIDATE.finditer(text):
        fixed = repair_mojibake(match.group())
        if fixed:
            garbled = match.group()[: len(fixed.encode("utf-8"))]
            problems.append(
                f"has garbled text on line {line_of(text, match.start())}: "
                f"'{garbled}' should be '{fixed}'."
            )
            found += 1
            if found == MAX_REPORTED:
                break

    crlf = data.count(b"\r\n")
    lone_lf = data.count(b"\n") - crlf
    lone_cr = data.count(b"\r") - crlf
    if crlf and lone_lf:
        problems.append(
            f"mixes line endings ({crlf} CRLF, {lone_lf} LF). Keep the file's original style."
        )
    if lone_cr:
        problems.append(f"has {lone_cr} bare CR line ending(s).")
    if crlf and requires_lf(path):
        problems.append("must use LF only (.gitattributes sets eol=lf), but has CRLF.")
    return problems


def main():
    try:
        # utf-8-sig also accepts input that starts with a BOM (PowerShell adds one).
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        path = payload["tool_input"]["file_path"]
        with open(path, "rb") as file:
            data = file.read()
    except (ValueError, KeyError, TypeError, OSError):
        return 0  # Nothing we can check: never fail the edit on our own problem.

    problems = find_problems(path, data)
    if not problems:
        return 0
    # Garbled samples are non-ASCII; print them as UTF-8 whatever the console uses.
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    print(f"file_check.py: {path}", file=sys.stderr)
    for problem in problems:
        print(f"- The file {problem}", file=sys.stderr)
    print("Fix the file now, then re-read it.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
