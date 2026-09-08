"use strict";

/**
 * Tidies raw transcription output: collapses whitespace, capitalises sentence
 * starts, and ensures terminal punctuation.
 *
 * Ported from the Rust implementation; the unit tests carried over unchanged so
 * behaviour is identical.
 */
function cleanupText(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) return "";

  const normalized = trimmed.split(/\s+/).filter(Boolean).join(" ");

  let result = "";
  let capitalizeNext = true;

  for (const ch of normalized) {
    if (capitalizeNext && /\p{L}/u.test(ch)) {
      result += ch.toUpperCase();
      capitalizeNext = false;
    } else {
      result += ch;
      if (ch === "." || ch === "!" || ch === "?") {
        capitalizeNext = true;
      }
    }
  }

  const last = result.at(-1);
  if (last && ![".", "!", "?"].includes(last)) {
    result += ".";
  }

  return result;
}

module.exports = { cleanupText };
