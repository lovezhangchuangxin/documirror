import { defineConfig } from "tsdown";

function isBareModuleId(id: string): boolean {
  return !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("node:");
}

function isInternalWorkspacePackage(id: string): boolean {
  return id === "@documirror/core" || id.startsWith("@documirror/");
}

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  target: "node24",
  clean: true,
  dts: false,
  sourcemap: true,
  publint: true,
  report: true,
  deps: {
    alwaysBundle: (id) => isInternalWorkspacePackage(id),
    neverBundle: (id) => isBareModuleId(id) && !isInternalWorkspacePackage(id),
    onlyBundle: false,
  },
});
