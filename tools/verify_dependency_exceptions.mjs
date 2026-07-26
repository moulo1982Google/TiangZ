import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "security", "dependency-exceptions.json");
const document = JSON.parse(readFileSync(file, "utf8"));
const today = new Date().toISOString().slice(0, 10);
const ids = new Set();

for (const [index, exception] of document.exceptions.entries()) {
  const label = `exceptions[${index}]`;
  for (const field of ["id", "ecosystem", "package", "reason", "owner", "expiresOn"]) {
    if (typeof exception[field] !== "string" || exception[field].trim() === "") {
      throw new Error(`${label}.${field} must be a non-empty string`);
    }
  }
  if (ids.has(exception.id)) throw new Error(`duplicate dependency exception id: ${exception.id}`);
  ids.add(exception.id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expiresOn)) {
    throw new Error(`${label}.expiresOn must use YYYY-MM-DD`);
  }
  if (exception.expiresOn < today) {
    throw new Error(`dependency exception expired: ${exception.id} (${exception.expiresOn})`);
  }
}

console.log(`[dependency-policy] ${document.exceptions.length} active exceptions validated`);
