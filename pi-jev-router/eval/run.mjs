// Run the labelled scenarios through a built pi-jev-router and score its one job:
// interrupt for unrelated prompts, let everything else through.
//
// usage: node eval/run.mjs [--dist ./dist/index.js] [--label 0.3.0] [--runs 2]
// Needs a Jev engine key in the environment (OPENROUTER_API_KEY, TYPESAFE_API_KEY or AI_GATEWAY_API_KEY).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const dist = resolve(arg("dist", join(here, "..", "dist", "index.js")));
const label = arg("label", JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version);
const runs = Number(arg("runs", "2"));

const { resolveClient, applyPolicy } = await import(pathToFileURL(dist).href);
const resolved = resolveClient();
if (!resolved) throw new Error("No Jev engine configured: set OPENROUTER_API_KEY, TYPESAFE_API_KEY or AI_GATEWAY_API_KEY");

const sets = ["dev", "heldout", "regress"].map((name) => [name, JSON.parse(readFileSync(join(here, "scenarios", `${name}.json`), "utf8"))]);
mkdirSync(join(here, "results"), { recursive: true });

for (let run = 1; run <= runs; run++) {
  const rows = [];
  for (const [set, scenarios] of sets) {
    for (const s of scenarios) {
      const state = { session_title: s.title, recent_user_messages: s.recent, last_assistant_reply_tail: s.assistant, new_input: s.input };
      let d;
      try {
        d = applyPolicy(await resolved.client(state, AbortSignal.timeout(10_000)), { threshold: 0.6 });
      } catch (cause) {
        d = { route: "continue", confidence: 1, skipped: String(cause) };
      }
      rows.push({
        set, id: s.id, expected: s.expected, route: d.route, flagged: d.route !== "continue",
        confidence: d.confidence, rule: d.rule ?? "", skipped: d.skipped ?? "",
        latencyMs: d.answers?.latencyMs ?? null, inputTokens: d.answers?.inputTokens ?? 0, raw: d.answers ?? null,
      });
    }
  }
  const out = join(here, "results", `${label}-run${run}.json`);
  writeFileSync(out, JSON.stringify({ label, engine: resolved.via, generatedAt: new Date().toISOString(), rows }, null, 2) + "\n");

  console.log(`\n${label} · run ${run} · ${resolved.via}`);
  for (const [set] of sets) {
    const r = rows.filter((x) => x.set === set);
    const unrelated = r.filter((x) => x.expected === "new_session");
    const other = r.filter((x) => x.expected !== "new_session");
    const missed = unrelated.filter((x) => !x.flagged).map((x) => x.id);
    const interrupted = other.filter((x) => x.flagged).map((x) => x.id);
    console.log(
      `  ${set.padEnd(8)} unrelated flagged ${unrelated.length - missed.length}/${unrelated.length}` +
        `  others interrupted ${interrupted.length}/${other.length}  errors ${r.filter((x) => x.skipped).length}` +
        (missed.length ? `  missed: ${missed.join(", ")}` : "") +
        (interrupted.length ? `  interrupted: ${interrupted.join(", ")}` : ""),
    );
  }
  const lat = rows.map((x) => x.latencyMs).filter((x) => x != null).sort((a, b) => a - b);
  const mean = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
  const tokens = Math.round(rows.reduce((a, x) => a + x.inputTokens, 0) / rows.length);
  console.log(`  latency mean ${mean} ms · p95 ${lat[Math.ceil(lat.length * 0.95) - 1]} ms · ${tokens} input tokens/call → ${out}`);
}
