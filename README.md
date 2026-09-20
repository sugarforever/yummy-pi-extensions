# yummy-pi-extensions

Extensions for [Pi](https://pi.dev/), the coding agent, published under the `@sugarforever` npm scope. Each one lives in its own folder with its own README, tests and tag-driven release workflow.

| extension | what it does | install |
|---|---|---|
| [pi-jev-router](pi-jev-router/) | Before a prompt enters the session, asks [Jev](https://typesafe.ai) (TypeSafe's System One model) whether it should **continue**, **fork**, or start a **new session**, and offers the move. Keeps tangents and unrelated questions from polluting a long context. Engines: TypeSafe, OpenRouter (`typesafe/jev-1.13`), Vercel AI Gateway. | `pi install npm:@sugarforever/pi-jev-router` |
| [pi-zvec-grep](pi-zvec-grep/) | Zero-setup semantic and ranked full-text search over the workspace, embedding [zvec](https://github.com/alibaba/zvec) through [zvec-grep](https://github.com/zvec-ai/zvec-grep). Owns the index lifecycle; exposes a `zvec_search` tool to the agent. | `pi install npm:@sugarforever/pi-zvec-grep` |
| [pi-throughput-meter](pi-throughput-meter/) | Per-turn TTFT and output token throughput in Pi's status line (`TTFT 312 ms · ↓428 · 186.4 tok/s`). | `pi install npm:@sugarforever/pi-throughput-meter` |

Or enable any of them for one project in its `.pi/settings.json`:

```json
{ "packages": ["npm:@sugarforever/pi-jev-router"] }
```

## Development

Every package is standalone:

```bash
cd <package>
npm install
npm run check   # vitest, tsc --noEmit, tsdown
```

## Releasing

Bump `version` in the package's `package.json`, merge to `main`, then push a tag named `<package>-v<version>` (for example `pi-jev-router-v0.2.0`). The matching workflow in `.github/workflows/` verifies the tag against the version, runs `npm run check`, and publishes to npm with Trusted Publishing.

## License

[MIT](LICENSE)
