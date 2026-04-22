import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findSegmentAt, runHasCjk, SegmenterService } from "../segmenter.ts";

// ─── runHasCjk ─────────────────────────────────────────────────────────────
//
// This is the gate that decides whether Bamboo handles an Alt-Backspace /
// Alt-Delete / Alt-Arrow — false means fall through to the default behaviour.
// Every bug we've fixed lives here, so each case below maps to a regression.

describe("runHasCjk — mixed CJK + Latin (originally deleted whole run)", () => {
  // `中文asdfasdf|` + Alt-Backspace used to delete the whole string because the
  // gate only looked at the char *adjacent* to the cursor and saw Latin.
  test("cursor at end of `中文asdfasdf` activates backward", () => {
    assert.equal(runHasCjk("中文asdfasdf", 10, -1), true);
  });

  test("cursor at start of `中文asdfasdf` activates forward", () => {
    assert.equal(runHasCjk("中文asdfasdf", 0, 1), true);
  });

  test("cursor in middle of `asdf中文` activates bidirectionally", () => {
    assert.equal(runHasCjk("asdf中文", 2, 0), true);
  });
});

describe("runHasCjk — astral-plane CJK (surrogate pair regression)", () => {
  // `𠀀` is U+20000 (CJK Extension B), encoded in UTF-16 as 2 code units.
  // The initial fix checked one code unit at a time, so the lone surrogate
  // didn't match `\p{Script=Han}` and the gate returned false.
  // Fixed by testing a 2-char window so the full surrogate pair is visible.
  const astralCjkLatin = "𠀀asdf"; // length 6 (2 + 4)

  test("cursor at end activates backward", () => {
    assert.equal(runHasCjk(astralCjkLatin, astralCjkLatin.length, -1), true);
  });

  test("cursor at start activates forward", () => {
    assert.equal(runHasCjk(astralCjkLatin, 0, 1), true);
  });

  test("astral char alone activates", () => {
    assert.equal(runHasCjk("𠀀", 2, -1), true);
  });
});

describe("runHasCjk — trailing/leading whitespace (whitespace-skip regression)", () => {
  // `很长的中文 |` + Alt-Backspace used to delete the whole CJK run because
  // the gate only looked at the char immediately before the cursor (a space)
  // and returned false, so the whole gate fell through.
  // Fixed by making the backward scan skip trailing whitespace first.

  test("single trailing space — backward activates", () => {
    assert.equal(runHasCjk("很长的中文 ", 6, -1), true);
  });

  test("single trailing space — forward does NOT activate", () => {
    assert.equal(runHasCjk("很长的中文 ", 6, 1), false);
  });

  test("multiple trailing spaces — backward activates", () => {
    assert.equal(runHasCjk("中文   ", 5, -1), true);
  });

  test("single leading space — forward activates", () => {
    assert.equal(runHasCjk(" 中文很长", 0, 1), true);
  });

  test("single leading space — backward does NOT activate", () => {
    assert.equal(runHasCjk(" 中文很长", 0, -1), false);
  });

  test("mixed whitespace (tab + space) — backward activates", () => {
    assert.equal(runHasCjk("中文\t ", 4, -1), true);
  });
});

describe("runHasCjk — whitespace isolates runs (no over-activation)", () => {
  // The whitespace-skip fix must NOT cross the whitespace barrier into
  // unrelated runs — otherwise `中文 asdfasdf|` + Alt-Backspace would
  // incorrectly take over and delete something on the wrong side.

  test("cursor at end of Latin run separated by space from CJK — backward inactive", () => {
    assert.equal(runHasCjk("中文 asdfasdf", 12, -1), false);
  });

  test("cursor between space and Latin tail — forward inactive (Latin-only forward)", () => {
    assert.equal(runHasCjk("中文 asdfasdf", 3, 1), false);
  });

  test("cursor between space and Latin tail — backward still activates (CJK behind)", () => {
    assert.equal(runHasCjk("中文 asdfasdf", 3, -1), true);
  });
});

