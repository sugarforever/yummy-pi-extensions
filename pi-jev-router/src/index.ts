import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiJevRouter } from "./extension.js";

export default function piJevRouter(pi: ExtensionAPI): void {
  registerPiJevRouter(pi);
}

export { registerPiJevRouter } from "./extension.js";
export { prefilter } from "./prefilter.js";
export { buildState } from "./state.js";
export { applyPolicy } from "./policy.js";
export { QUESTIONS, ROUTE_CRITERIA } from "./questions.js";
export type { Decision, Route, RouterConfig, RouterState } from "./types.js";
