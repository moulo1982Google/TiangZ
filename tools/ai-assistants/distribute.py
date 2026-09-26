"""将已生成的 AI 产物同步到显式分发仓库；不安装插件。 / Syncs generated AI artifacts to an explicit distribution repository without installing plugins."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import zipfile


def prepare(repository: Path, developer_tools: Path) -> dict[str, bytes]:
    """写入前验证版本与目标，再构造完整包。 / Validates identities before writing and prepares the complete package."""
    engine = Path(__file__).resolve().parents[2]
    subprocess.run(["node", str(engine / "tools/ai-assistants/build.mjs"), "--check"], check=True)
    generated = engine / "dist/ai-assistants"
    ghost = json.loads((generated / "cindy/ghost.json").read_text(encoding="utf-8"))
    for name in [".codex-plugin", ".claude-plugin"]:
        manifest = json.loads((repository / "tiangz-game-backend" / name / "plugin.json").read_text(encoding="utf-8"))
        if manifest["name"] != ghost["id"] or manifest["version"] != ghost["version"]:
            raise ValueError(f"distribution identity differs from generated Cindy manifest: {name}")
    version = ghost["version"]
    if not version or any(character not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-" for character in version):
        raise ValueError("invalid plugin version for archive filename")
    files: dict[str, bytes] = {}
    core_package = json.loads((developer_tools / "package.json").read_text(encoding="utf-8"))
    identity = json.loads((developer_tools / "dist/tiangz-design-mcp.build-info.json").read_text(encoding="utf-8"))
    if core_package["name"] != "@tiangz/developer-tools-core" or identity["package"] != core_package["name"] or identity["version"] != core_package["version"]:
        raise ValueError("MCP build identity differs from Developer Core package")
    for name, hash_key in [("tiangz-design-mcp.cjs", "bundleSha256"), ("tiangz-design-mcp.NOTICES.txt", "noticesSha256")]:
        content = (developer_tools / "dist" / name).read_bytes()
        if hashlib.sha256(content).hexdigest() != identity[hash_key]:
            raise ValueError(f"MCP build hash differs: {name}")
        files[f"tiangz-game-backend/mcp/{name}"] = content
    for source, destination in [("dist/tiangz-design-mcp.build-info.json", "build-info.json"), ("LICENSE", "LICENSE"), ("NOTICE", "NOTICE")]:
        files[f"tiangz-game-backend/mcp/{destination}"] = (developer_tools / source).read_bytes()
    for flavor, destination in [
        ("codex", "tiangz-game-backend/skills/tiangz-game-backend"),
        ("claude", "claude/tiangz-game-backend"),
    ]:
        for relative in ["SKILL.md", "references/development-contract.md"]:
            files[f"{destination}/{relative}"] = (generated / flavor / "tiangz-game-backend" / relative).read_bytes()
    cindy = {name: (generated / "cindy" / name).read_bytes() for name in ["ghost.json", "main.js"]}
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        for name, content in cindy.items():
            entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(entry, content)
            files[f"tiangz-game-backend-cindy/{name}"] = content
    files[f"tiangz-game-backend-cindy/tiangz-game-backend-{version}.cindy"] = archive.getvalue()
    identity = {"formatVersion": 1, "pluginVersion": version, "validation": "local-artifact-only",
                "developerCoreVersion": core_package["version"],
                "files": {name: hashlib.sha256(content).hexdigest() for name, content in sorted(files.items())}}
    files["distribution-manifest.json"] = (json.dumps(identity, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    for name in files:
        if not (repository / name).resolve().is_relative_to(repository):
            raise ValueError(f"distribution target escapes the selected repository: {name}")
    return files


def main() -> None:
    """同步技能和已构建 MCP，保留清单、客户端启动配置和其他文件。 / Copies skills and built MCP artifacts, preserving manifests, client launch configuration and other files."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--developer-tools", type=Path, default=Path(__file__).resolve().parents[2] / "node_modules/@tiangz/developer-tools-core")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    repository = args.repository.resolve(strict=True)
    files = prepare(repository, args.developer_tools.resolve(strict=True))
    changed = [name for name, content in files.items() if not (repository / name).is_file() or (repository / name).read_bytes() != content]
    if args.check and changed:
        raise SystemExit("Distribution is stale: " + ", ".join(changed))
    for name in changed:
        destination = repository / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(files[name])
    print(f"{'Checked' if args.check else 'Generated'} {len(files)} AI distribution artifacts; {len(changed)} changed; no plugin installation")


if __name__ == "__main__":
    main()
