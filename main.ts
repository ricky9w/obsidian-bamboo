import { EditorSelection, EditorState, Extension, Prec } from "@codemirror/state";
import { EditorView, keymap, type MouseSelectionStyle } from "@codemirror/view";
import { Plugin } from "obsidian";
import { findSegmentAt, isCjk, runHasCjk, type Segment, SegmenterService } from "./segmenter";

// ─── CM6-bound helpers ────────────────────────────────────────────────────────

function segmentAt(state: EditorView["state"], service: SegmenterService, pos: number): { lineFrom: number; lineTo: number; segment: Segment } | null {
  const line = state.doc.lineAt(pos);
  const localPos = Math.min(Math.max(pos - line.from, 0), line.length);
  const seg = findSegmentAt(service.lineSegments(line.text), localPos);
  return seg ? { lineFrom: line.from, lineTo: line.to, segment: seg } : null;
}

function hasCjkAround(state: EditorView["state"], pos: number, direction: 1 | -1 | 0 = 0): boolean {
  const line = state.doc.lineAt(pos);
  return runHasCjk(line.text, pos - line.from, direction);
}

/**
 * Walk segment boundaries in `direction` from `pos`.
 * Uses the line structure directly — no magic iteration counter.
 */
function nextBoundary(state: EditorView["state"], service: SegmenterService, pos: number, direction: 1 | -1): number {
  if (direction === 1 && pos >= state.doc.length) return state.doc.length;
  if (direction === -1 && pos <= 0) return 0;

  let cursor = pos;

  while (true) {
    const line = state.doc.lineAt(cursor);
    const localPos = cursor - line.from;
    const segments = service.lineSegments(line.text);

    if (direction === 1) {
      for (const seg of segments) {
        if (seg.from > localPos) return line.from + seg.from;
        if (localPos >= seg.from && localPos < seg.to) return line.from + seg.to;
      }
      // Exhausted line — jump to start of next line
      if (line.to < state.doc.length) {
        cursor = line.to + 1;
        continue;
      }
      return state.doc.length;
    }

    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      if (seg.to < localPos) return line.from + seg.to;
      if (localPos > seg.from && localPos <= seg.to) return line.from + seg.from;
    }
    // Exhausted line — jump to end of previous line
    if (line.from > 0) {
      cursor = line.from - 1;
      continue;
    }
    return 0;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function moveGroupBySegmenter(service: SegmenterService, direction: 1 | -1, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    if (!hasCjkAround(state, state.selection.main.head, direction)) return false;

    const prev = state.selection;
    const nextRanges = prev.ranges.map((range) => {
      const target = nextBoundary(state, service, range.head, direction);
      return EditorSelection.range(extend ? range.anchor : target, target);
    });

    const changed = nextRanges.some((r, i) => {
      const p = prev.ranges[i];
      return !p || p.anchor !== r.anchor || p.head !== r.head;
    });
    if (!changed) return false;

    view.dispatch({
      selection: EditorSelection.create(nextRanges, prev.mainIndex),
      scrollIntoView: true,
      userEvent: extend ? "select.word" : "move.word",
    });
    return true;
  };
}

function deleteWordBySegmenter(service: SegmenterService, direction: 1 | -1) {
  return (view: EditorView): boolean => {
    const { state } = view;
    if (!hasCjkAround(state, state.selection.main.head, direction)) return false;

    const changes = state.changeByRange((range) => {
      // If something is already selected, just delete the selection
      if (!range.empty) {
        return { changes: { from: range.from, to: range.to }, range: EditorSelection.cursor(range.from) };
      }
      const target = nextBoundary(state, service, range.head, direction);
      const from = direction === 1 ? range.head : target;
      const to = direction === 1 ? target : range.head;
      if (from === to) return { changes: [], range };
      return { changes: { from, to }, range: EditorSelection.cursor(from) };
    });

    if (!changes.changes.empty) {
      view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "delete.word" }));
    }
    return !changes.changes.empty;
  };
}

// ─── CM6 Extension ───────────────────────────────────────────────────────────

