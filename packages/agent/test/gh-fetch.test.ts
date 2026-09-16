import { describe, expect, test } from "vitest"
import { filenameHash, isRawApiPath, parseDiffHash, parseGitHubUrl, refCandidates, runViewError } from "../src/tools/gh-fetch.ts"
import { filterLog, renderGhPayload, budgetTruncate, filterOutput, readOutput, runGh, runJq, describeJsonShape, assertJqFieldsExist, makeLogStripper, stripAnsi } from "../src/tools/gh-shared.ts"
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@zaly/ai"

describe("parseGitHubUrl", () => {
  test("parses PR url", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/pull/123")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "pull",
      id: "123",
    })
  })

  test("parses PR changes url with suffix", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/pull/123/changes")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "pull",
      id: "123",
      suffix: "changes",
    })
  })

  test("parses actions run url", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/actions/runs/456")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "actions",
      id: "456",
    })
  })

  test("parses actions job url", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/actions/runs/456/jobs/789")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "actions",
      id: "456",
      suffix: "jobs/789",
    })
  })

  test("parses blob url with path", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/blob/main/src/index.ts")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "blob",
      id: "main",
      suffix: "src/index.ts",
    })
  })

  test("parses tree url", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/tree/main/packages")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "tree",
      id: "main",
      suffix: "packages",
    })
  })

  test("parses commit url", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/commit/abc123")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "commit",
      id: "abc123",
    })
  })

  test("parses issue url", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/issues/42")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "issues",
      id: "42",
    })
  })

  test("strips .diff format suffix", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/pull/123.diff")).toEqual({
      owner: "owner",
      repo: "repo",
      type: "pull",
      id: "123",
      format: "diff",
    })
  })

  test("returns undefined for non-github urls", () => {
    expect(parseGitHubUrl("https://example.com/foo/bar")).toBeUndefined()
  })

  test("parses raw.githubusercontent.com as a blob", () => {
    expect(parseGitHubUrl("https://raw.githubusercontent.com/owner/repo/main/src/index.ts")).toEqual({
      id: "main",
      owner: "owner",
      repo: "repo",
      suffix: "src/index.ts",
      type: "blob",
    })
  })

  test("leaves a slash-containing raw ref for refCandidates to split", () => {
    const parsed = parseGitHubUrl("https://raw.githubusercontent.com/owner/repo/chore/visuals/tests/a.spec.ts")
    expect(parsed).toEqual({
      id: "chore",
      owner: "owner",
      repo: "repo",
      suffix: "visuals/tests/a.spec.ts",
      type: "blob",
    })
    expect(refCandidates(parsed!.id, parsed!.suffix ?? "")).toContainEqual({
      path: "tests/a.spec.ts",
      ref: "chore/visuals",
    })
  })

  test("parses a raw url with no path", () => {
    expect(parseGitHubUrl("https://raw.githubusercontent.com/owner/repo/main")).toEqual({
      id: "main",
      owner: "owner",
      repo: "repo",
      suffix: undefined,
      type: "blob",
    })
  })
})

describe("runViewError", () => {
  test("steers a 404 to the resolver", () => {
    const msg = runViewError("gh: Not Found (HTTP 404)", "103988029310")
    expect(msg).toContain("check_run_id")
    expect(msg).toContain("gh_run")
  })
  test("leaves other errors alone", () => {
    expect(runViewError("network unreachable", "1")).toBe("gh run view error: network unreachable")
  })
})

describe("refCandidates", () => {
  test("ref without slashes still lists splits, exact first", () => {
    expect(refCandidates("main", "src/index.ts")).toEqual([
      { path: "src/index.ts", ref: "main" },
      { path: "index.ts", ref: "main/src" },
    ])
  })

  test("slash ref in path yields splits", () => {
    expect(refCandidates("chore", "visuals/tests/a.spec.ts")).toEqual([
      { path: "visuals/tests/a.spec.ts", ref: "chore" },
      { path: "tests/a.spec.ts", ref: "chore/visuals" },
      { path: "a.spec.ts", ref: "chore/visuals/tests" },
    ])
  })

  test("no path yields single candidate", () => {
    expect(refCandidates("main", "")).toEqual([{ path: "", ref: "main" }])
  })
})

describe("parseDiffHash", () => {
  test("extracts diff anchor", () => {
    expect(parseDiffHash("https://github.com/o/r/pull/1#diff-abc123")).toBe("abc123")
  })

  test("returns undefined without anchor", () => {
    expect(parseDiffHash("https://github.com/o/r/pull/1")).toBeUndefined()
  })
})

