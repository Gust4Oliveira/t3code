import { describe, expect, it } from "vite-plus/test";

import {
  buildSpellingResolveExpression,
  createDesktopSpellingBridge,
  DESKTOP_SPELLING_BRIDGE,
  parseDesktopSpellingResult,
  readWordAtPointFromDocument,
  resolveContextMenuSpelling,
  resolveSpellingFromParams,
} from "./desktopSpelling.ts";

describe("desktopSpelling", () => {
  it("uses context-menu params when suggestions are present", () => {
    expect(
      resolveSpellingFromParams({
        misspelledWord: "helo",
        dictionarySuggestions: ["hello", "halo"],
      }),
    ).toEqual({
      word: "helo",
      suggestions: ["hello", "halo"],
    });
  });

  it("returns null when Chromium reports no misspelled word", () => {
    expect(
      resolveSpellingFromParams({
        misspelledWord: "",
        dictionarySuggestions: ["hello"],
      }),
    ).toBeNull();
  });

  it("builds a page script that prefers an explicit word then falls back to the click point", () => {
    const expression = buildSpellingResolveExpression({
      x: 12,
      y: 34,
      word: "helo",
    });
    expect(expression).toContain(DESKTOP_SPELLING_BRIDGE);
    expect(expression).toContain('"helo"');
    expect(expression).toContain("wordAtPoint(12, 34)");
  });

  it("parses bridge results and drops malformed payloads", () => {
    expect(
      parseDesktopSpellingResult({
        word: "helo",
        suggestions: ["hello", 2, "halo"],
      }),
    ).toEqual({
      word: "helo",
      suggestions: ["hello", "halo"],
    });
    expect(parseDesktopSpellingResult({ word: "", suggestions: ["hello"] })).toBeNull();
    expect(parseDesktopSpellingResult(null)).toBeNull();
  });

  it("reads the word under a caret range", () => {
    const textNode = { nodeType: 3, data: "say helo please" } as Text;
    const doc = {
      caretRangeFromPoint: () =>
        ({
          startContainer: textNode,
          startOffset: 6,
        }) as Range,
    };
    expect(readWordAtPointFromDocument(doc, 10, 20)).toBe("helo");
  });

  it("resolves misspellings through the preload bridge helpers", () => {
    const bridge = createDesktopSpellingBridge({
      isWordMisspelled: (word) => word === "helo",
      getWordSuggestions: (word) => (word === "helo" ? ["hello", "halo"] : []),
      readWordAtPoint: () => "helo",
    });
    expect(bridge.wordAtPoint(1, 2)).toBe("helo");
    expect(bridge.resolve("helo")).toEqual({
      word: "helo",
      suggestions: ["hello", "halo"],
    });
    expect(bridge.resolve("hello")).toBeNull();
  });

  it("keeps param suggestions without asking the renderer", async () => {
    const executeJavaScript = async () => {
      throw new Error("should not run");
    };
    await expect(
      resolveContextMenuSpelling(
        { isDestroyed: () => false, executeJavaScript },
        {
          x: 1,
          y: 2,
          isEditable: true,
          misspelledWord: "helo",
          dictionarySuggestions: ["hello"],
        },
      ),
    ).resolves.toEqual({
      word: "helo",
      suggestions: ["hello"],
    });
  });

  it("asks the renderer when suggestions are missing for an editable field", async () => {
    const executeJavaScript = async (code: string) => {
      expect(code).toContain(DESKTOP_SPELLING_BRIDGE);
      expect(code).toContain('"helo"');
      return { word: "helo", suggestions: ["hello"] };
    };
    await expect(
      resolveContextMenuSpelling(
        { isDestroyed: () => false, executeJavaScript },
        {
          x: 1,
          y: 2,
          isEditable: true,
          misspelledWord: "helo",
          dictionarySuggestions: [],
        },
      ),
    ).resolves.toEqual({
      word: "helo",
      suggestions: ["hello"],
    });
  });

  it("recovers spelling at the click point when Chromium omits misspelledWord", async () => {
    const executeJavaScript = async (code: string) => {
      expect(code).toContain("wordAtPoint(8, 9)");
      return { word: "teh", suggestions: ["the", "tech"] };
    };
    await expect(
      resolveContextMenuSpelling(
        { isDestroyed: () => false, executeJavaScript },
        {
          x: 8,
          y: 9,
          isEditable: true,
          misspelledWord: "",
          dictionarySuggestions: [],
        },
      ),
    ).resolves.toEqual({
      word: "teh",
      suggestions: ["the", "tech"],
    });
  });

  it("skips renderer fallback for non-editable surfaces without a misspelled word", async () => {
    const executeJavaScript = async () => {
      throw new Error("should not run");
    };
    await expect(
      resolveContextMenuSpelling(
        { isDestroyed: () => false, executeJavaScript },
        {
          x: 1,
          y: 2,
          isEditable: false,
          misspelledWord: "",
          dictionarySuggestions: [],
        },
      ),
    ).resolves.toBeNull();
  });
});
