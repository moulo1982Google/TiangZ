import path from "node:path";
import { publishClientSdk } from "./client_sdk_publish.mjs";

const args = process.argv.slice(2);
const index = args.indexOf("--project");
if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--") ||
    args.some((arg, i) => i !== index + 1 && !["--project", "--check"].includes(arg))) {
  throw new Error("usage: node tools/publish_client_sdk.mjs --project <client-project> [--check]");
}
const result = await publishClientSdk({ engineRoot: path.resolve(import.meta.dirname, ".."),
  projectRoot: path.resolve(args[index + 1]), check: args.includes("--check") });
console.log(`[client-sdk] ${JSON.stringify(result)}`);
