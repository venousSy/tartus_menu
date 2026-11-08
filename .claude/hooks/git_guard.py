"""PreToolUse hook: block git commands that break AGENTS.md Section 7.

Claude Code sends the pending tool call as JSON on stdin. This script finds
every git command inside the shell command line and checks it.

Exit code 0 lets the command run. Exit code 2 blocks it, and the text printed
to stderr is shown to Claude as the reason.
"""

import json
import os
import re
import subprocess
import sys

PROTECTED_BRANCH = "main"

# Characters that end one shell statement and start the next one,
# when they appear outside quotes. Example: "git add x; git push".
STATEMENT_BREAKS = set(";|&{}()\n")

# PowerShell here-strings (@'...'@ and @"..."@) hold free text such as commit
# messages. They are removed first, so words inside are never read as commands.
HERE_STRING = re.compile(r"@'.*?'@|@\".*?\"@", re.DOTALL)

# Global git options that take a separate value, as in: git -C <path> push.
OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}

# "git add" arguments that stage many files at once instead of by name.
BULK_ADD_ARGS = {".", "./", "*", ":/", "--all", "--update"}


def split_statements(command):
    """Split a command line into statements; each statement is a list of words.

    Quotes group words and are removed. Breaks inside quotes do not split.
    """
    command = HERE_STRING.sub(" ", command)
    statements, words, word, quote = [], [], "", None
    for char in command:
        if quote:
            if char == quote:
                quote = None
            else:
                word += char
        elif char in "'\"":
            quote = char
        elif char in STATEMENT_BREAKS or char.isspace():
            if word:
                words.append(word)
                word = ""
            if char in STATEMENT_BREAKS and words:
                statements.append(words)
                words = []
        else:
            word += char
    if word:
        words.append(word)
    if words:
        statements.append(words)
    return statements


def parse_git(words):
    """Return (repo_dir, subcommand, args) for one git statement."""
    repo_dir, i = None, 1
    while i < len(words) and words[i].startswith("-"):
        if words[i] in OPTIONS_WITH_VALUE and i + 1 < len(words):
            if words[i] == "-C":
                repo_dir = words[i + 1]
            i += 2
        else:
            i += 1
    if i >= len(words):
        return repo_dir, None, []
    return repo_dir, words[i], words[i + 1 :]


# Branches switched to by earlier statements of the same command line, per repo_dir. The hook runs
# before the whole line, so "git switch main; git commit" must be judged on main, not on the branch
# that is checked out now.
SWITCHED = {}


def switch_target(subcommand, args):
    """The branch a "git switch" or "git checkout" statement moves to, or None when it moves nowhere."""
    if subcommand not in ("switch", "checkout") or "--" in args:
        return None  # "git checkout -- file" restores a file; it does not change the branch
    for i, arg in enumerate(args):
        if arg in ("-c", "-C", "-b", "-B", "--create", "--force-create") and i + 1 < len(args):
            return args[i + 1]
    positional = [arg for arg in args if not arg.startswith("-")]
    return positional[0] if positional else None


def current_branch(repo_dir):
    """Return the checked-out branch name, or None if git cannot tell."""
    if repo_dir in SWITCHED:
        return SWITCHED[repo_dir]
    command = ["git"]
    if repo_dir:
        command += ["-C", repo_dir]
    # symbolic-ref also works in a new repo with no commits yet (rev-parse does not).
    command += ["symbolic-ref", "--short", "HEAD"]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None


def has_short_flag(args, letter):
    """True if a short flag group such as -fd contains the letter."""
    return any(
        arg.startswith("-") and not arg.startswith("--") and letter in arg[1:]
        for arg in args
    )


def check_push(args, repo_dir):
    forced = (
        any(arg.startswith("--force") for arg in args)
        or has_short_flag(args, "f")
        or "--mirror" in args
    )
    # The first positional word is the remote; the rest are refspecs.
    refspecs = [arg for arg in args if not arg.startswith("-")][1:]
    if forced or any(spec.startswith("+") for spec in refspecs):
        return "force push rewrites pushed history. AGENTS.md Section 7 forbids it."

    branch = current_branch(repo_dir)
    targets = [spec.split(":")[-1] for spec in refspecs] or [branch]
    targets = [branch if target == "HEAD" else target for target in targets]
    if any(t in (PROTECTED_BRANCH, "refs/heads/" + PROTECTED_BRANCH) for t in targets):
        return "never push directly to main. Push a feature branch and open a PR."
    return None


def check_commit(args, repo_dir):
    if current_branch(repo_dir) == PROTECTED_BRANCH:
        return "never commit directly to main. Create a branch first."
    if "--all" in args or has_short_flag(args, "a"):
        return "commit -a stages every changed file. Stage files by name with git add."
    return None


def check_reset(args, repo_dir):
    if "--hard" in args:
        return "reset --hard throws away work. AGENTS.md Section 7 forbids it."
    return None


def check_clean(args, repo_dir):
    if "--force" in args or has_short_flag(args, "f"):
        return "clean -f deletes untracked files. AGENTS.md Section 7 forbids it."
    return None


def check_branch(args, repo_dir):
    deleting = "--delete" in args or has_short_flag(args, "d") or has_short_flag(args, "D")
    forced = has_short_flag(args, "D") or "--force" in args or has_short_flag(args, "f")
    if deleting and forced:
        return "branch -D deletes unmerged work. Use branch -d, or ask the user."
    return None


def check_add(args, repo_dir):
    if any(arg in BULK_ADD_ARGS for arg in args) or has_short_flag(args, "A") or has_short_flag(args, "u"):
        return "stage files by name, not with '.', -A or -u."
    for arg in args:
        # A folder stages every untracked file in it too, such as a local file with a password.
        if not arg.startswith("-") and os.path.isdir(os.path.join(repo_dir or ".", arg)):
            return f"'{arg}' is a folder. Stage files by name."
        path = arg.replace("\\", "/")
        name = path.rstrip("/").split("/")[-1]
        if name == ".env" or (name.startswith(".env.") and not name.endswith(".example")):
            return f"'{arg}' is a secret file. Never stage .env files."
        if "__pycache__" in path.split("/") or name.endswith(".pyc"):
            return f"'{arg}' is a generated file. Never stage __pycache__ or .pyc."
    return None


CHECKS = {
    "push": check_push,
    "commit": check_commit,
    "reset": check_reset,
    "clean": check_clean,
    "branch": check_branch,
    "add": check_add,
}


def main():
    try:
        # utf-8-sig also accepts input that starts with a BOM (PowerShell adds one).
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        command = payload["tool_input"]["command"]
    except (ValueError, KeyError, TypeError):
        return 0  # Not a shell call we understand: never block on a parse problem.

    for words in split_statements(command):
        if os.path.basename(words[0]).lower() not in ("git", "git.exe"):
            continue
        repo_dir, subcommand, args = parse_git(words)
        check = CHECKS.get(subcommand)
        reason = check(args, repo_dir) if check else None
        if reason:
            print(f"Blocked by .claude/hooks/git_guard.py: git {subcommand}: {reason}", file=sys.stderr)
            return 2
        target = switch_target(subcommand, args)
        if target:
            SWITCHED[repo_dir] = target
    return 0


if __name__ == "__main__":
    sys.exit(main())