describe("filenameHash", () => {
  test("sha256 hex of filename", () => {
    expect(filenameHash("src/index.ts")).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("isRawApiPath", () => {
  test("raw api path", () => {
    expect(isRawApiPath("repos/owner/repo/pulls/123")).toBe(true)
  })

  test("github url is not raw", () => {
    expect(isRawApiPath("https://github.com/owner/repo/pull/123")).toBe(false)
  })
})

describe("renderGhPayload", () => {
  test("decodes contents envelope", () => {
    const stdout = JSON.stringify({ content: Buffer.from("hello\n").toString("base64"), encoding: "base64" })
    expect(renderGhPayload(stdout)).toBe("hello\n")
  })

  test("decodes base64 with trailing newline in content", () => {
    const stdout = JSON.stringify({ content: `${Buffer.from("hi").toString("base64")}\n`, encoding: "base64" })
    expect(renderGhPayload(stdout)).toBe("hi")
  })

  test("renders directory listing as type: name", () => {
    const stdout = JSON.stringify([
      { name: "src", type: "dir" },
      { name: "index.ts", type: "file" },
    ])
    expect(renderGhPayload(stdout)).toBe("directory: src\nfile: index.ts")
  })

  test("pretty-prints other json so no base64 or single long line leaks", () => {
    const stdout = JSON.stringify({ name: "file.ts", content: "not-base64", encoding: "none" })
    expect(renderGhPayload(stdout)).toBe(JSON.stringify({ name: "file.ts", content: "not-base64", encoding: "none" }, undefined, 2))
  })

  test("passes through plain text", () => {
    expect(renderGhPayload("not json")).toBe("not json")
  })

  test("passes through a diff", () => {
    expect(renderGhPayload("--- a\n+++ b\n")).toBe("--- a\n+++ b\n")
  })
})

describe("budgetTruncate", () => {
  test("small output is returned untouched, nothing written", async () => {
    const ctx = { sessionDir: mkdtempSync(join(tmpdir(), "gh-")) } as ToolContext
    const res = await budgetTruncate("hello", { ctx, hint: "h" })
    expect(res.text).toBe("hello")
    expect(res.truncated).toBeUndefined()
  })

  test("truncated output spills full text and surfaces the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"))
    const ctx = { sessionDir: dir } as ToolContext
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")
    const res = await budgetTruncate(big, { ctx, hint: "h", maxTokens: 100 })
    expect(res.truncated).toBeDefined()
    const full = res.truncated?.fullOutputPath ?? ""
    expect(res.text).toContain(full)
    expect(readFileSync(full, "utf8")).toBe(big)
  })
})

describe("runGh memory budget", () => {
  test("large output spills to disk instead of the heap", async () => {
    const bin = mkdtempSync(join(tmpdir(), "ghbin-"))
    const script = join(bin, "gh")
    // ~4 MB of output, past the 2 MB capture budget.
    writeFileSync(script, '#!/bin/sh\nfor i in $(seq 1 40000); do echo "line $i aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; done\n')
    chmodSync(script, 0o755)
    const sessionDir = mkdtempSync(join(tmpdir(), "ghsess-"))
    const prev = process.env.PATH
    process.env.PATH = `${bin}:${prev}`
    try {
      const out = await runGh(["anything"], { sessionDir } as ToolContext)
      expect(out.path).toBeDefined()
      expect(out.stdout).toBe("")
      expect(statSync(out.path ?? "").size).toBeGreaterThan(2 * 1024 * 1024)
      expect(readOutput(out)).toContain("line 40000")
    } finally {
      process.env.PATH = prev
    }
  })
})

describe("filterOutput on spilled output", () => {
  test("greps the file and honours head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghsess-"))
    const path = join(dir, "big.log")
    const lines = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? `Error: boom ${i}` : `fine ${i}`))
    writeFileSync(path, lines.join("\n"))
    const out = { code: 0, path, stderr: "", stdout: "" }
    expect(await filterOutput(out, "Error", 2)).toBe("10 matching line(s), showing first 2 — 8 not shown, raise head to see more\nError: boom 0\nError: boom 2")
  })

  test("no grep reads the whole spilled file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghsess-"))
    const path = join(dir, "small.log")
    writeFileSync(path, "hello\nworld")
    const out = { code: 0, path, stderr: "", stdout: "" }
    expect(await filterOutput(out)).toBe("hello\nworld")
  })
})

