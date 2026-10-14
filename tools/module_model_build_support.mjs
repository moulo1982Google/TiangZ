import path from "node:path";
import { resolveModuleApi } from "./game_module_imports.mjs";

/** 构建与导出预检共用同一模块解析边界。 / Share module resolution boundaries between builds and export checks. */
export function modelModuleBoundaryPlugin(catalog, root) {
  return {
    name: "game-module-model-boundary",
    setup(buildApi) {
      installModuleApiResolver(buildApi, catalog, false);
      buildApi.onResolve({ filter: /^#tiangz\/core$/ }, () => ({
        path: path.join(root, "app", "core", "public.ts"),
      }));
      buildApi.onResolve({ filter: /^#tiangz\/domains$/ }, () => ({ path: path.join(root, "app/model/domains/public.ts") }));
      buildApi.onResolve({ filter: /^#tiangz\/model$/ }, () => ({
        path: path.join(root, "app/model/public.ts"),
      }));
      buildApi.onResolve({ filter: /^#tiangz\/(?:core|model)\// }, (args) => ({
        errors: [{ text: `Game module Model must use a Stable entrypoint, not ${args.path}` }],
      }));
      buildApi.onResolve({ filter: /^#tiangz\/module(?:\/|$)/ }, (args) => ({
        errors: [{ text: `Game module Model cannot import its Hotfix bridge: ${args.path}` }],
      }));
      buildApi.onResolve({ filter: /^[^./]/ }, (args) => rejectModuleBareImport(
        catalog,
        args,
        "Model",
      ));
      buildApi.onResolve({ filter: /^\./ }, (args) => validateModuleRelativeImport(
        catalog,
        args,
        "model",
        root,
      ));
    },
  };
}

export function installModuleApiResolver(buildApi, catalog, hotfix) {
  buildApi.onResolve({ filter: /^#tiangz\/modules\// }, (args) => {
    try {
      const target = resolveModuleApi(catalog, catalog.moduleForFile(args.importer), args.path);
      return hotfix
        ? { path: `tiangz:module-api:${target.id}`, external: true }
        : { path: target.publicApi.file };
    } catch (error) {
      return { errors: [{ text: error.message }] };
    }
  });
}

export function rejectModuleBareImport(catalog, args, layer) {
  const owner = catalog.moduleForFile(args.importer);
  if (!owner) return undefined;
  return {
    errors: [{
      text: `Game module ${owner.id} ${layer} cannot import undeclared package ${args.path}`,
    }],
  };
}

export function validateModuleRelativeImport(catalog, args, layer, root) {
  const owner = catalog.moduleForFile(args.importer);
  if (!owner) return undefined;
  const target = path.resolve(args.resolveDir, args.path);
  if (layer === "model" && owner.gameConfig && isWithin(owner.gameConfig.generatedCode, args.importer) && isWithin(owner.gameConfig.generatedCode, target)) return undefined;
  if (
    owner.protocol &&
    [owner.protocol.serverOutput, path.join(owner.realRoot, owner.protocol.relative.serverOutput)].some(directory => isWithin(directory, args.importer)) &&
    (
      isWithin(owner.protocol.serverOutput, target) ||
      ["protocol/binary", "protocol/message", "protocol/rpc", "broadcast/index"].some(file => target.replace(/\.ts$/, "") === path.join(root, "app/core", file))
    )
  ) {
    return undefined;
  }
  const allowedRoots = layer === "model"
    ? [...owner.entries.modelRoots, ...owner.entries.modelRealRoots]
    : [...owner.entries.hotfixRoots, ...owner.entries.hotfixRealRoots];
  if (allowedRoots.some((allowed) => isWithin(allowed, target))) return undefined;
  return {
    errors: [{
      text: `Game module ${owner.id} ${layer} relative import escapes its declared ${layer}Roots: ${args.path}`,
    }],
  };
}

function isWithin(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
