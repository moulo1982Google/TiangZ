export function resolveHostProfile(args = process.argv.slice(2)) {
  const index = args.indexOf("--host-profile");
  const value = args.find(arg => arg.startsWith("--host-profile="))?.slice(15)
    ?? (index >= 0 ? args[index + 1] : "modules");
  if (!["demo", "modules"].includes(value)) throw new Error(`unknown host profile: ${value}`);
  if (value === "demo") throw new Error("built-in demo host was extracted to TiangZ-Examples; use --host-profile modules and install the example modules");
  return value;
}
