import { describe, expect, test } from "vitest"
import { filenameHash, isRawApiPath, parseDiffHash, parseGitHubUrl } from "../src/tools/gh-fetch.ts"
import { filterLog } from "../src/tools/gh-shared.ts"

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

describe("filterLog", () => {
  const log = "line one\nError: boom\nline three\nError: again"

  test("no grep returns full log", () => {
    expect(filterLog(log)).toBe(log)
  })

  test("grep filters to matching lines", () => {
    expect(filterLog(log, "Error")).toBe("2 matching line(s), showing first 2\nError: boom\nError: again")
  })

  test("head caps matching lines", () => {
    expect(filterLog(log, "Error", 1)).toBe("2 matching line(s), showing first 1\nError: boom")
  })

  test("invalid regex returns error text", () => {
    expect(filterLog(log, "(")).toBe("Invalid grep regex: (")
  })
})
