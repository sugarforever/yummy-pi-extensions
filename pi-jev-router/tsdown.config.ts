import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  dts: true,
  clean: true,
  external: ["@earendil-works/pi-coding-agent", "ai", "@ai-sdk/gateway"],
});
