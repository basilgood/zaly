import { describe, expect, test } from "vitest"
import {
  extractIds,
  isGitHubActionsApp,
  isNumeric,
  isUrl,
  parseRepo,
} from "../src/tools/gh-run.ts"

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
    })
  })

  test("runs url", () => {
    expect(extractIds("https://github.com/o/r/actions/runs/123")).toEqual({ id: "123" })
  })

  test("check-runs url", () => {
    expect(extractIds("https://github.com/o/r/check-runs/456")).toEqual({ id: "456" })
  })

  test("pr checks query string", () => {
    expect(extractIds("https://github.com/o/r/pull/1091/checks?check_run_id=456")).toEqual({
      id: "456",
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
