#!/usr/bin/env python3
"""Validate a task-scoped commit plan against live Git state.

Input uses the plan schema declared by contract/git-lifecycle.json. The validator is read-only: it never
stages, commits, rewrites, pushes, merges, tags, or deletes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any


CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contract" / "git-lifecycle.json"
try:
    CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise RuntimeError(f"cannot load canonical Git lifecycle contract: {exc}") from exc

SCHEMA_VERSION = CONTRACT["plan_schema_version"]
PHASES = {"precommit", "postcommit", "closure"}
MODES = {"regular", "hotfix", "release"}
TYPES = set(CONTRACT["work_branch_prefixes"])
ROOT_KEYS = {
    "schema_version",
    "phase",
    "mode",
    "repository",
    "scope_paths",
    "message",
    "wrike_task_ids",
    "history_rewrite",
    "lifecycle",
}
HISTORY_KEYS = {
    "published",
    "approval_ref",
    "remote",
    "remote_ref",
    "expected_remote_oid",
}
LIFECYCLE_KEYS = {
    "version",
    "base_tag",
    "major_approval_ref",
    "lane_branch",
    "lane_commit",
    "child_branch",
    "work_base_commit",
    "lane_base_commit",
    "commit_role",
    "pr",
    "production_branch",
    "develop_branch",
    "production_before",
    "develop_before",
    "production_merge",
    "develop_merge",
    "tag",
    "remote",
    "retain_branches",
}
PR_KEYS = {
    "number",
    "url",
    "state",
    "head_branch",
    "base_branch",
    "head_commit",
    "merge_commit",
    "readback_ref",
}
SUBJECT_RE = re.compile(
    rf"^({'|'.join(re.escape(item) for item in CONTRACT['work_branch_prefixes'])}): (.+)$"
)
SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
SEMVER_TAG_RE = re.compile(
    r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"
)
OID_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
APPROVAL_REF_RE = re.compile(r"^(?:turn|message):\S+$")
REF_RE = re.compile(r"^refs #([1-9]\d*) @0$")
URL_REF_RE = re.compile(
    r"https?://|open\.htm\?id=|^\s*(?:refs|wrike)\s*:",
    re.IGNORECASE | re.MULTILINE,
)


class PlanError(RuntimeError):
    pass


def _error(errors: list[dict[str, str]], code: str, path: str, message: str) -> None:
    errors.append({"code": code, "path": path, "message": message})


def _exact_keys(
    value: Any,
    expected: set[str],
    path: str,
    errors: list[dict[str, str]],
) -> dict[str, Any]:
    if not isinstance(value, dict):
        _error(errors, "TYPE", path, "must be an object")
        return {}
    actual = set(value)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing:
        _error(errors, "MISSING_FIELD", path, f"missing: {', '.join(missing)}")
    if extra:
        _error(errors, "UNSUPPORTED_FIELD", path, f"unsupported: {', '.join(extra)}")
    return value


def _decode(data: bytes, label: str) -> str:
    try:
        return data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise PlanError(f"{label} is not valid UTF-8: {exc}") from exc


def _git(repo: Path, *args: str) -> tuple[int, str, str]:
    env = os.environ.copy()
    env.update(
        {
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_OPTIONAL_LOCKS": "0",
            "LC_ALL": "C",
            "LANG": "C",
        }
    )
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=env,
    )
    return (
        result.returncode,
        _decode(result.stdout, "git stdout"),
        _decode(result.stderr, "git stderr"),
    )


def _git_value(repo: Path, *args: str) -> str:
    code, stdout, stderr = _git(repo, *args)
    if code != 0:
        raise PlanError(f"git {' '.join(args)} failed ({code}): {stderr.strip()}")
    return stdout.strip()


def _normalize_path(value: Any, path: str, errors: list[dict[str, str]]) -> str | None:
    if not isinstance(value, str) or not value.strip():
        _error(errors, "PATH", path, "must be a non-empty relative path")
        return None
    normalized = value.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        _error(errors, "PATH", path, "must stay inside the repository")
        return None
    return pure.as_posix()


def _string_list(
    value: Any,
    path: str,
    errors: list[dict[str, str]],
    *,
    allow_empty: bool,
) -> list[str]:
    if (
        not isinstance(value, list)
        or (not allow_empty and not value)
        or any(not isinstance(item, str) or not item for item in value)
    ):
        _error(errors, "TYPE", path, "must be a list of non-empty strings")
        return []
    if len(value) != len(set(value)):
        _error(errors, "DUPLICATE", path, "must not contain duplicates")
    return list(value)


def _normalize_message(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")


def _validate_message(
    value: Any,
    wrike_ids: list[str],
    errors: list[dict[str, str]],
) -> str | None:
    if not isinstance(value, str) or not value:
        _error(errors, "MESSAGE", "$.message", "must be a non-empty string")
        return None
    if "\x00" in value:
        _error(errors, "MESSAGE_NUL", "$.message", "must not contain NUL")
        return None
    message = _normalize_message(value)
    lines = message.split("\n")
    if any(line.rstrip() != line for line in lines):
        _error(errors, "MESSAGE_WHITESPACE", "$.message", "lines must not end in whitespace")
    first = SUBJECT_RE.fullmatch(lines[0])
    if not first:
        _error(
            errors,
            "MESSAGE_SUBJECT",
            "$.message",
            "first line must be "
            f"<{'|'.join(CONTRACT['work_branch_prefixes'])}>: <subject>",
        )
    elif len(first.group(2)) > 50:
        _error(errors, "SUBJECT_LENGTH", "$.message", "subject must be at most 50 characters")
    if URL_REF_RE.search(message):
        _error(errors, "URL_REFS", "$.message", "URL-shaped or labeled refs are forbidden")
    body = lines[1:]
    if body and body[0] != "":
        _error(errors, "BODY_SEPARATOR", "$.message", "body must follow one blank line")
    body = body[1:] if body else []
    while body and body[-1] == "":
        body.pop()
    ref_start = len(body)
    while ref_start and REF_RE.fullmatch(body[ref_start - 1]):
        ref_start -= 1
    body_lines = [line for line in body[:ref_start] if line]
    ref_lines = body[ref_start:]
    if any(REF_RE.fullmatch(line) for line in body[:ref_start]):
        _error(errors, "REFS_POSITION", "$.message", "refs lines must be the final body lines")
    actual_ids = [
        match.group(1)
        for line in ref_lines
        if (match := REF_RE.fullmatch(line)) is not None
    ]
    if actual_ids != wrike_ids:
        _error(
            errors,
            "WRIKE_REFS",
            "$.message",
            "final refs lines must exactly match wrike_task_ids in order",
        )
    if len(body_lines) > 3:
        _error(errors, "BODY_LENGTH", "$.message", "non-refs body is limited to three lines")
    return message


def _validate_branch(repo: Path, value: Any, path: str, errors: list[dict[str, str]]) -> str:
    if not isinstance(value, str) or not value:
        _error(errors, "BRANCH", path, "must be a non-empty branch name")
        return ""
    code, _, _ = _git(repo, "check-ref-format", "--branch", value)
    if code != 0:
        _error(errors, "BRANCH", path, "is not a valid Git branch name")
    return value


def _validate_oid(
    value: Any,
    path: str,
    errors: list[dict[str, str]],
    *,
    required: bool,
) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or OID_RE.fullmatch(value) is None:
        _error(errors, "OBJECT_ID", path, "must be a full lowercase Git object ID")
        return None
    return value


def _validate_pr(
    repo: Path,
    phase: str,
    mode: str,
    lifecycle: dict[str, Any],
    errors: list[dict[str, str]],
) -> dict[str, Any] | None:
    value = lifecycle.get("pr")
    if phase != "closure" and value is None:
        return None
    pr = _exact_keys(value, PR_KEYS, "$.lifecycle.pr", errors)
    if not pr:
        if phase == "closure":
            _error(errors, "PR_REQUIRED", "$.lifecycle.pr", "closure requires merged PR read-back")
        return None
    if not isinstance(pr.get("number"), int) or pr["number"] <= 0:
        _error(errors, "PR_NUMBER", "$.lifecycle.pr.number", "must be a positive integer")
    if not isinstance(pr.get("url"), str) or not pr["url"].startswith("https://"):
        _error(errors, "PR_URL", "$.lifecycle.pr.url", "must be an https URL")
    if pr.get("state") != "merged":
        _error(errors, "PR_STATE", "$.lifecycle.pr.state", "must equal merged")
    if pr.get("head_branch") != lifecycle.get("child_branch"):
        _error(errors, "PR_HEAD", "$.lifecycle.pr.head_branch", "must equal child_branch")
    lane_contract = CONTRACT["lanes"][mode]
    expected_base = (
        lifecycle.get("lane_branch")
        if lane_contract["pr_base"] == "lane"
        else lifecycle.get("develop_branch")
    )
    if pr.get("base_branch") != expected_base:
        _error(errors, "PR_BASE", "$.lifecycle.pr.base_branch", f"must equal {expected_base}")
    head_commit = _validate_oid(
        pr.get("head_commit"),
        "$.lifecycle.pr.head_commit",
        errors,
        required=True,
    )
    merge_commit = _validate_oid(
        pr.get("merge_commit"),
        "$.lifecycle.pr.merge_commit",
        errors,
        required=True,
    )
    if not isinstance(pr.get("readback_ref"), str) or not pr["readback_ref"].strip():
        _error(
            errors,
            "PR_READBACK",
            "$.lifecycle.pr.readback_ref",
            "must identify the provider read-back evidence",
        )
    for path, oid in (
        ("$.lifecycle.pr.head_commit", head_commit),
        ("$.lifecycle.pr.merge_commit", merge_commit),
    ):
        if oid is not None:
            code, _, _ = _git(repo, "cat-file", "-e", f"{oid}^{{commit}}")
            if code != 0:
                _error(errors, "PR_COMMIT", path, "commit is not present in the repository")
    return pr


def _validate_lifecycle(
    repo: Path,
    phase: str,
    mode: str,
    value: Any,
    errors: list[dict[str, str]],
) -> dict[str, Any] | None:
    if mode == "regular":
        if value is not None:
            _error(errors, "LIFECYCLE_FORBIDDEN", "$.lifecycle", "regular mode requires null")
        return None
    lifecycle = _exact_keys(value, LIFECYCLE_KEYS, "$.lifecycle", errors)
    version = lifecycle.get("version")
    version_match = SEMVER_RE.fullmatch(version) if isinstance(version, str) else None
    if version_match is None:
        _error(errors, "VERSION", "$.lifecycle.version", "must be X.Y.Z without a v prefix")
        version = ""
    version_parts = (
        tuple(int(part) for part in version_match.groups())
        if version_match is not None
        else None
    )
    base_tag = lifecycle.get("base_tag")
    base_match = (
        SEMVER_TAG_RE.fullmatch(base_tag) if isinstance(base_tag, str) else None
    )
    if base_tag is not None and base_match is None:
        _error(errors, "BASE_TAG", "$.lifecycle.base_tag", "must be null or vX.Y.Z")
    base_parts = (
        tuple(int(part) for part in base_match.groups())
        if base_match is not None
        else None
    )
    major_approval_ref = lifecycle.get("major_approval_ref")
    if major_approval_ref is not None and (
        not isinstance(major_approval_ref, str)
        or APPROVAL_REF_RE.fullmatch(major_approval_ref) is None
    ):
        _error(
            errors,
            "MAJOR_APPROVAL",
            "$.lifecycle.major_approval_ref",
            "must be null or an exact turn:/message: reference",
        )
    if version_parts is not None:
        if base_parts is None:
            if mode != "release" or version_parts != (1, 0, 0):
                _error(
                    errors,
                    "VERSION_LANE",
                    "$.lifecycle.version",
                    "a missing base_tag is allowed only for the initial release 1.0.0",
                )
            if major_approval_ref is not None:
                _error(
                    errors,
                    "MAJOR_APPROVAL",
                    "$.lifecycle.major_approval_ref",
                    "initial release must not claim major approval",
                )
        elif mode == "hotfix":
            expected = (base_parts[0], base_parts[1], base_parts[2] + 1)
            if version_parts != expected:
                _error(
                    errors,
                    "VERSION_LANE",
                    "$.lifecycle.version",
                    f"hotfix must increment patch to {'.'.join(map(str, expected))}",
                )
            if major_approval_ref is not None:
                _error(
                    errors,
                    "MAJOR_APPROVAL",
                    "$.lifecycle.major_approval_ref",
                    "hotfix must not claim major approval",
                )
        else:
            minor = (base_parts[0], base_parts[1] + 1, 0)
            major = (base_parts[0] + 1, 0, 0)
            if version_parts == minor:
                if major_approval_ref is not None:
                    _error(
                        errors,
                        "MAJOR_APPROVAL",
                        "$.lifecycle.major_approval_ref",
                        "minor release must not claim major approval",
                    )
            elif version_parts == major:
                if not isinstance(major_approval_ref, str) or not major_approval_ref:
                    _error(
                        errors,
                        "MAJOR_APPROVAL",
                        "$.lifecycle.major_approval_ref",
                        "major release requires an exact approval reference",
                    )
            else:
                _error(
                    errors,
                    "VERSION_LANE",
                    "$.lifecycle.version",
                    "release must increment minor, or approved major, and reset lower parts",
                )
    lane = _validate_branch(repo, lifecycle.get("lane_branch"), "$.lifecycle.lane_branch", errors)
    child = _validate_branch(
        repo,
        lifecycle.get("child_branch"),
        "$.lifecycle.child_branch",
        errors,
    )
    production = _validate_branch(
        repo,
        lifecycle.get("production_branch"),
        "$.lifecycle.production_branch",
        errors,
    )
    develop = _validate_branch(
        repo,
        lifecycle.get("develop_branch"),
        "$.lifecycle.develop_branch",
        errors,
    )
    lane_contract = CONTRACT["lanes"][mode]
    expected_lane = lane_contract["branch_template"].format(version=version)
    if version and lane != expected_lane:
        _error(errors, "LANE_BRANCH", "$.lifecycle.lane_branch", f"must equal {expected_lane}")
    lane_commit = _validate_oid(
        lifecycle.get("lane_commit"),
        "$.lifecycle.lane_commit",
        errors,
        required=phase == "closure",
    )
    if phase == "closure" and lane_commit is None:
        _error(
            errors,
            "LANE_COMMIT",
            "$.lifecycle.lane_commit",
            "closure requires the lane tip recorded before parent merges",
        )
    expected_tag = CONTRACT["tag_template"].format(version=version)
    if version and lifecycle.get("tag") != expected_tag:
        _error(errors, "TAG", "$.lifecycle.tag", f"must equal {expected_tag}")
    expected_child = tuple(f"{prefix}/" for prefix in CONTRACT["work_branch_prefixes"])
    if not child.startswith(expected_child):
        _error(
            errors,
            "CHILD_BRANCH",
            "$.lifecycle.child_branch",
            "work branch must use "
            f"{'|'.join(CONTRACT['work_branch_prefixes'])} prefix",
        )
    if len({lane, child, production, develop}) != 4:
        _error(
            errors,
            "BRANCH_COLLISION",
            "$.lifecycle",
            "lane, child, and parent branches must differ",
        )
    remote = lifecycle.get("remote")
    if not isinstance(remote, str) or not remote:
        _error(errors, "REMOTE", "$.lifecycle.remote", "must be a non-empty remote name")
    retain = _string_list(
        lifecycle.get("retain_branches"),
        "$.lifecycle.retain_branches",
        errors,
        allow_empty=True,
    )
    if any(item not in {lane, child} for item in retain):
        _error(
            errors,
            "RETAIN_BRANCH",
            "$.lifecycle.retain_branches",
            "may contain only lane or child",
        )
    commit_role = lifecycle.get("commit_role")
    allowed_roles = {"work", "closure"}
    if mode == "release":
        allowed_roles.add("release_metadata")
    if commit_role not in allowed_roles:
        _error(
            errors,
            "COMMIT_ROLE",
            "$.lifecycle.commit_role",
            f"must be one of {sorted(allowed_roles)}",
        )
    if phase == "closure" and commit_role != "closure":
        _error(errors, "COMMIT_ROLE", "$.lifecycle.commit_role", "closure phase requires closure")
    if phase != "closure" and commit_role == "closure":
        _error(errors, "COMMIT_ROLE", "$.lifecycle.commit_role", "commit phases cannot use closure")
    for field in (
        "work_base_commit",
        "lane_base_commit",
        "production_before",
        "develop_before",
        "production_merge",
        "develop_merge",
    ):
        _validate_oid(
            lifecycle.get(field),
            f"$.lifecycle.{field}",
            errors,
            required=phase == "closure",
        )
    _validate_pr(repo, phase, mode, lifecycle, errors)
    return lifecycle


def _validate_history(
    repo: Path,
    value: Any,
    errors: list[dict[str, str]],
    evidence: list[str],
) -> dict[str, Any]:
    history = _exact_keys(value, HISTORY_KEYS, "$.history_rewrite", errors)
    published = history.get("published")
    if not isinstance(published, bool):
        _error(errors, "TYPE", "$.history_rewrite.published", "must be a boolean")
        return history
    details = {
        key: history.get(key)
        for key in ("approval_ref", "remote", "remote_ref", "expected_remote_oid")
    }
    if not published:
        if any(item is not None for item in details.values()):
            _error(
                errors,
                "HISTORY_REWRITE_FIELDS",
                "$.history_rewrite",
                "unpublished history requires null approval and remote fields",
            )
        return history
    approval_ref = details["approval_ref"]
    remote = details["remote"]
    remote_ref = details["remote_ref"]
    expected_oid = details["expected_remote_oid"]
    if not isinstance(approval_ref, str) or APPROVAL_REF_RE.fullmatch(approval_ref) is None:
        _error(
            errors,
            "HISTORY_REWRITE_APPROVAL",
            "$.history_rewrite.approval_ref",
            "published history rewrite requires an exact turn:/message: approval reference",
        )
    if not isinstance(remote, str) or not remote:
        _error(errors, "HISTORY_REMOTE", "$.history_rewrite.remote", "must name the remote")
    if not isinstance(remote_ref, str) or not remote_ref.startswith("refs/heads/"):
        _error(
            errors,
            "HISTORY_REMOTE_REF",
            "$.history_rewrite.remote_ref",
            "must be a fully qualified refs/heads/* ref",
        )
    elif _git(repo, "check-ref-format", remote_ref)[0] != 0:
        _error(
            errors,
            "HISTORY_REMOTE_REF",
            "$.history_rewrite.remote_ref",
            "is not a valid Git ref",
        )
    if not isinstance(expected_oid, str) or OID_RE.fullmatch(expected_oid) is None:
        _error(
            errors,
            "HISTORY_REMOTE_OID",
            "$.history_rewrite.expected_remote_oid",
            "must be a full lowercase Git object ID",
        )
    if any(
        code in {
            "HISTORY_REWRITE_APPROVAL",
            "HISTORY_REMOTE",
            "HISTORY_REMOTE_REF",
            "HISTORY_REMOTE_OID",
        }
        for code in (item["code"] for item in errors)
    ):
        return history
    code, stdout, stderr = _git(repo, "ls-remote", "--refs", remote, remote_ref)
    if code != 0:
        _error(errors, "HISTORY_REMOTE_READ", "$.history_rewrite.remote", stderr.strip())
        return history
    lines = [line.split("\t", 1) for line in stdout.splitlines() if line]
    actual = next((sha for sha, ref in lines if ref == remote_ref), None)
    if actual != expected_oid:
        _error(
            errors,
            "HISTORY_REMOTE_SHA",
            "$.history_rewrite.expected_remote_oid",
            "live remote ref differs from the approved expected SHA",
        )
    else:
        evidence.append(f"history_remote={remote}:{remote_ref}@{actual}")
    return history


def _nul_paths(stdout: str) -> list[str]:
    return [item.replace("\\", "/") for item in stdout.split("\0") if item]


def _verify_repo(
    value: Any,
    errors: list[dict[str, str]],
) -> Path | None:
    if not isinstance(value, str) or not value:
        _error(errors, "REPOSITORY", "$.repository", "must be a non-empty path")
        return None
    repo = Path(value).expanduser().resolve()
    if not repo.is_dir():
        _error(errors, "REPOSITORY", "$.repository", "directory does not exist")
        return None
    try:
        root = Path(_git_value(repo, "rev-parse", "--show-toplevel")).resolve()
    except PlanError as exc:
        _error(errors, "REPOSITORY", "$.repository", str(exc))
        return None
    if os.path.normcase(str(root)) != os.path.normcase(str(repo)):
        _error(errors, "REPOSITORY_ROOT", "$.repository", f"must equal Git root {root}")
        return None
    return repo


def _verify_current_branch(
    repo: Path,
    lifecycle: dict[str, Any] | None,
    mode: str,
    errors: list[dict[str, str]],
) -> str:
    code, stdout, _ = _git(repo, "symbolic-ref", "--quiet", "--short", "HEAD")
    if code != 0:
        _error(errors, "DETACHED_HEAD", "$.repository", "HEAD must be attached to a branch")
        return ""
    branch = stdout.strip()
    allowed: set[str] = set()
    if lifecycle is not None:
        role = lifecycle["commit_role"]
        if role == "work":
            allowed.add(lifecycle["child_branch"])
        elif role == "release_metadata" and mode == "release":
            allowed.add(lifecycle["lane_branch"])
    if lifecycle is not None and branch not in allowed:
        _error(
            errors,
            "CURRENT_BRANCH",
            "$.repository",
            f"{lifecycle['commit_role']} commit must be on one of {sorted(allowed)}",
        )
    return branch


def _verify_precommit(
    repo: Path,
    scope: set[str],
    lifecycle: dict[str, Any] | None,
    mode: str,
    errors: list[dict[str, str]],
    evidence: list[str],
) -> None:
    branch = _verify_current_branch(repo, lifecycle, mode, errors)
    code, stdout, stderr = _git(
        repo,
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "--diff-filter=ACMRDTUXB",
    )
    if code != 0:
        _error(errors, "STAGED_READ", "$.repository", stderr.strip())
        return
    staged = _nul_paths(stdout)
    if not staged:
        _error(errors, "STAGED_EMPTY", "$.scope_paths", "no staged changes")
    outside = sorted(set(staged) - scope)
    if outside:
        _error(errors, "STAGED_SCOPE", "$.scope_paths", f"unscoped staged paths: {outside}")
    check_code, _, check_stderr = _git(repo, "diff", "--cached", "--check")
    if check_code != 0:
        _error(errors, "DIFF_CHECK", "$.repository", check_stderr.strip())
    evidence.extend([f"branch={branch}", f"staged_paths={','.join(staged)}"])


def _verify_postcommit(
    repo: Path,
    scope: set[str],
    lifecycle: dict[str, Any] | None,
    mode: str,
    expected_message: str | None,
    errors: list[dict[str, str]],
    evidence: list[str],
) -> None:
    branch = _verify_current_branch(repo, lifecycle, mode, errors)
    code, stdout, stderr = _git(repo, "show", "-s", "--format=%B", "HEAD")
    if code != 0:
        raise PlanError(f"git show failed ({code}): {stderr.strip()}")
    actual = _normalize_message(stdout)
    if expected_message is not None and actual != expected_message:
        _error(
            errors,
            "POSTCOMMIT_MESSAGE",
            "$.message",
            "HEAD message differs from the validated message",
        )
    changed = _nul_paths(
        _git_value(
            repo,
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            "HEAD",
        )
    )
    if not changed:
        _error(errors, "POSTCOMMIT_EMPTY", "$.repository", "HEAD has no changed paths")
    outside = sorted(set(changed) - scope)
    if outside:
        _error(errors, "POSTCOMMIT_SCOPE", "$.scope_paths", f"HEAD has unscoped paths: {outside}")
    parents = _git_value(repo, "rev-list", "--parents", "-n", "1", "HEAD").split()
    if len(parents) > 2:
        _error(errors, "POSTCOMMIT_MERGE", "$.repository", "HEAD must be a modification commit")
    head = _git_value(repo, "rev-parse", "HEAD")
    evidence.extend([f"branch={branch}", f"head={head}", f"changed_paths={','.join(changed)}"])


def _branch_exists(repo: Path, branch: str) -> bool:
    code, _, _ = _git(repo, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}")
    if code not in {0, 1}:
        raise PlanError(f"failed to inspect local branch {branch}")
    return code == 0


def _merge_parent_count(repo: Path, ref: str) -> int:
    return len(_git_value(repo, "rev-list", "--parents", "-n", "1", ref).split()) - 1


def _merge_parents(repo: Path, ref: str) -> list[str]:
    return _git_value(repo, "rev-list", "--parents", "-n", "1", ref).split()[1:]


def _remote_refs(repo: Path, remote: str) -> dict[str, str]:
    code, stdout, stderr = _git(repo, "ls-remote", "--heads", "--tags", remote)
    if code != 0:
        raise PlanError(f"git ls-remote failed ({code}): {stderr.strip()}")
    refs: dict[str, str] = {}
    for line in stdout.splitlines():
        if not line:
            continue
        sha, ref = line.split("\t", 1)
        refs[ref] = sha
    return refs


def _verify_closure(
    repo: Path,
    lifecycle: dict[str, Any],
    errors: list[dict[str, str]],
    evidence: list[str],
) -> None:
    code, stdout, stderr = _git(repo, "status", "--porcelain=v1", "-z")
    if code != 0:
        _error(errors, "STATUS_READ", "$.repository", stderr.strip())
    elif stdout:
        _error(errors, "WORKTREE_DIRTY", "$.repository", "closure requires a clean worktree")
    production = lifecycle["production_branch"]
    develop = lifecycle["develop_branch"]
    lane_commit = lifecycle["lane_commit"]
    tag = lifecycle["tag"]
    try:
        production_head = _git_value(repo, "rev-parse", f"refs/heads/{production}")
        develop_head = _git_value(repo, "rev-parse", f"refs/heads/{develop}")
        resolved_lane_commit = _git_value(
            repo,
            "rev-parse",
            "--verify",
            f"{lane_commit}^{{commit}}",
        )
        tag_object_type = _git_value(repo, "cat-file", "-t", f"refs/tags/{tag}")
        tag_commit = _git_value(repo, "rev-parse", f"refs/tags/{tag}^{{}}")
    except PlanError as exc:
        _error(errors, "CLOSURE_REF", "$.lifecycle", str(exc))
        return
    if tag_object_type != "tag":
        _error(errors, "ANNOTATED_TAG", "$.lifecycle.tag", "tag must be annotated")
    if resolved_lane_commit != lane_commit:
        _error(
            errors,
            "LANE_COMMIT",
            "$.lifecycle.lane_commit",
            "must be the exact full object ID of a commit",
        )
    if tag_commit != production_head:
        _error(errors, "TAG_TARGET", "$.lifecycle.tag", "tag must peel to production HEAD")
    if production_head != lifecycle["production_merge"]:
        _error(
            errors,
            "PRODUCTION_MERGE",
            "$.lifecycle.production_merge",
            "must equal production HEAD",
        )
    if develop_head != lifecycle["develop_merge"]:
        _error(
            errors,
            "DEVELOP_MERGE",
            "$.lifecycle.develop_merge",
            "must equal develop HEAD",
        )
    production_parents = _merge_parents(repo, f"refs/heads/{production}")
    expected_production_parents = [lifecycle["production_before"], lane_commit]
    if production_parents != expected_production_parents:
        _error(
            errors,
            "PRODUCTION_MERGE_PARENTS",
            "$.lifecycle.production_merge",
            f"parents must exactly equal {expected_production_parents}",
        )
    develop_parents = _merge_parents(repo, f"refs/heads/{develop}")
    expected_develop_parents = [lifecycle["develop_before"], lane_commit]
    if develop_parents != expected_develop_parents:
        _error(
            errors,
            "DEVELOP_MERGE_PARENTS",
            "$.lifecycle.develop_merge",
            f"parents must exactly equal {expected_develop_parents}",
        )
    lane_contract = CONTRACT["lanes"][lifecycle["lane_branch"].split("/", 1)[0]]
    pr = lifecycle["pr"]
    expected_lane_base = (
        lifecycle["production_before"]
        if lane_contract["lane_base"] == "production"
        else pr["merge_commit"]
    )
    if lifecycle["lane_base_commit"] != expected_lane_base:
        _error(
            errors,
            "LANE_BASE",
            "$.lifecycle.lane_base_commit",
            f"must equal {expected_lane_base}",
        )
    expected_work_base = (
        lifecycle["lane_base_commit"]
        if lane_contract["work_branch_base"] == "lane"
        else lifecycle["work_base_commit"]
    )
    if lane_contract["work_branch_base"] == "lane" and lifecycle["work_base_commit"] != expected_work_base:
        _error(
            errors,
            "WORK_BASE",
            "$.lifecycle.work_base_commit",
            "hotfix work branch must start from the hotfix lane base",
        )
    if lane_contract["lane_base"] == "updated_develop" and lifecycle["develop_before"] != pr["merge_commit"]:
        _error(
            errors,
            "RELEASE_LANE_BASE",
            "$.lifecycle.develop_before",
            "release lane must start after the work PR is merged to develop",
        )
    for code_name, older, newer, path, message in (
        (
            "WORK_BASE",
            lifecycle["work_base_commit"],
            pr["head_commit"],
            "$.lifecycle.work_base_commit",
            "work base must be an ancestor of the PR head commit",
        ),
        (
            "PR_MERGE_REACHABILITY",
            pr["merge_commit"],
            lane_commit,
            "$.lifecycle.pr.merge_commit",
            "PR merge commit must be an ancestor of the final lane commit",
        ),
    ):
        ancestor_code, _, ancestor_stderr = _git(
            repo,
            "merge-base",
            "--is-ancestor",
            older,
            newer,
        )
        if ancestor_code == 1:
            _error(errors, code_name, path, message)
        elif ancestor_code != 0:
            raise PlanError(
                f"git merge-base --is-ancestor failed ({ancestor_code}): "
                f"{ancestor_stderr.strip()}"
            )
    for path, branch, head in (
        ("$.lifecycle.production_branch", production, production_head),
        ("$.lifecycle.develop_branch", develop, develop_head),
    ):
        ancestor_code, _, ancestor_stderr = _git(
            repo,
            "merge-base",
            "--is-ancestor",
            lane_commit,
            head,
        )
        if ancestor_code == 1:
            _error(
                errors,
                "LANE_REACHABILITY",
                path,
                f"{branch} must contain lane_commit",
            )
        elif ancestor_code != 0:
            raise PlanError(
                f"git merge-base --is-ancestor failed ({ancestor_code}): "
                f"{ancestor_stderr.strip()}"
            )
    retain = set(lifecycle["retain_branches"])
    for branch in (lifecycle["lane_branch"], lifecycle["child_branch"]):
        if branch not in retain and _branch_exists(repo, branch):
            _error(errors, "LOCAL_CLEANUP", "$.lifecycle", f"local branch remains: {branch}")
    try:
        remote = _remote_refs(repo, lifecycle["remote"])
    except PlanError as exc:
        _error(errors, "REMOTE_READ", "$.lifecycle.remote", str(exc))
        return
    expected = {
        f"refs/heads/{production}": production_head,
        f"refs/heads/{develop}": develop_head,
        f"refs/tags/{tag}^{{}}": production_head,
    }
    for ref, sha in expected.items():
        if remote.get(ref) != sha:
            _error(errors, "REMOTE_REACHABILITY", "$.lifecycle.remote", f"{ref} mismatch")
    for branch in (lifecycle["lane_branch"], lifecycle["child_branch"]):
        if branch not in retain and f"refs/heads/{branch}" in remote:
            _error(errors, "REMOTE_CLEANUP", "$.lifecycle", f"remote branch remains: {branch}")
    evidence.extend(
        [
            f"production_head={production_head}",
            f"develop_head={develop_head}",
            f"lane_commit={lane_commit}",
            f"annotated_tag={tag}",
            f"remote={lifecycle['remote']}",
        ]
    )


def _verify_version_base(
    repo: Path,
    phase: str,
    lifecycle: dict[str, Any],
    errors: list[dict[str, str]],
    evidence: list[str],
) -> None:
    base_tag = lifecycle["base_tag"]
    target_tag = lifecycle["tag"]
    code, stdout, stderr = _git(repo, "tag", "--list")
    if code != 0:
        raise PlanError(f"git tag --list failed ({code}): {stderr.strip()}")
    semver_tags = {
        tag for tag in stdout.splitlines() if SEMVER_TAG_RE.fullmatch(tag) is not None
    }
    if base_tag is None:
        unexpected = sorted(semver_tags - {target_tag})
        if unexpected:
            _error(
                errors,
                "BASE_TAG",
                "$.lifecycle.base_tag",
                f"initial release requires no prior semver tags: {unexpected}",
            )
        return
    try:
        base_commit = _git_value(repo, "rev-parse", "--verify", f"{base_tag}^{{commit}}")
        production_head = _git_value(
            repo,
            "rev-parse",
            f"refs/heads/{lifecycle['production_branch']}",
        )
    except PlanError as exc:
        _error(errors, "BASE_TAG", "$.lifecycle.base_tag", str(exc))
        return
    if phase in {"precommit", "postcommit"}:
        if base_commit != production_head:
            _error(
                errors,
                "BASE_PRODUCTION",
                "$.lifecycle.base_tag",
                "base_tag must peel to the current production head",
            )
    else:
        ancestor_code, _, ancestor_stderr = _git(
            repo,
            "merge-base",
            "--is-ancestor",
            base_commit,
            production_head,
        )
        if ancestor_code == 1:
            _error(
                errors,
                "BASE_REACHABILITY",
                "$.lifecycle.base_tag",
                "base_tag must be an ancestor of production",
            )
        elif ancestor_code != 0:
            raise PlanError(
                f"git merge-base --is-ancestor failed ({ancestor_code}): "
                f"{ancestor_stderr.strip()}"
            )
    evidence.append(f"base_tag={base_tag}@{base_commit}")


def validate(plan: Any) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    evidence: list[str] = []
    root = _exact_keys(plan, ROOT_KEYS, "$", errors)
    if root.get("schema_version") != SCHEMA_VERSION:
        _error(errors, "SCHEMA_VERSION", "$.schema_version", f"must equal {SCHEMA_VERSION}")
    phase = root.get("phase")
    mode = root.get("mode")
    if phase not in PHASES:
        _error(errors, "PHASE", "$.phase", f"must be one of {sorted(PHASES)}")
    if mode not in MODES:
        _error(errors, "MODE", "$.mode", f"must be one of {sorted(MODES)}")
    repo = _verify_repo(root.get("repository"), errors)
    scope_values = _string_list(root.get("scope_paths"), "$.scope_paths", errors, allow_empty=False)
    scope = {
        normalized
        for index, value in enumerate(scope_values)
        if (normalized := _normalize_path(value, f"$.scope_paths[{index}]", errors))
        is not None
    }
    wrike_ids = _string_list(
        root.get("wrike_task_ids"),
        "$.wrike_task_ids",
        errors,
        allow_empty=True,
    )
    if any(not item.isdigit() or item.startswith("0") for item in wrike_ids):
        _error(errors, "WRIKE_ID", "$.wrike_task_ids", "IDs must contain non-zero decimal digits")
    if repo is not None:
        _validate_history(repo, root.get("history_rewrite"), errors, evidence)
    else:
        _exact_keys(root.get("history_rewrite"), HISTORY_KEYS, "$.history_rewrite", errors)
    lifecycle = (
        _validate_lifecycle(repo, phase, mode, root.get("lifecycle"), errors)
        if repo is not None and mode in MODES
        else None
    )
    message: str | None = None
    if phase in {"precommit", "postcommit"}:
        message = _validate_message(root.get("message"), wrike_ids, errors)
        if (
            lifecycle is not None
            and lifecycle.get("commit_role") == "release_metadata"
            and message is not None
            and message.split(":", 1)[0]
            not in set(CONTRACT["lanes"]["release"]["allowed_lane_commit_types"])
        ):
            _error(
                errors,
                "RELEASE_METADATA_TYPE",
                "$.message",
                "release lane permits only "
                f"{'|'.join(CONTRACT['lanes']['release']['allowed_lane_commit_types'])} "
                "metadata commits",
            )
    elif phase == "closure" and root.get("message") is not None:
        _error(errors, "MESSAGE_FORBIDDEN", "$.message", "closure requires null")
    if errors or repo is None or phase not in PHASES or mode not in MODES:
        return {
            "valid": False,
            "schema_version": SCHEMA_VERSION,
            "phase": phase,
            "mode": mode,
            "errors": errors,
            "evidence": evidence,
        }
    try:
        if lifecycle is not None:
            _verify_version_base(repo, phase, lifecycle, errors, evidence)
        if phase == "precommit":
            _verify_precommit(repo, scope, lifecycle, mode, errors, evidence)
        elif phase == "postcommit":
            _verify_postcommit(repo, scope, lifecycle, mode, message, errors, evidence)
        elif mode == "regular" or lifecycle is None:
            _error(errors, "CLOSURE_MODE", "$.mode", "closure requires hotfix or release")
        else:
            _verify_closure(repo, lifecycle, errors, evidence)
    except PlanError as exc:
        _error(errors, "GIT_RUNTIME", "$.repository", str(exc))
    return {
        "valid": not errors,
        "schema_version": SCHEMA_VERSION,
        "phase": phase,
        "mode": mode,
        "errors": errors,
        "evidence": evidence,
    }


def _example(mode: str) -> dict[str, Any]:
    lifecycle = None
    if mode in {"hotfix", "release"}:
        version = "1.2.3" if mode == "hotfix" else "1.3.0"
        lifecycle = {
            "version": version,
            "base_tag": "v1.2.2" if mode == "hotfix" else "v1.2.3",
            "major_approval_ref": None,
            "lane_branch": CONTRACT["lanes"][mode]["branch_template"].format(version=version),
            "lane_commit": None,
            "child_branch": "fix/example" if mode == "hotfix" else "feat/example",
            "work_base_commit": None,
            "lane_base_commit": None,
            "commit_role": "work",
            "pr": None,
            "production_branch": "main",
            "develop_branch": "develop",
            "production_before": None,
            "develop_before": None,
            "production_merge": None,
            "develop_merge": None,
            "tag": CONTRACT["tag_template"].format(version=version),
            "remote": "origin",
            "retain_branches": [],
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "phase": "precommit",
        "mode": mode,
        "repository": "C:/path/to/repository",
        "scope_paths": ["path/to/file"],
        "message": "fix: 변경 목적을 설명\n\nrefs #123456789 @0",
        "wrike_task_ids": ["123456789"],
        "history_rewrite": {
            "published": False,
            "approval_ref": None,
            "remote": None,
            "remote_ref": None,
            "expected_remote_oid": None,
        },
        "lifecycle": lifecycle,
    }


def main() -> int:
    if sys.platform == "win32":
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
        sys.stderr.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", nargs="?", help="JSON plan path, or - for stdin")
    parser.add_argument("--print-example", choices=sorted(MODES))
    args = parser.parse_args()
    if args.print_example:
        print(json.dumps(_example(args.print_example), ensure_ascii=False, indent=2))
        return 0
    if not args.plan:
        parser.error("plan is required unless --print-example is used")
    try:
        raw = sys.stdin.read() if args.plan == "-" else Path(args.plan).read_text(encoding="utf-8")
        plan = json.loads(raw)
        result = validate(plan)
    except (OSError, json.JSONDecodeError, PlanError) as exc:
        result = {
            "valid": False,
            "schema_version": SCHEMA_VERSION,
            "phase": None,
            "mode": None,
            "errors": [{"code": "INPUT", "path": "$", "message": str(exc)}],
            "evidence": [],
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