describe("runJq", () => {
  const ctx = {} as ToolContext

  test("filters JSON in-process and stays compact", async () => {
    const json = JSON.stringify({ files: [{ filename: "a.ts", additions: 3 }, { filename: "b.ts", additions: 5 }] })
    const res = await runJq("[.files[] | {filename, additions}]", json, ctx)
    expect(res.ok).toBe(true)
    expect(res.text.trim()).toBe('[{"filename":"a.ts","additions":3},{"filename":"b.ts","additions":5}]')
  })

  test("reports a bad filter instead of throwing", async () => {
    const res = await runJq(".[", "{}", ctx)
    expect(res.ok).toBe(false)
    expect(res.text).toContain("jq error:")
  })
})

describe("describeJsonShape", () => {
  test("object reports its keys", () => {
    expect(describeJsonShape('{"title":"x","files":[]}')).toBe("shape: object keys = title, files")
  })
  test("array reports element shape and length", () => {
    expect(describeJsonShape('[{"name":"a"},{"name":"b"}]')).toBe("shape: array of 2 x object {name}")
  })
  test("non-JSON is not summarized", () => {
    expect(describeJsonShape("diff --git a/x b/x")).toBeUndefined()
  })
})

describe("budgetTruncate shape hint", () => {
  test("truncated JSON carries the shape so the next call can jq straight to it", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "ghsess-"))
    const big = JSON.stringify({ files: Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}.ts`, additions: i })) })
    const { text } = await budgetTruncate(big, { ctx: { sessionDir } as ToolContext, hint: "x", maxTokens: 200 })
    expect(text.startsWith("shape: object keys = files\n")).toBe(true)
  })

  test("truncated logs get no shape line", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "ghsess-"))
    const log = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")
    const { text } = await budgetTruncate(log, { ctx: { sessionDir } as ToolContext, hint: "x", maxTokens: 200 })
    expect(text.startsWith("shape:")).toBe(false)
  })
})

describe("filterLog", () => {
  const log = "line one\nError: boom\nline three\nError: again"

  test("no grep returns full log", () => {
    expect(filterLog(log)).toBe(log)
  })

  test("grep filters to matching lines", () => {
    expect(filterLog(log, "Error")).toBe("2 matching line(s), showing first 2\nError: boom\nError: again")
  })

  test("head caps matching lines", () => {
    expect(filterLog(log, "Error", 1)).toBe("2 matching line(s), showing first 1 — 1 not shown, raise head to see more\nError: boom")
  })

  test("invalid regex returns error text", () => {
    expect(filterLog(log, "(")).toBe("Invalid grep regex: (")
  })
})

describe("assertJqFieldsExist", () => {
  const payload = JSON.stringify({ conclusion: "failure", headBranch: "main", name: "CI" })

  test("flags snake_case fields that do not exist", () => {
    const warning = assertJqFieldsExist("{name: .name, head_branch: .head_branch}", payload)
    expect(warning).toContain("head_branch")
    expect(warning).toContain("camelCase")
    expect(warning).toContain("headBranch")
  })

  test("stays quiet when the fields exist", () => {
    expect(assertJqFieldsExist(".name, .headBranch", payload)).toBeUndefined()
  })

  test("flags a root field that is absent even behind an iterator", () => {
    // `.files[] | .path` on a response with no `files` yields nulls for every
    // element, so the missing root field is worth reporting.
    expect(assertJqFieldsExist(".files[] | .path", payload)).toContain("files")
  })

  test("stays quiet when iterated fields live below the root", () => {
    const withFiles = JSON.stringify({ files: [{ path: "a.ts" }] })
    expect(assertJqFieldsExist(".files[] | .path", withFiles)).toBeUndefined()
    expect(assertJqFieldsExist(".name", "plain text")).toBeUndefined()
  })

  test("checks projection keys against the iterated element", () => {
    // Regression: the projection used to be skipped entirely, so `.jobs[] |
    // {name, id}` emitted nulls with no hint at all.
    const run = JSON.stringify({ jobs: [{ databaseId: 7, name: "Visuals" }], name: "CI" })
    const warning = assertJqFieldsExist(".jobs[] | {name, id}", run, '{"name":"Visuals","id":null}')
    expect(warning).toContain("id (use databaseId)")
    expect(warning).toContain("databaseId")
    expect(warning).not.toContain("workflowName")
  })

  test("reports the element's fields, not the run's, behind an iterator", () => {
    const run = JSON.stringify({ jobs: [{ databaseId: 7, name: "Visuals" }], name: "CI" })
    const warning = assertJqFieldsExist(".jobs[].id", run, "null")
    expect(warning).toContain("databaseId")
    expect(warning).not.toContain("workflowName")
  })

  test("reads a comma-separated stream from the same node", () => {
    const run = JSON.stringify({ headBranch: "main", jobs: [{ name: "Visuals" }] })
    const warning = assertJqFieldsExist(".jobs[].name, .head_branch", run, '"Visuals"\nnull')
    expect(warning).toContain("head_branch (use headBranch)")
  })

  test("stays quiet when jq produced no nulls", () => {
    const run = JSON.stringify({ headBranch: "main" })
    expect(assertJqFieldsExist(".head_branch", run, '"main"')).toBeUndefined()
  })
})

