/**
 * Desktop spelling helpers for the native context menu.
 *
 * Chromium often draws misspelling underlines in contenteditable editors
 * (including Lexical) while leaving `ContextMenuParams.misspelledWord` empty,
 * or returns the word with an empty `dictionarySuggestions` list on macOS
 * "Automatic by Language". The preload bridge uses `webFrame` to recover both.
 */

export const DESKTOP_SPELLING_BRIDGE = "__t3DesktopSpelling";

export type DesktopSpellingResult = {
  readonly word: string;
  readonly suggestions: readonly string[];
};

export type DesktopSpellingBridge = {
  readonly wordAtPoint: (x: number, y: number) => string | null;
  readonly resolve: (word: string) => DesktopSpellingResult | null;
};

const MAX_SUGGESTIONS = 5;

export function resolveSpellingFromParams(params: {
  readonly misspelledWord: string;
  readonly dictionarySuggestions: readonly string[];
}): DesktopSpellingResult | null {
  if (!params.misspelledWord) return null;
  return {
    word: params.misspelledWord,
    suggestions: params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS),
  };
}

export function parseDesktopSpellingResult(value: unknown): DesktopSpellingResult | null {
  if (typeof value !== "object" || value === null) return null;
  const { word, suggestions } = value as {
    word?: unknown;
    suggestions?: unknown;
  };
  if (typeof word !== "string" || word.length === 0 || !Array.isArray(suggestions)) {
    return null;
  }
  const normalizedSuggestions = suggestions
    .filter((suggestion): suggestion is string => typeof suggestion === "string")
    .slice(0, MAX_SUGGESTIONS);
  return { word, suggestions: normalizedSuggestions };
}

/**
 * Script run in the page main world. Calls the preload-exposed spelling bridge
 * so we can use `webFrame` without turning on nodeIntegration.
 */
export function buildSpellingResolveExpression(input: {
  readonly x: number;
  readonly y: number;
  readonly word: string;
}): string {
  return `(function () {
  var bridge = window[${JSON.stringify(DESKTOP_SPELLING_BRIDGE)}];
  if (!bridge || typeof bridge.resolve !== "function") return null;
  var word = ${JSON.stringify(input.word)};
  if (!word && typeof bridge.wordAtPoint === "function") {
    word = bridge.wordAtPoint(${JSON.stringify(input.x)}, ${JSON.stringify(input.y)});
  }
  if (typeof word !== "string" || word.length === 0) return null;
  return bridge.resolve(word);
})()`;
}

export function readWordAtPointFromDocument(
  doc: {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  },
  x: number,
  y: number,
): string | null {
  const range = doc.caretRangeFromPoint?.(x, y) ?? null;
  if (!range || range.startContainer.nodeType !== 3 /* Node.TEXT_NODE */) {
    return null;
  }

  const textNode = range.startContainer as Text;
  const text = textNode.data;
  if (text.length === 0) return null;

  let offset = range.startOffset;
  if (offset >= text.length) offset = text.length - 1;
  if (offset < 0) return null;

  const isWordChar = (ch: string) => /[\p{L}\p{N}']/u.test(ch);
  if (!isWordChar(text.charAt(offset))) {
    if (offset > 0 && isWordChar(text.charAt(offset - 1))) {
      offset -= 1;
    } else {
      return null;
    }
  }

  let start = offset;
  let end = offset + 1;
  while (start > 0 && isWordChar(text.charAt(start - 1))) start -= 1;
  while (end < text.length && isWordChar(text.charAt(end))) end += 1;

  const word = text.slice(start, end);
  return word.length > 0 ? word : null;
}

export function createDesktopSpellingBridge(input: {
  readonly isWordMisspelled: (word: string) => boolean;
  readonly getWordSuggestions: (word: string) => string[];
  readonly readWordAtPoint?: (x: number, y: number) => string | null;
}): DesktopSpellingBridge {
  const readWordAtPoint =
    input.readWordAtPoint ??
    ((x, y) =>
      typeof document === "undefined" ? null : readWordAtPointFromDocument(document, x, y));

  return {
    wordAtPoint: readWordAtPoint,
    resolve: (word) => {
      if (!word || !input.isWordMisspelled(word)) return null;
      return {
        word,
        suggestions: input.getWordSuggestions(word).slice(0, MAX_SUGGESTIONS),
      };
    },
  };
}

export async function resolveContextMenuSpelling(
  contents: {
    readonly isDestroyed: () => boolean;
    readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  },
  params: {
    readonly x: number;
    readonly y: number;
    readonly isEditable: boolean;
    readonly misspelledWord: string;
    readonly dictionarySuggestions: readonly string[];
  },
): Promise<DesktopSpellingResult | null> {
  const fromParams = resolveSpellingFromParams(params);
  if (fromParams && fromParams.suggestions.length > 0) {
    return fromParams;
  }

  // Non-editable surfaces never need a spelling block.
  if (!fromParams && !params.isEditable) {
    return null;
  }

  if (contents.isDestroyed()) {
    return fromParams;
  }

  try {
    const resolved = parseDesktopSpellingResult(
      await contents.executeJavaScript(
        buildSpellingResolveExpression({
          x: params.x,
          y: params.y,
          word: fromParams?.word ?? "",
        }),
        true,
      ),
    );
    if (resolved) return resolved;
  } catch {
    // Guest webviews and older preloads lack the bridge; keep params-only.
  }

  return fromParams;
}
