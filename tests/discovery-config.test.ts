/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DISCOVERY_CONFIG, parseDiscoveryConfig } from "../application-agent/src/domain/discoveryConfig";
import { normalizeJobSearchIntent, type JobSearchIntent } from "../application-agent/src/domain/searchIntent";

describe("discovery config", () => {
  it("uses the no-key defaults when fields are missing", () => {
    expect(parseDiscoveryConfig({})).toEqual(DEFAULT_DISCOVERY_CONFIG);
    expect(parseDiscoveryConfig({ sources: { brave: true } }).sources).toEqual({ remotive: true, himalayas: true, themuse: true, brave: true });
  });

  it("accepts the committed search-intent example", () => {
    const intent = normalizeJobSearchIntent(JSON.parse(readFileSync("application-agent/search-intent.example.json", "utf8")) as JobSearchIntent);
    expect(intent.locations).toContain("Pittsburgh, PA");
    expect(intent.excludedTitleTerms).toContain("contract");
  });

  it("accepts the committed example", () => {
    const example = parseDiscoveryConfig(JSON.parse(readFileSync("application-agent/discovery.example.json", "utf8")));
    expect(example.employerBoards).toEqual({ greenhouse: ["duolingo", "stackav"], lever: ["gopuff"], ashby: ["abridge"] });
  });

  it("de-duplicates boards and rejects unknown sources, platforms, and unsafe names", () => {
    expect(parseDiscoveryConfig({ employerBoards: { greenhouse: ["Duolingo", "duolingo", "stackav"] } }).employerBoards.greenhouse).toEqual(["Duolingo", "stackav"]);
    expect(() => parseDiscoveryConfig({ sources: { indeed: true } })).toThrow('Unknown discovery source "indeed"');
    expect(() => parseDiscoveryConfig({ sources: { remotive: "yes" } })).toThrow("must be true or false");
    expect(() => parseDiscoveryConfig({ employerBoards: { workday: ["pnc"] } })).toThrow('Unknown employer board platform "workday"');
    expect(() => parseDiscoveryConfig({ employerBoards: { ashby: ["../etc"] } })).toThrow("invalid board name");
  });
});
