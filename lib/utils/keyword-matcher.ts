/**
 * Keyword Matcher
 *
 * Matches comment text against a set of keywords with support for:
 * - Case-insensitive matching
 * - Whole-word or partial matching
 * - Multi-keyword OR logic (any match = true)
 * - Emoji and special character stripping
 */

export interface KeywordMatchResult {
  matched: boolean;
  matchedKeyword: string | null;
}

/**
 * Strip emojis and special characters from text, keeping only
 * letters, numbers and whitespace — in any script.
 *
 * Letters are matched with the Unicode property \p{L} rather than \w, because
 * \w is ASCII-only: it would reduce "किंमत काय आहे" to an empty string and the
 * keyword would silently never match. Indian audiences comment and DM in
 * Devanagari as often as in romanised Hinglish, so both have to survive here.
 * \p{M} keeps combining marks (matras), without which "किंमत" loses its vowels.
 */
export function stripSpecialCharacters(text: string): string {
  // Remove emoji ranges and other special unicode chars
  return text
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu,
      ""
    )
    .replace(/[^\p{L}\p{N}\p{M}_\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the string contains a character outside the ASCII range that \b
 * understands. JavaScript's \b sits between a \w and a non-\w character, and
 * \w is ASCII-only, so every Devanagari character counts as a boundary: a
 * "whole word" search for "किंमत" matches nothing at all. For those scripts we
 * fall back to substring matching, which is the behaviour users expect anyway.
 */
function hasNonAsciiWordChars(text: string): boolean {
  return /[^\p{ASCII}]/u.test(text);
}

/**
 * Check if a comment text matches any of the given keywords.
 *
 * @param commentText - The raw comment text to check
 * @param keywords - Array of keywords to match against
 * @param wholeWordMatch - If true, keyword must be a standalone word.
 *                         If false, partial matches are allowed (e.g. "linking" matches "link")
 * @returns Match result with the first matched keyword (if any)
 */
export function matchKeywords(
  commentText: string,
  keywords: string[],
  wholeWordMatch: boolean = true
): KeywordMatchResult {
  if (!commentText || keywords.length === 0) {
    return { matched: false, matchedKeyword: null };
  }

  const cleanedText = stripSpecialCharacters(commentText).toLowerCase();

  if (!cleanedText) {
    return { matched: false, matchedKeyword: null };
  }

  for (const keyword of keywords) {
    const cleanedKeyword = stripSpecialCharacters(keyword).toLowerCase();

    if (!cleanedKeyword) continue;

    if (wholeWordMatch && !hasNonAsciiWordChars(cleanedKeyword)) {
      // Build a regex for whole-word matching
      const escapedKeyword = cleanedKeyword.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );
      const regex = new RegExp(`\\b${escapedKeyword}\\b`, "i");
      if (regex.test(cleanedText)) {
        return { matched: true, matchedKeyword: keyword };
      }
    } else {
      // Partial match — keyword substring exists anywhere in the cleaned text
      if (cleanedText.includes(cleanedKeyword)) {
        return { matched: true, matchedKeyword: keyword };
      }
    }
  }

  return { matched: false, matchedKeyword: null };
}
