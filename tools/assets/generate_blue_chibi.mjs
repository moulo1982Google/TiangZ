import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const blender = resolveBlender();
const result = spawnSync(
  blender,
  [
    "--background",
    "--python",
    path.join(root, "tools", "assets", "generate_blue_chibi.py"),
    "--",
    "--output",
    path.join(root, "client_demo", "cocos_client3D_3.8.8", "assets", "resources", "Demo", "Characters", "Player", "blue_chibi", "BlueChibi.glb"),
    "--blend",
    path.join(root, "client_demo", "cocos_client3D_3.8.8", "art", "BlueChibi.blend"),
  ],
  { cwd: root, encoding: "utf8", stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Blender生成蓝发角色失败，exit=${result.status}`);

/**
 * 优先使用显式BLENDER_PATH，否则使用PATH中的blender命令。
 * 这里只定位离线美术工具，运行时与发布包均不依赖Blender。
 *
 * Prefers BLENDER_PATH, then uses the blender command available on PATH.
 * Blender is an offline art tool and is never required by the runtime package.
 */
function resolveBlender() {
  const configured = process.env.BLENDER_PATH;
  return configured ? path.resolve(configured) : "blender";
}