describe("runHasCjk — pure Latin (never activate)", () => {
  test("cursor at end of `asdfasdf` — backward inactive", () => {
    assert.equal(runHasCjk("asdfasdf", 8, -1), false);
  });

  test("cursor at start of `asdfasdf` — forward inactive", () => {
    assert.equal(runHasCjk("asdfasdf", 0, 1), false);
  });

  test("cursor mid-Latin — bidirectional inactive", () => {
    assert.equal(runHasCjk("hello world", 5, 0), false);
  });
});

describe("runHasCjk — pure CJK (always activate)", () => {
  test("cursor at end of `中文很长` — backward activates", () => {
    assert.equal(runHasCjk("中文很长", 4, -1), true);
  });

  test("cursor at start of `中文很长` — forward activates", () => {
    assert.equal(runHasCjk("中文很长", 0, 1), true);
  });

  test("Japanese hiragana", () => {
    assert.equal(runHasCjk("こんにちは", 5, -1), true);
  });

  test("Korean hangul", () => {
    assert.equal(runHasCjk("안녕하세요", 5, -1), true);
  });
});

describe("runHasCjk — edge cases", () => {
  test("empty text", () => {
    assert.equal(runHasCjk("", 0, -1), false);
    assert.equal(runHasCjk("", 0, 1), false);
    assert.equal(runHasCjk("", 0, 0), false);
  });

  test("whitespace-only text", () => {
    assert.equal(runHasCjk("   ", 3, -1), false);
    assert.equal(runHasCjk("   ", 0, 1), false);
  });

  test("direction=0 is bidirectional (wordAt fast-path)", () => {
    assert.equal(runHasCjk("中文asdf", 6, 0), true);
    assert.equal(runHasCjk("asdfasdf", 4, 0), false);
  });
});

// ─── SegmenterService ──────────────────────────────────────────────────────
//
// Sanity checks that the underlying segmenter does what we expect — so the
// regressions above aren't papering over a segmenter bug.

describe("SegmenterService.lineSegments", () => {
  const service = new SegmenterService();

  test("splits `中文asdfasdf` into CJK + Latin runs", () => {
    const segs = service.lineSegments("中文asdfasdf");
    const wordLike = segs.filter((s) => s.isWordLike).map((s) => s.text);
    assert.deepEqual(wordLike, ["中文", "asdfasdf"]);
  });

  test("splits `中文asdf中文` into three runs", () => {
    const segs = service.lineSegments("中文asdf中文");
    const wordLike = segs.filter((s) => s.isWordLike).map((s) => s.text);
    assert.deepEqual(wordLike, ["中文", "asdf", "中文"]);
  });

  test("isolates trailing whitespace as a non-word segment", () => {
    const segs = service.lineSegments("中文 ");
    const last = segs[segs.length - 1]!;
    assert.equal(last.text, " ");
    assert.equal(last.isWordLike, false);
    assert.equal(last.from, 2);
    assert.equal(last.to, 3);
  });

  test("empty text returns no segments", () => {
    assert.deepEqual(service.lineSegments(""), []);
  });

  test("cache returns the same array reference on repeat call", () => {
    const a = service.lineSegments("缓存测试");
    const b = service.lineSegments("缓存测试");
    assert.equal(a, b);
  });
});

// ─── findSegmentAt ─────────────────────────────────────────────────────────

describe("findSegmentAt", () => {
  const service = new SegmenterService();

  test("cursor inside a segment returns that segment", () => {
    const segs = service.lineSegments("中文asdfasdf");
    const found = findSegmentAt(segs, 5); // inside `asdfasdf` (from=2, to=10)
    assert.equal(found?.text, "asdfasdf");
  });

  test("cursor at end-of-text falls back to last segment", () => {
    const segs = service.lineSegments("中文asdfasdf");
    const found = findSegmentAt(segs, 10);
    assert.equal(found?.text, "asdfasdf");
  });

  test("cursor at forward boundary prefers the forward segment", () => {
    const segs = service.lineSegments("中文asdfasdf");
    // Position 2 is the boundary between `中文` (0..2) and `asdfasdf` (2..10).
    // Primary pass uses half-open [from, to), so forward segment wins.
    const found = findSegmentAt(segs, 2);
    assert.equal(found?.text, "asdfasdf");
  });
});
