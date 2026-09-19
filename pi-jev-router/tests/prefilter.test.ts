import { describe, expect, test } from "vitest";
import { prefilter } from "../src/prefilter.js";

describe("prefilter", () => {
  test.each([
    ["merged", "tiny-steer"],
    ["Try again", "tiny-steer"],
    ["/compact", "command"],
    ["/skill:foo run it", "command"],
    ["!git status", "bash"],
    ["@src/index.ts", "file-ref"],
    ["/Users/me/Movies/R4.mov", "file-ref"],
    ["[Image: original 3840x2160]", "image-or-interrupt"],
    ["[Request interrupted by user]", "image-or-interrupt"],
    ["Base directory for this skill: /x", "skill-load"],
    ["   ", "empty"],
  ])("skips %j as %s", (text, reason) => {
    expect(prefilter(text)).toEqual({ skip: true, reason });
  });

  test("skips anything queued while streaming or not typed interactively", () => {
    expect(prefilter("please also update the README", { streaming: true })).toMatchObject({ skip: true, reason: "streaming" });
    expect(prefilter("please also update the README", { source: "extension" })).toMatchObject({ skip: true, reason: "source:extension" });
  });

  test("lets a real prompt through", () => {
    expect(prefilter("这期视频改一下主题，我们不再做 Cloudflare 的演示")).toEqual({ skip: false });
    expect(prefilter("/Users/wyang14/github/chat-ollama look into the recent sessions of this project")).toEqual({ skip: false });
    expect(prefilter("look into the recent sessions of this project and tell me what changed")).toEqual({ skip: false });
  });
});
