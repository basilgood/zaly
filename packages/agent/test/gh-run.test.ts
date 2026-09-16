import { describe, expect, test } from "vitest"
import {
  extractGhIds as extractIds,
  isGhUrl as isUrl,
  isNumericId as isNumeric,
  parseRepo,
} from "../src/tools/gh-shared.ts"
import { ghCheckRunTool, isGitHubActionsApp } from "../src/tools/gh-run.ts"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("parseRepo", () => {
  test("parses owner/repo from github url", () => {
    expect(parseRepo("https://github.com/owner/repo/actions/runs/123")).toEqual({
      owner: "owner",
      repo: "repo",
    })
  })

  test("returns undefined for non-github urls", () => {
    expect(parseRepo("https://example.com/foo/bar")).toBeUndefined()
  })
})

describe("extractIds", () => {
  test("job url extracts run and job ids", () => {
    expect(extractIds("https://github.com/o/r/actions/runs/123/job/789")).toEqual({
      id: "123",
      jobId: "789",
      kind: "run",
    })
  })

  test("job url with /jobs/ spelling", () => {
    expect(extractIds("https://github.com/o/r/actions/runs/123/jobs/789")).toEqual({
      id: "123",
      jobId: "789",
      kind: "run",
    })
  })

  test("runs url", () => {
    expect(extractIds("https://github.com/o/r/actions/runs/123")).toEqual({ id: "123", kind: "run" })
  })

  test("check-runs url", () => {
    expect(extractIds("https://github.com/o/r/check-runs/456")).toEqual({ id: "456", kind: "check" })
  })

  test("pr checks query string", () => {
    expect(extractIds("https://github.com/o/r/pull/1091/checks?check_run_id=456")).toEqual({
      id: "456",
      kind: "check",
    })
  })

  test("returns undefined without an id", () => {
    expect(extractIds("https://github.com/o/r/pull/1091")).toBeUndefined()
  })
})

describe("isUrl / isNumeric", () => {
  test("isUrl", () => {
    expect(isUrl("https://github.com/o/r")).toBe(true)
    expect(isUrl("123")).toBe(false)
  })

  test("isNumeric", () => {
    expect(isNumeric("123")).toBe(true)
    expect(isNumeric("abc")).toBe(false)
  })
})

describe("isGitHubActionsApp", () => {
  test("github-actions slug", () => {
    expect(isGitHubActionsApp({ app: { slug: "github-actions" } })).toBe(true)
  })

  test("GitHub Actions name", () => {
    expect(isGitHubActionsApp({ app: { name: "GitHub Actions" } })).toBe(true)
  })

  test("external app", () => {
    expect(isGitHubActionsApp({ app: { slug: "codecov" } })).toBe(false)
  })
})

describe("external check-runs", () => {
  // No workflow run exists to resolve to, so the app's own report is the answer.
  test("returns the app output and annotations", async () => {
    const bin = mkdtempSync(join(tmpdir(), "ghstub-"))
    const script = join(bin, "gh")
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"check-runs/999/annotations"*) echo \'[{"annotation_level":"failure","path":"a.ts","start_line":3,"message":"boom"}]\' ;;',
        '  *"check-runs/999"*) echo \'{"id":999,"name":"codecov/patch","status":"completed","conclusion":"failure","app":{"slug":"codecov","name":"Codecov"},"html_url":"https://app.codecov.io/x","output":{"title":"Coverage","summary":"42% of diff"}}\' ;;',
        '  *"actions/runs/999"*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
        '  *) echo "{}" ;;',
        "esac",
      ].join("\n")
    )
    chmodSync(script, 0o755)
    const prev = process.env.PATH
    process.env.PATH = `${bin}:${prev}`
    try {
      const sessionDir = mkdtempSync(join(tmpdir(), "ghsess-"))
      const parts = (await ghCheckRunTool.call(
        { url: "https://github.com/o/r/check-runs/999" },
        { sessionDir } as never
      )) as unknown as [{ data: unknown }, { text: string }]
      const meta = parts[0].data as { resolved?: string; runId?: string }
      const text = (parts[1] as { text: string }).text
      expect(meta.resolved).toBe("check")
      expect(meta.runId).toBeUndefined()
      expect(text).toContain("external app")
      expect(text).toContain("Codecov")
      expect(text).toContain("42% of diff")
      expect(text).toContain("[failure] a.ts:3 boom")
    } finally {
      process.env.PATH = prev
    }
  })
})

describe("tool contract", () => {
  // `params` is typed as the static argument shape, but at runtime it is the
  // TypeBox schema — cast to read the declared properties.
  const params = Object.keys((ghCheckRunTool.params as unknown as { properties?: Record<string, unknown> }).properties ?? {})

  test("is a resolver: no fetch-mode surface", () => {
    // mode/grep/head/fields/jq all moved to gh_fetch to keep one fetch path.
    for (const gone of ["mode", "grep", "head", "fields", "jq"]) {
      expect(params).not.toContain(gone)
    }
  })

  test("keeps the resolution inputs", () => {
    for (const kept of ["url", "repo", "branch", "workflow", "limit"]) {
      expect(params).toContain(kept)
    }
  })

  test("description points at gh_fetch for the follow-up fetch", () => {
    expect(ghCheckRunTool.desc).toContain("gh_fetch")
  })
})
