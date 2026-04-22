// Pure CJK segmentation helpers. No Obsidian / CodeMirror imports so this
// module can be unit-tested in plain Node.

// ─── Types ───────────────────────────────────────────────────────────────────

export type Segment = {
  from: number;
  to: number;
  isWordLike: boolean;
  text: string;
};

export type SegmenterToken = {
  segment: string;
  index: number;
  isWordLike?: boolean;
};

export type WordSegmenter = {
  segment(input: string): Iterable<SegmenterToken>;
};

// ─── CJK detection ───────────────────────────────────────────────────────────

export const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const JA_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
export const KO_CHAR = /[\p{Script=Hangul}]/u;
export const WHITESPACE = /\s/;

export function isCjk(ch: string): boolean {
  return CJK_CHAR.test(ch);
}

// ─── Fallback segmentation regexes (module-level to avoid re-construction) ────

/** Tokenises a line into CJK runs, word/number runs, whitespace, and single punctuation chars. */
const FALLBACK_SEGMENT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Letter}\p{Number}_]+|\s+|[^\s]/gu;
/** Matches a string that contains *no* word-like characters (pure punctuation / whitespace). */
const FALLBACK_ISWORD_RE = /^[^\p{Letter}\p{Number}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}_]+$/u;

// ─── SegmenterService ─────────────────────────────────────────────────────────

export class SegmenterService {
  // 128 entries cover typical CJK editing sessions without excessive memory use
  private static readonly CACHE_MAX = 128;
  private readonly segmenters: Partial<Record<string, WordSegmenter>> = {};
  private readonly hasIntlSegmenter: boolean;
  // Map preserves insertion order; delete+reinsert on hit gives O(1) LRU
  private readonly cache = new Map<string, Segment[]>();

  constructor() {
    const IntlAny = Intl as unknown as {
      Segmenter?: new (locale: string, options: { granularity: "word" }) => WordSegmenter;
    };
    if (IntlAny.Segmenter) {
      for (const locale of ["zh", "ja", "ko"] as const) {
        this.segmenters[locale] = new IntlAny.Segmenter(locale, { granularity: "word" });
      }
      this.hasIntlSegmenter = true;
    } else {
      this.hasIntlSegmenter = false;
    }
  }

  /** Pick the best locale for a text snippet based on script presence. */
  private localeFor(text: string): string {
    if (JA_CHAR.test(text)) return "ja";
    if (KO_CHAR.test(text)) return "ko";
    return "zh";
  }

  lineSegments(text: string): Segment[] {
    // LRU hit: refresh position by delete+reinsert
    const hit = this.cache.get(text);
    if (hit) {
      this.cache.delete(text);
      this.cache.set(text, hit);
      return hit;
    }

    const raw = this.hasIntlSegmenter ? this.segmentWithIntl(text) : this.segmentWithFallback(text);
    // Guarantee at least one segment so callers never receive an empty array
    const segments = raw.length === 0 && text.length > 0 ? [{ from: 0, to: text.length, isWordLike: true, text }] : raw;

    // Evict oldest entry when at capacity
    if (this.cache.size >= SegmenterService.CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest === "string") this.cache.delete(oldest);
    }
    this.cache.set(text, segments);
    return segments;
  }

  private segmentWithIntl(text: string): Segment[] {
    const locale = this.localeFor(text);
    const segmenter = this.segmenters[locale]!;
    const out: Segment[] = [];
    for (const token of segmenter.segment(text)) {
      const from = token.index;
      const to = from + token.segment.length;
      if (from === to) continue;
      out.push({ from, to, isWordLike: Boolean(token.isWordLike), text: token.segment });
    }
    return out;
  }

  private segmentWithFallback(text: string): Segment[] {
    const out: Segment[] = [];
    // matchAll returns a fresh stateful iterator per call without mutating the regex,
    // so the shared module-level instance is safe to use concurrently.
    for (const match of text.matchAll(FALLBACK_SEGMENT_RE)) {
      const segText = match[0];
      const from = match.index ?? 0;
      const to = from + segText.length;
      // A segment is word-like unless it is entirely punctuation/whitespace
      const isWordLike = !FALLBACK_ISWORD_RE.test(segText);
      out.push({ from, to, isWordLike, text: segText });
    }
    return out;
  }
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Find the segment that contains `localPos` within an already-tokenised line.
 * Primary pass: half-open [from, to) — forward-biased at exact boundaries.
 * Fallback pass: cursor sits exactly at a segment's `to` (e.g. end-of-line).
 */
export function findSegmentAt(segments: Segment[], localPos: number): Segment | undefined {
  for (const seg of segments) {
    if (localPos >= seg.from && localPos < seg.to) return seg;
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]!.to === localPos) return segments[i];
  }
  return undefined;
}

/**
 * True if the non-whitespace run that an Alt-Backspace / Alt-Delete operation
 * would reach from `localPos` contains any CJK char.
 *
 * Direction semantics (matches the operation's direction):
 *   -1 → look backward only; skip whitespace immediately before the cursor, then
 *        scan the preceding non-whitespace run. Covers `中文 |` + Alt-Backspace,
 *        where the cursor is separated from CJK by trailing whitespace.
 *    1 → look forward only; symmetric.
 *    0 → bidirectional (used by wordAt / double-click).
 *
 * Interleaves the whitespace-boundary scan with the CJK check so we short-circuit
 * on the first CJK char found — essentially O(1) for typical CJK content.
 *
 * CJK is tested on a 2-char window so astral-plane characters (U+20000+, e.g.
 * CJK Extension B/C/D/E) encoded as UTF-16 surrogate pairs match correctly.
 * Cursor positions are always at code-point boundaries in CM6, so each window
 * either contains a full pair or no surrogate at all.
 */
export function runHasCjk(text: string, localPos: number, direction: 1 | -1 | 0 = 0): boolean {
  if (direction <= 0) {
    let i = localPos - 1;
    while (i >= 0 && WHITESPACE.test(text.charAt(i))) i--;
    for (; i >= 0; i--) {
      const ch = text.charAt(i);
      if (WHITESPACE.test(ch)) break;
      if (CJK_CHAR.test(text.slice(Math.max(0, i - 1), i + 1))) return true;
    }
  }
  if (direction >= 0) {
    let j = localPos;
    while (j < text.length && WHITESPACE.test(text.charAt(j))) j++;
    for (; j < text.length; j++) {
      const ch = text.charAt(j);
      if (WHITESPACE.test(ch)) break;
      if (CJK_CHAR.test(text.slice(j, Math.min(text.length, j + 2)))) return true;
    }
  }
  return false;
}
