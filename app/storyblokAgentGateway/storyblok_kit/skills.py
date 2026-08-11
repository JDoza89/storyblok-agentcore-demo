"""Skill fetcher — downloads s3 skills to local filesystem on first use.

Resolved paths are passed to AgentSkills(skills=...) in main.py.
Cache directory: <tmpdir>/.agents/skills/ — an absolute path under the system temp
directory (honors $TMPDIR, defaults to /tmp). The runtime working directory (e.g.
/var/task in a CodeZip runtime) is read-only, so the cache must live somewhere
guaranteed-writable.
"""

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional

_SKILLS_BASE = Path(tempfile.gettempdir()) / ".agents" / "skills"
_S3_MAX_SIZE_BYTES = 1 * 1024 * 1024 * 1024  # 1 GB


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def _cleanup(path: Path) -> None:
    """Remove a partially-created skill directory so retries don't see stale state."""
    shutil.rmtree(path, ignore_errors=True)


def _read_map(type_dir: Path) -> dict:
    map_file = type_dir / ".map.json"
    return json.loads(map_file.read_text()) if map_file.exists() else {}


def _write_map(type_dir: Path, mapping: dict) -> None:
    type_dir.mkdir(parents=True, exist_ok=True)
    (type_dir / ".map.json").write_text(json.dumps(mapping))


def _resolve_cached(type_dir: Path, source_hash: str) -> Optional[str]:
    """Return the cached skill directory for a source hash, or None if not on disk."""
    mapping = _read_map(type_dir)
    dir_name = mapping.get(source_hash)
    if dir_name and (type_dir / dir_name).exists():
        return str(type_dir / dir_name)
    return None


def _read_skill_name(skill_dir: Path) -> str:
    """Extract the skill name from SKILL.md YAML frontmatter."""
    content = (skill_dir / "SKILL.md").read_text()
    if not content.startswith("---"):
        raise ValueError(f"SKILL.md in {skill_dir} has no YAML frontmatter (must start with ---)")
    parts = content.split("---", 2)
    if len(parts) < 3:
        raise ValueError(f"SKILL.md in {skill_dir} has malformed frontmatter (missing closing ---)")
    for line in parts[1].strip().splitlines():
        if line.startswith("name:"):
            name = line[len("name:"):].strip().strip("\"'")
            if name:
                return name
    raise ValueError(f"SKILL.md in {skill_dir} is missing a 'name' field in frontmatter")


def _pick_dir_name(type_dir: Path, name: str, source_hash: str) -> str:
    """Pick a unique directory name, appending a hash suffix on collision."""
    if not (type_dir / name).exists():
        return name
    return f"{name}-{source_hash[:8]}"


def _rename_and_cache_skill(type_dir: Path, temp_dir: Path, source_hash: str, skill_root: Path,
                            source_label: str = "") -> Path:
    """Validate SKILL.md, rename the temp dir to the skill's declared name, and update the map.

    Raises ValueError if SKILL.md is missing or has invalid frontmatter.
    """
    if not (skill_root / "SKILL.md").exists():
        _cleanup(temp_dir)
        hint = f" (source: {source_label})" if source_label else ""
        raise ValueError(f"No SKILL.md found in fetched skill{hint}")

    name = _read_skill_name(skill_root)
    dir_name = _pick_dir_name(type_dir, name, source_hash)
    final_dir = type_dir / dir_name
    if final_dir != temp_dir:
        temp_dir.rename(final_dir)

    mapping = _read_map(type_dir)
    mapping[source_hash] = dir_name
    _write_map(type_dir, mapping)
    return final_dir


def _fetch_s3_skill(source: str, s3_client=None) -> Path:
    """Download an s3:// skill prefix and return the local directory."""
    uri = source if source.endswith("/") else source + "/"
    source_hash = _stable_hash(uri)
    type_dir = _SKILLS_BASE / "s3"

    cached = _resolve_cached(type_dir, source_hash)
    if cached:
        return Path(cached)

    import boto3
    client = s3_client or boto3.client("s3")
    bucket, _, prefix = uri[len("s3://"):].partition("/")
    if not bucket:
        raise ValueError(f"Invalid S3 URI (no bucket): {uri}")

    temp_dir = type_dir / source_hash
    _cleanup(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)
    temp_root = temp_dir.resolve()

    paginator = client.get_paginator("list_objects_v2")
    total = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            total += obj["Size"]
            if total > _S3_MAX_SIZE_BYTES:
                _cleanup(temp_dir)
                raise ValueError(f"S3 skill {uri} exceeds 1 GB size limit")
            rel = obj["Key"][len(prefix):].lstrip("/")
            if not rel:
                continue
            dest = (temp_dir / rel).resolve()
            if dest != temp_root and not str(dest).startswith(str(temp_root) + os.sep):
                _cleanup(temp_dir)
                raise ValueError(f"Path traversal detected in S3 key: {obj['Key']}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            client.download_file(bucket, obj["Key"], str(dest))

    if total == 0:
        _cleanup(temp_dir)
        raise ValueError(f"No files found at S3 URI: {uri}")

    return _rename_and_cache_skill(type_dir, temp_dir, source_hash, temp_dir, source_label=uri)


def resolve_s3_skills(sources: list, s3_client=None) -> list:
    """Resolve s3:// skill URIs to local filesystem paths.

    Any fetch failure raises and fails the invocation — a partial skill set
    would silently run the agent without capabilities the harness declared.
    """
    paths = []
    for uri in sources:
        try:
            skill_dir = _fetch_s3_skill(uri, s3_client)
        except Exception as e:
            raise ValueError(f"Failed to resolve S3 skill '{uri}': {e}") from e
        paths.append(str(skill_dir.resolve()))
    return paths


def load_skill_instructions(uris: list, s3_client=None, placeholders: dict | None = None) -> str:
    """Fetch each S3 skill's SKILL.md and concatenate its body for a system prompt.

    Fails loudly (real exception, real traceback) rather than silently running
    without the instructions the agent depends on.

    placeholders, if given, is a dict of NAME -> value substituted for every
    literal "{{NAME}}" found in the fetched skill text -- e.g. {"SPACE_ID": "123"}
    replaces every "{{SPACE_ID}}". This is how skill content stays deployment-
    agnostic: a skill never hardcodes a space id, it writes "{{SPACE_ID}}" and
    whichever deployment loads it fills in its own resolved value. Only put
    non-secret values here -- this text becomes part of the system prompt, so
    anything substituted in is visible to the model. Never pass a credential
    (e.g. the Storyblok PAT) through this; secrets stay server-side in tool
    implementations, never in prompt text.
    """
    sections = []
    for local_dir in resolve_s3_skills(uris, s3_client):
        content = (Path(local_dir) / "SKILL.md").read_text()
        # strip the YAML frontmatter, keep the markdown body
        if content.startswith("---"):
            _, _, body = content.split("---", 2)
        else:
            body = content
        sections.append(body.strip())
    text = "\n\n---\n\n".join(sections)
    for name, value in (placeholders or {}).items():
        text = text.replace(f"{{{{{name}}}}}", value)
    return text