function createBambooExtension(service: SegmenterService): Extension {
  const keyboard = Prec.high(
    keymap.of([
      // Navigation — macOS: Option+Arrow; Win/Linux: Ctrl+Arrow
      // `mac` overrides the cross-platform `key` on macOS.
      // `shift` automatically handles the Shift+key variant.
      // Commands return false when not on CJK text, so they safely fall through.
      { key: "Ctrl-ArrowLeft", mac: "Alt-ArrowLeft", run: moveGroupBySegmenter(service, -1, false), shift: moveGroupBySegmenter(service, -1, true) },
      { key: "Ctrl-ArrowRight", mac: "Alt-ArrowRight", run: moveGroupBySegmenter(service, 1, false), shift: moveGroupBySegmenter(service, 1, true) },
      // Word delete — macOS: Alt+Backspace/Delete; Win/Linux: Ctrl+Backspace/Delete
      { key: "Ctrl-Backspace", mac: "Alt-Backspace", run: deleteWordBySegmenter(service, -1) },
      { key: "Ctrl-Delete", mac: "Alt-Delete", run: deleteWordBySegmenter(service, 1) },
    ]),
  );

  const mouseSelection = Prec.high(
    EditorView.mouseSelectionStyle.of((view, event) => {
      if (event.button !== 0 || event.detail !== 2) return null;

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return null;

      const initial = segmentAt(view.state, service, pos);
      if (!initial || !isCjk(initial.segment.text)) return null;

      // Anchor the initial word boundaries; drag extends to cover more words
      const anchorFrom = initial.lineFrom + initial.segment.from;
      const anchorTo = initial.lineFrom + initial.segment.to;

      const style: MouseSelectionStyle = {
        get(curEvent, _extend, _multiple) {
          let selFrom = anchorFrom;
          let selTo = anchorTo;
          let draggingLeft = false;

          const currentPos = view.posAtCoords({ x: curEvent.clientX, y: curEvent.clientY });
          if (currentPos != null) {
            const cur = segmentAt(view.state, service, currentPos);
            if (cur && isCjk(cur.segment.text)) {
              const curFrom = cur.lineFrom + cur.segment.from;
              const curTo = cur.lineFrom + cur.segment.to;
              selFrom = Math.min(selFrom, curFrom);
              selTo = Math.max(selTo, curTo);
              // Track drag direction so the cursor (head) follows the drag tip
              draggingLeft = curFrom < anchorFrom;
            } else {
              // Dragged off CJK text — extend to the raw cursor position rather than freezing
              if (currentPos < anchorFrom) {
                selFrom = currentPos;
                draggingLeft = true;
              } else if (currentPos > anchorTo) {
                selTo = currentPos;
              }
            }
          }

          // anchor=right / head=left when dragging left, and vice versa
          return draggingLeft ? EditorSelection.single(selTo, selFrom) : EditorSelection.single(selFrom, selTo);
        },
        update() {},
      };

      return style;
    }),
  );

  return [keyboard, mouseSelection];
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class BambooPlugin extends Plugin {
  override onload(): void {
    const service = new SegmenterService();
    this.registerEditorExtension(createBambooExtension(service));
    this.patchWordAt(service);
  }

  /**
   * Monkey-patch EditorState.prototype.wordAt so that double-click in Reading
   * View, Ctrl+D (select word), and all other wordAt consumers respect CJK
   * segment boundaries — not just the CM6 editor panel.
   *
   * The original is restored on plugin unload via this.register().
   */
  private patchWordAt(service: SegmenterService): void {
    // EditorState.wordAt returns SelectionRange | null
    type WordAtFn = (pos: number) => ReturnType<EditorState["wordAt"]>;
    const proto = EditorState.prototype as EditorState & { wordAt: WordAtFn };
    const original = proto.wordAt;

    proto.wordAt = function (pos: number) {
      const line = this.doc.lineAt(pos);
      const localPos = pos - line.from;

      // Fast-path: skip CJK logic if the surrounding non-whitespace run has no CJK.
      // Checking only the adjacent chars misses mixed words like `中文asdf` where
      // a click/select on the Latin tail would otherwise fall back to the original
      // wordAt and return the whole mixed run.
      if (!runHasCjk(line.text, localPos)) {
        return original.call(this, pos);
      }

      const found = findSegmentAt(service.lineSegments(line.text), localPos);

      if (!found?.isWordLike) return original.call(this, pos);
      return EditorSelection.range(line.from + found.from, line.from + found.to);
    };

    this.register(() => {
      proto.wordAt = original;
    });
  }
}