describe("grep head disclosure", () => {
  test("says how many matches were withheld", () => {
    const log = Array.from({ length: 20 }, (_, i) => `Error ${i}`).join("\n")
    const out = filterLog(log, "Error", 5)
    expect(out).toContain("20 matching line(s), showing first 5")
    expect(out).toContain("15 not shown, raise head to see more")
  })
})

describe("makeLogStripper", () => {
  // GitHub prefixes every line with `job \t step \t timestampZ `; identical on
  // every line of a job log, and it buries the message inside the char budget.
  const prefix = "Visuals / Run visual regression tests\tUNKNOWN STEP\t2026-09-14T11:31:10.6167361Z "
  const second = "Visuals / Run visual regression tests\tUNKNOWN STEP\t2026-09-14T11:33:59.3460020Z "

  test("strips the per-line prefix, including the first line's BOM", () => {
    const strip = makeLogStripper(prefix)
    expect(strip(`${prefix}Current runner version: '2.336.0'`)).toBe("Current runner version: '2.336.0'")
    // Only line 0 carries the BOM; later lines must strip too.
    expect(strip(`${second}  ✘    2 [chromium] › foo.spec.ts`)).toBe("  ✘    2 [chromium] › foo.spec.ts")
  })

  test("leaves lines from another job untouched", () => {
    const strip = makeLogStripper(prefix)
    const other = "Other / job\tRun tests\t2026-09-14T11:31:10.1Z keep me"
    expect(strip(other)).toBe(other)
  })

  test("is a no-op for logs without a prefix", () => {
    const strip = makeLogStripper("plain log line")
    expect(strip("plain log line")).toBe("plain log line")
  })

  test("strips the timestamp-only prefix from an API job log", () => {
    // `gh api .../actions/jobs/<id>/logs` has no job/step columns.
    const strip = makeLogStripper("2026-09-14T11:33:59.3460020Z   ✘    2 [chromium] › foo.spec.ts")
    expect(strip("2026-09-14T11:33:59.3460020Z   ✘    2 [chromium] › foo.spec.ts")).toBe(
      "  ✘    2 [chromium] › foo.spec.ts"
    )
  })

  test("leaves a timestamp inside the message alone", () => {
    const strip = makeLogStripper("2026-09-14T11:33:59.3460020Z done")
    const line = "  at 2026-09-14T11:33:59.3460020Z boom"
    expect(strip(line)).toBe(line)
  })
})

describe("stripAnsi", () => {
  test("removes colour codes and keeps the text", () => {
    expect(stripAnsi("\u001B[31m✘ failed\u001B[0m")).toBe("✘ failed")
  })

  test("is a no-op on plain text", () => {
    expect(stripAnsi("✘ failed")).toBe("✘ failed")
  })
})

describe("job URLs", () => {
  // The web UI emits /job/<id>; API-style links use /jobs/<id>. Only the
  // plural form used to be recognised, so the job segment was dropped and
  // the answer described the whole run instead of the job.
  test("recognises both job URL spellings", () => {
    const singular = parseGitHubUrl("https://github.com/o/r/actions/runs/123/job/456")
    const plural = parseGitHubUrl("https://github.com/o/r/actions/runs/123/jobs/456")
    expect(singular).toMatchObject({ id: "123", suffix: "job/456", type: "actions" })
    expect(plural).toMatchObject({ id: "123", suffix: "jobs/456", type: "actions" })
  })
})
