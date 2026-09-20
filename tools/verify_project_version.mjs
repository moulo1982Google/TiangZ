import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const strict = process.env.TIANGZ_LOCK_VERSIONS === "1" || process.argv.includes("--strict");
const cargo = await readFile(path.join(root, "Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!cargoVersion) throw new Error("Cargo.toml package version is missing");

const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(path.join(root, "package-lock.json"), "utf8"),
);
const readme = await readFile(path.join(root, "README.md"), "utf8");
// 发布后 README 写“当前版本为”，开发期写“当前开发版本为”，两种都必须与 Cargo.toml 一致。
// After a release the README says “当前版本为”, during development “当前开发版本为”; both must match Cargo.toml.
const readmeVersion = readme.match(/当前(?:开发)?版本为 `([^`]+)`/)?.[1];

const mismatches = [];
if (packageJson.version !== cargoVersion) {
  mismatches.push(`package.json=${packageJson.version ?? "missing"}`);
}
if (
  packageLock.version !== cargoVersion ||
  packageLock.packages?.[""]?.version !== cargoVersion
) {
  mismatches.push(
    `package-lock.json=${packageLock.version ?? "missing"}/${packageLock.packages?.[""]?.version ?? "missing"}`,
  );
}
if (readmeVersion !== cargoVersion) {
  mismatches.push(`README.md=${readmeVersion ?? "missing"}`);
}
if (mismatches.length > 0 && strict) {
  throw new Error(
    `project version must follow Cargo.toml ${cargoVersion}: ${mismatches.join(", ")}`,
  );
}

if (mismatches.length > 0) {
  process.stdout.write(
    `project version inspected (development; lock skipped): Cargo.toml=${cargoVersion}; ${mismatches.join(", ")}\n`,
  );
} else {
  process.stdout.write(
    `project version ${strict ? "verified" : "inspected"}: ${cargoVersion}${strict ? " (release lock enabled)" : " (development lock skipped)"}\n`,
  );
}
