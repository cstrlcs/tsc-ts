/**
 * Span maps: how the virtual text a content mapper produces corresponds to the original text of the file.
 *
 * A source map records points and leaves spans and "no origin" implicit. A span map records segments, each
 * mapping a range of the virtual text to a range of the original. A virtual position outside every segment is
 * synthesized: it has no original counterpart. Positions are UTF-16 offsets, as everywhere in the compiler,
 * where tsgo counts UTF-8 bytes.
 *
 * ```ts
 * const map = new SpanMap([new SpanMapSegment(0, 10, 100, 110, SpanMapKind.Verbatim, SpanMapFeature.All)]);
 * map.virtualToOriginalSpan(3, 7); // pos 103, end 107, SpanMapFidelity.Exact
 * map.originalToVirtualPositions(103, SpanMapFeature.Hover); // [position 3, SpanMapFidelity.Exact]
 * ```
 *
 * A file that no content mapper produced has no span map and maps to itself; callers test for the map, where
 * tsgo calls these methods on a nil map.
 */
import type { JsonValue } from './package-json.js';

/** How positions inside a segment relate the virtual span to the original span. */
export const enum SpanMapKind {
  /**
   * The virtual and original spans have the same length and the same text, and interior positions map one to
   * one. A virtual span inside a verbatim segment maps to an exact original span.
   */
  Verbatim,
  /**
   * The virtual span maps to the original span as a whole. The lengths may differ, so interior positions map
   * to the segment's endpoints. Used for renamed identifiers and short expressions.
   */
  Atom,
  /**
   * An atom whose virtual and original texts name the same entity, so a diagnostic about the virtual name may
   * show the original one.
   */
  Alias,
}

/**
 * The language service operations that may use a segment. Diagnostics are not among them: a diagnostic on
 * virtual text is always reported. Text edits need an exact verbatim mapping whatever the features.
 */
export const enum SpanMapFeature {
  None = 0,
  Hover = 1 << 0,
  SignatureHelp = 1 << 1,
  Completion = 1 << 2,
  Definition = 1 << 3,
  TypeDefinition = 1 << 4,
  Implementation = 1 << 5,
  References = 1 << 6,
  DocumentHighlights = 1 << 7,
  Rename = 1 << 8,
  CallHierarchy = 1 << 9,
  CodeActions = 1 << 10,
  Formatting = 1 << 11,
  InlayHints = 1 << 12,
  SemanticTokens = 1 << 13,
  FoldingRanges = 1 << 14,
  SelectionRanges = 1 << 15,
  LinkedEditing = 1 << 16,
  AutoInsert = 1 << 17,
  DocumentSymbols = 1 << 18,
  CodeLens = 1 << 19,
  All = (1 << 20) - 1,
}

/** How faithfully a mapped position or span reflects its source. */
export const enum SpanMapFidelity {
  /** The input was inside one verbatim segment and maps precisely. */
  Exact,
  /** The input was inside one atom segment and maps to that atom's span. */
  Atom,
  /** The input crossed segment boundaries; its endpoints were mapped and clamped. */
  Approximate,
  /** The input has no counterpart: it was entirely synthesized. */
  None,
}

/**
 * Maps the virtual range `[virtualStart, virtualEnd)` to the original range `[originalStart, originalEnd)`.
 * `features` selects the language service operations that use the segment; diagnostics and exact edit mapping
 * ignore it.
 */
export class SpanMapSegment {
  constructor(
    readonly virtualStart: number,
    readonly virtualEnd: number,
    readonly originalStart: number,
    readonly originalEnd: number,
    readonly kind: SpanMapKind,
    readonly features: SpanMapFeature,
  ) {}
}

/** One projection of a position and its fidelity. */
export class MappedPosition {
  constructor(
    readonly position: number,
    readonly fidelity: SpanMapFidelity,
  ) {}
}

/** One projection of a range, as `[pos, end)`, and its fidelity. */
export class MappedSpan {
  constructor(
    readonly pos: number,
    readonly end: number,
    readonly fidelity: SpanMapFidelity,
  ) {}
}

/** The ways a span map can be malformed, so a failure names what the mapper's author has to fix. */
export const enum MappingErrorKind {
  /** The segments overlap, run backwards, or extend past the end of the virtual text. */
  Overlap,
  /** A segment's original span lies outside the original text. */
  OutOfBounds,
  /** A verbatim segment's virtual and original texts differ. */
  VerbatimMismatch,
  /** A segment has a kind that is not a `SpanMapKind`. */
  Kind,
  /** A segment's features hold flags that are not a `SpanMapFeature`. */
  Feature,
}

/**
 * One span map validation failure and the offsets where it was found: `virtualPos` in the virtual text,
 * `originalPos` in the original. A kind that does not use one of them leaves it 0.
 */
export class MappingError {
  constructor(
    readonly kind: MappingErrorKind,
    readonly virtualPos: number,
    readonly originalPos: number,
  ) {}

  /** The invalid mapping and the offset at which it was detected, in tsgo's words. */
  error(): string {
    switch (this.kind) {
      case MappingErrorKind.Overlap:
        return `content mapper position mappings overlap or are out of order near virtual offset ${this.virtualPos}`;
      case MappingErrorKind.OutOfBounds:
        return `content mapper position mapping points outside the original content at original offset ${this.originalPos}`;
      case MappingErrorKind.VerbatimMismatch:
        return `content mapper verbatim mapping does not match the original content at virtual offset ${this.virtualPos}, original offset ${this.originalPos}`;
      case MappingErrorKind.Kind:
        return `content mapper position mapping has an invalid kind at virtual offset ${this.virtualPos}`;
      case MappingErrorKind.Feature:
        return `content mapper position mappings have invalid features near original offset ${this.originalPos}`;
    }
  }
}

/**
 * The segments in original-text order, with a complete binary tree over them: leaf `leafCount + i` holds the
 * original end of segment `i`, and every other node the greatest end below it. A point lookup skips a subtree
 * none of whose segments reaches the position.
 */
class OriginalIndex {
  constructor(
    readonly segments: readonly SpanMapSegment[],
    readonly leafCount: number,
    readonly maxEnds: readonly number[],
  ) {}
}

/** Segments with the same original range, which contain or touch a position. */
class SegmentGroupAtOriginalPosition {
  constructor(
    readonly segments: readonly SpanMapSegment[],
    /** Whether the position is the end of the range, and not also its start. */
    readonly atEnd: boolean,
  ) {}
}

/**
 * A sparse, ordered set of segments over a content mapper's virtual text. The segments need not cover the
 * text: a virtual position in no segment is synthesized, so an empty map describes fully synthesized text.
 */
export class SpanMap {
  /** The segments ordered by virtual start. */
  readonly segments: readonly SpanMapSegment[];
  /** The index for original-to-virtual lookups, built on first use. */
  private originalIndex: OriginalIndex | undefined = undefined;

  /** Copies `segments` and sorts the copy by virtual start. */
  constructor(segments: readonly SpanMapSegment[]) {
    this.segments = segments.slice().sort((a, b) => a.virtualStart - b.virtualStart);
  }

  /** Whether a mapping went through one verbatim segment, so its result can host a text edit. */
  static isExact(fidelity: SpanMapFidelity): boolean {
    return fidelity === SpanMapFidelity.Exact;
  }

  /** Whether a mapping went through one segment, verbatim or atom, so its result is a concrete location. */
  static isSingleSegment(fidelity: SpanMapFidelity): boolean {
    return fidelity === SpanMapFidelity.Exact || fidelity === SpanMapFidelity.Atom;
  }

  /** Whether the input had no counterpart, so the result is a synthesized gap. */
  static isNone(fidelity: SpanMapFidelity): boolean {
    return fidelity === SpanMapFidelity.None;
  }

  /**
   * Decodes the JSON tuples a content mapper sends: `[virtualStart, virtualLength, originalStart,
   * originalLength, kind]`, with the features as an optional sixth element. Five elements mean every feature.
   * `undefined` when the value is not an array of such tuples of 32-bit integers; `null` is the empty map. An
   * integer is written without a fraction and without an exponent: `3.0` and `1e2` are rejected, as by tsgo.
   */
  static unmarshal(value: JsonValue): SpanMap | undefined {
    if (value.type === 'null') return new SpanMap([]);
    if (value.type !== 'array') return undefined;
    const segments: SpanMapSegment[] = [];
    for (const item of value.items) {
      if (item.type !== 'array') return undefined;
      const tuple: number[] = [];
      for (const element of item.items) {
        // A `null` element decodes as 0, as it does into a Go integer.
        if (element.type === 'null') tuple.push(0);
        else if (element.type === 'number' && element.integer && (element.value | 0) === element.value)
          tuple.push(element.value);
        else return undefined;
      }
      if (tuple.length !== 5 && tuple.length !== 6) return undefined;
      segments.push(
        new SpanMapSegment(
          tuple[0],
          (tuple[0] + tuple[1]) | 0,
          tuple[2],
          (tuple[2] + tuple[3]) | 0,
          tuple[4],
          tuple.length === 6 ? tuple[5] : SpanMapFeature.All,
        ),
      );
    }
    return new SpanMap(segments);
  }

  /** Encodes the map as the JSON text `unmarshal` reads, with the features left out of a tuple that has all. */
  marshal(): string {
    const tuples: string[] = [];
    for (const segment of this.segments) {
      // Lengths wrap to 32 bits, as the ends did when the tuples were decoded.
      const virtualLength = (segment.virtualEnd - segment.virtualStart) | 0;
      const originalLength = (segment.originalEnd - segment.originalStart) | 0;
      let tuple = `${segment.virtualStart},${virtualLength},${segment.originalStart},${originalLength},${segment.kind}`;
      if (segment.features !== SpanMapFeature.All) tuple += `,${segment.features}`;
      tuples.push(`[${tuple}]`);
    }
    return `[${tuples.join(',')}]`;
  }

  /**
   * Checks the map against the virtual and the original text: the segments are ordered and disjoint in the
   * virtual text and stay inside it, every original span lies inside the original text, and the text of a
   * verbatim segment is the original's. Gaps are allowed and an empty map is valid. Returns the first
   * violation, or `undefined` for a valid map.
   */
  validate(virtual: string, original: string): MappingError | undefined {
    let previousVirtualEnd = 0;
    for (const segment of this.segments) {
      if (
        segment.virtualStart < previousVirtualEnd ||
        segment.virtualEnd < segment.virtualStart ||
        segment.virtualEnd > virtual.length
      )
        return new MappingError(MappingErrorKind.Overlap, segment.virtualStart, 0);
      previousVirtualEnd = segment.virtualEnd;
      if (
        segment.originalStart < 0 ||
        segment.originalEnd < segment.originalStart ||
        segment.originalEnd > original.length
      )
        return new MappingError(MappingErrorKind.OutOfBounds, segment.virtualStart, segment.originalEnd);
      if (
        segment.kind !== SpanMapKind.Verbatim &&
        segment.kind !== SpanMapKind.Atom &&
        segment.kind !== SpanMapKind.Alias
      )
        return new MappingError(MappingErrorKind.Kind, segment.virtualStart, segment.originalStart);
      if (
        segment.kind === SpanMapKind.Verbatim &&
        (segment.virtualEnd - segment.virtualStart !== segment.originalEnd - segment.originalStart ||
          virtual.slice(segment.virtualStart, segment.virtualEnd) !==
            original.slice(segment.originalStart, segment.originalEnd))
      )
        return new MappingError(MappingErrorKind.VerbatimMismatch, segment.virtualStart, segment.originalStart);
      if ((segment.features & ~SpanMapFeature.All) !== 0)
        return new MappingError(MappingErrorKind.Feature, segment.virtualStart, segment.originalStart);
    }
    return undefined;
  }

  /**
   * Maps the virtual range `[pos, end)` to an original range. A range inside one gap between segments, or in
   * an empty map, is synthesized: it maps to the insertion point in the original, with `None` fidelity. A
   * range that crosses segment boundaries maps its endpoints, with `Approximate` fidelity.
   */
  virtualToOriginalSpan(pos: number, end: number): MappedSpan {
    const virtualEnd = Math.max(end, pos);
    if (pos === virtualEnd) {
      const mapped = this.virtualToOriginalPosition(pos);
      return new MappedSpan(mapped.position, mapped.position, mapped.fidelity);
    }
    const [startIndex, startInside] = this.segmentIndexAt(pos);
    const [endIndex, endInside] = this.segmentIndexAt(virtualEnd - 1);
    if (startIndex === endIndex && startInside === endInside) {
      if (!startInside) {
        const position = this.insertionPoint(startIndex);
        return new MappedSpan(position, position, SpanMapFidelity.None);
      }
      const segment = this.segments[startIndex];
      if (segment.kind !== SpanMapKind.Verbatim)
        return new MappedSpan(segment.originalStart, segment.originalEnd, SpanMapFidelity.Atom);
      const originalStart = clamp(
        segment.originalStart + (pos - segment.virtualStart),
        segment.originalStart,
        segment.originalEnd,
      );
      const originalEnd = clamp(
        segment.originalStart + (virtualEnd - segment.virtualStart),
        originalStart,
        segment.originalEnd,
      );
      return new MappedSpan(originalStart, originalEnd, SpanMapFidelity.Exact);
    }
    const originalStart = this.mapBoundary(pos, startIndex, startInside, false);
    const originalEnd = Math.max(this.mapBoundary(virtualEnd, endIndex, endInside, true), originalStart);
    return new MappedSpan(originalStart, originalEnd, SpanMapFidelity.Approximate);
  }

  /**
   * Maps `[pos, end)` like `virtualToOriginalSpan`, with `None` fidelity unless contiguous segments that take
   * part in `feature` cover every position of the range; an empty range needs the segment that contains it to
   * take part. Diagnostics and edits use `virtualToOriginalSpan` instead.
   */
  virtualToOriginalSpanForFeature(pos: number, end: number, feature: SpanMapFeature): MappedSpan {
    const mapped = this.virtualToOriginalSpan(pos, end);
    if (this.virtualSpanSupportsFeature(pos, end, feature)) return mapped;
    return new MappedSpan(mapped.pos, mapped.end, SpanMapFidelity.None);
  }

  private virtualSpanSupportsFeature(pos: number, end: number, feature: SpanMapFeature): boolean {
    const virtualEnd = Math.max(end, pos);
    const [first, inside] = this.segmentIndexAt(pos);
    if (pos === virtualEnd) return inside && supportsFeature(this.segments[first], feature);
    if (!inside) return false;
    let coveredThrough = pos;
    for (let index = first; index < this.segments.length && coveredThrough < virtualEnd; index++) {
      const segment = this.segments[index];
      if (
        segment.virtualStart > coveredThrough ||
        segment.virtualEnd <= coveredThrough ||
        !supportsFeature(segment, feature)
      )
        return false;
      coveredThrough = segment.virtualEnd;
    }
    return coveredThrough >= virtualEnd;
  }

  /**
   * Maps a virtual position to the original position. A position in a gap, or in an empty map, is synthesized:
   * it maps to the insertion point, with `None` fidelity. A position in an atom maps to the atom's start.
   */
  virtualToOriginalPosition(pos: number): MappedPosition {
    const [index, inside] = this.segmentIndexAt(pos);
    if (!inside) return new MappedPosition(this.insertionPoint(index), SpanMapFidelity.None);
    const segment = this.segments[index];
    if (segment.kind !== SpanMapKind.Verbatim) return new MappedPosition(segment.originalStart, SpanMapFidelity.Atom);
    return new MappedPosition(
      clamp(segment.originalStart + (pos - segment.virtualStart), segment.originalStart, segment.originalEnd),
      SpanMapFidelity.Exact,
    );
  }

  /**
   * The original position of `pos` when it is unambiguously in verbatim text, and `undefined` otherwise. The
   * boundary after an atom, or after a verbatim segment whose original does not continue into this one, is
   * rejected, because the same virtual position describes either side.
   */
  virtualToOriginalPositionExact(pos: number): number | undefined {
    const [index, inside] = this.segmentIndexAt(pos);
    if (!inside) return undefined;
    const segment = this.segments[index];
    if (segment.kind !== SpanMapKind.Verbatim) return undefined;
    if (index > 0) {
      const previous = this.segments[index - 1];
      if (
        previous.virtualEnd === pos &&
        (previous.kind !== SpanMapKind.Verbatim || previous.originalEnd !== segment.originalStart)
      )
        return undefined;
    }
    return clamp(segment.originalStart + (pos - segment.virtualStart), segment.originalStart, segment.originalEnd);
  }

  /**
   * Maps `pos` like `virtualToOriginalPosition`, with `None` fidelity unless its segment takes part in
   * `feature`. Diagnostics and edits use `virtualToOriginalPosition` instead.
   */
  virtualToOriginalPositionForFeature(pos: number, feature: SpanMapFeature): MappedPosition {
    const mapped = this.virtualToOriginalPosition(pos);
    const [index, inside] = this.segmentIndexAt(pos);
    if (inside && supportsFeature(this.segments[index], feature)) return mapped;
    return new MappedPosition(mapped.position, SpanMapFidelity.None);
  }

  /**
   * The alias segment whose virtual range is exactly `[pos, end)`. A partial overlap is no match: a
   * diagnostic's text is substituted only when the diagnostic is about the whole virtual alias.
   */
  aliasForVirtualSpan(pos: number, end: number): SpanMapSegment | undefined {
    const [index, inside] = this.segmentIndexAt(pos);
    if (!inside) return undefined;
    const segment = this.segments[index];
    return segment.kind === SpanMapKind.Alias && pos === segment.virtualStart && end === segment.virtualEnd
      ? segment
      : undefined;
  }

  /**
   * The index of the segment that contains `pos` and `true`, or, when `pos` is in a gap, the index of the
   * segment before it (-1 when there is none) and `false`. The end of the last segment is inside it.
   */
  private segmentIndexAt(pos: number): [number, boolean] {
    const segments = this.segments;
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (segments[middle].virtualStart < pos) low = middle + 1;
      else high = middle;
    }
    if (low < segments.length && segments[low].virtualStart === pos) return [low, true];
    const previous = low - 1;
    if (previous < 0) return [previous, false];
    const end = segments[previous].virtualEnd;
    return [previous, pos < end || (previous === segments.length - 1 && pos === end)];
  }

  /** The original offset of synthesized text after segment `previous`: its original end, or 0 before the first. */
  private insertionPoint(previous: number): number {
    return previous < 0 ? 0 : this.segments[previous].originalEnd;
  }

  /**
   * Maps a boundary of a virtual range that crosses segments: a boundary in a gap to the gap's insertion
   * point, and one in an atom to the atom's original start, or to its end for the upper boundary (`high`).
   */
  private mapBoundary(pos: number, index: number, inside: boolean, high: boolean): number {
    if (!inside) return this.insertionPoint(index);
    const segment = this.segments[index];
    if (segment.kind !== SpanMapKind.Verbatim) return high ? segment.originalEnd : segment.originalStart;
    return clamp(segment.originalStart + (pos - segment.virtualStart), segment.originalStart, segment.originalEnd);
  }

  /**
   * Every virtual projection of an original position through a segment that takes part in `feature`, ordered
   * by virtual position. The end of a segment counts for a position, so a position two adjacent original spans
   * share has projections from both. Empty when no segment covers the position or none takes part.
   */
  originalToVirtualPositions(pos: number, feature: SpanMapFeature): MappedPosition[] {
    const results: MappedPosition[] = [];
    for (const group of this.segmentGroupsAtOriginalPosition(pos)) {
      for (const segment of group.segments) {
        if (!supportsFeature(segment, feature)) continue;
        let position = group.atEnd ? segment.virtualEnd : segment.virtualStart;
        let fidelity = SpanMapFidelity.Atom;
        if (segment.kind === SpanMapKind.Verbatim) {
          position = clamp(
            segment.virtualStart + (pos - segment.originalStart),
            segment.virtualStart,
            segment.virtualEnd,
          );
          fidelity = SpanMapFidelity.Exact;
        }
        if (!results.some((result) => result.position === position && result.fidelity === fidelity))
          results.push(new MappedPosition(position, fidelity));
      }
    }
    return results.sort((a, b) => a.position - b.position);
  }

  /**
   * Every virtual projection of the original range `[pos, end)` through segments that take part in `feature`.
   * A range inside one or more segments has one exact or atom result per segment.
   *
   * A range that starts in one group of segments and ends in another can have several virtual ranges. Suppose
   * two original segments are each copied twice into the virtual text:
   *
   * ```text
   * original:   [ A ][ B ]
   *                [---)       range from inside A to inside B
   *
   * virtual:    [ A ][ B ]      [ A ][ B ]
   *                ^   ^          ^   ^
   *              start end      start end
   *                1   3          11  13
   * ```
   *
   * The range may start at 1 or 11 and end at 3 or 13, and the map does not say which copy of A belongs with
   * which copy of B. The results are the smallest range around each location, [1,3) and [11,13), and not
   * [1,13), which holds both and code that may be unrelated to the original range. These results have
   * `Approximate` fidelity. Empty when a boundary is in no segment or in none that takes part.
   */
  originalToVirtualSpans(pos: number, end: number, feature: SpanMapFeature): MappedSpan[] {
    const originalEnd = Math.max(end, pos);
    if (pos === originalEnd) {
      const spans: MappedSpan[] = [];
      for (const mapped of this.originalToVirtualPositions(pos, feature))
        spans.push(new MappedSpan(mapped.position, mapped.position, mapped.fidelity));
      return spans;
    }
    const startSegments = this.segmentsAtOriginalPosition(pos);
    const endSegments = this.segmentsAtOriginalPosition(originalEnd - 1);
    if (startSegments.length === 0 || endSegments.length === 0) return [];
    const results: MappedSpan[] = [];
    for (const segment of startSegments) {
      if (originalEnd > segment.originalEnd || !supportsFeature(segment, feature)) continue;
      if (segment.kind !== SpanMapKind.Verbatim) {
        results.push(new MappedSpan(segment.virtualStart, segment.virtualEnd, SpanMapFidelity.Atom));
        continue;
      }
      const virtualStart = originalBoundaryProjection(segment, pos, false);
      const virtualEnd = clamp(
        segment.virtualStart + (originalEnd - segment.originalStart),
        virtualStart,
        segment.virtualEnd,
      );
      results.push(new MappedSpan(virtualStart, virtualEnd, SpanMapFidelity.Exact));
    }
    if (results.length > 0) return results.sort((a, b) => a.pos - b.pos);
    const starts = originalBoundaryProjections(startSegments, pos, feature, false);
    const ends = originalBoundaryProjections(endSegments, originalEnd, feature, true);
    for (let i = 0; i < starts.length; i++) {
      const virtualStart = starts[i];
      const virtualEnd = ends.find((candidate) => candidate >= virtualStart);
      if (virtualEnd === undefined || (i + 1 < starts.length && starts[i + 1] <= virtualEnd)) continue;
      results.push(new MappedSpan(virtualStart, virtualEnd, SpanMapFidelity.Approximate));
    }
    return results;
  }

  /**
   * The virtual projection of every part of the original range `[pos, end)` that a segment taking part in
   * `feature` covers, in virtual order. Unlike `originalToVirtualSpans`, a boundary in no segment does not
   * hide the segments inside the range.
   */
  originalToVirtualIntersectingSpans(pos: number, end: number, feature: SpanMapFeature): MappedSpan[] {
    if (pos === end) return this.originalToVirtualSpans(pos, end, feature);
    const results: MappedSpan[] = [];
    for (const segment of this.segments) {
      if (!supportsFeature(segment, feature)) continue;
      const start = Math.max(pos, segment.originalStart);
      const stop = Math.min(end, segment.originalEnd);
      if (start >= stop) continue;
      if (segment.kind !== SpanMapKind.Verbatim) {
        results.push(new MappedSpan(segment.virtualStart, segment.virtualEnd, SpanMapFidelity.Atom));
        continue;
      }
      results.push(
        new MappedSpan(
          segment.virtualStart + (start - segment.originalStart),
          segment.virtualStart + (stop - segment.originalStart),
          SpanMapFidelity.Exact,
        ),
      );
    }
    return results;
  }

  /**
   * The index over the original text. Sorting the segments dominates building the tree, so the first lookup
   * costs O(n log n); later ones visit only the branches that can hold a match.
   */
  private getOriginalIndex(): OriginalIndex {
    if (this.originalIndex !== undefined) return this.originalIndex;
    const segments = this.segments
      .slice()
      .sort(
        (a, b) => a.originalStart - b.originalStart || a.originalEnd - b.originalEnd || a.virtualStart - b.virtualStart,
      );
    let leafCount = 1;
    while (leafCount < segments.length) leafCount *= 2;
    const maxEnds: number[] = [];
    for (let i = 0; i < 2 * leafCount; i++) maxEnds.push(0);
    for (let i = 0; i < segments.length; i++) maxEnds[leafCount + i] = segments[i].originalEnd;
    for (let i = leafCount - 1; i > 0; i--) maxEnds[i] = Math.max(maxEnds[2 * i], maxEnds[2 * i + 1]);
    this.originalIndex = new OriginalIndex(segments, leafCount, maxEnds);
    return this.originalIndex;
  }

  /**
   * Every segment whose original range contains `pos`, in original-text order. A segment's end is outside it;
   * its start is inside, also when the segment is empty.
   */
  private segmentsAtOriginalPosition(pos: number): SpanMapSegment[] {
    const index = this.getOriginalIndex();
    // The tree finds the segments that start before `pos` and end after it. Those starting at `pos` follow, so
    // an empty segment is found although the tree skips every end that is not past `pos`.
    const start = firstSegmentStartingAt(index.segments, pos);
    const results: SpanMapSegment[] = [];
    collectSegmentsEndingAtOrAfter(index, 1, 0, index.leafCount, start, pos, false, results);
    const end = firstSegmentStartingAt(index.segments, pos + 1);
    for (let i = start; i < end; i++) results.push(index.segments[i]);
    return results;
  }

  /**
   * The groups of segments with equal original ranges that contain or touch `pos`; the end of a range touches.
   * At a boundary two ranges share, the segments that end at `pos` and those that start there are two groups:
   *
   * ```text
   * original:  [--- A ---)[--- B ---)
   *                       ^ pos
   *
   * virtual:   [ A1 ) [ A2 )    [ B1 ) [ B2 )
   *              left group       right group
   *              atEnd: true      atEnd: false
   * ```
   */
  private segmentGroupsAtOriginalPosition(pos: number): SegmentGroupAtOriginalPosition[] {
    const index = this.getOriginalIndex();
    const segments: SpanMapSegment[] = [];
    const limit = firstSegmentStartingAt(index.segments, pos + 1);
    collectSegmentsEndingAtOrAfter(index, 1, 0, index.leafCount, limit, pos, true, segments);
    const groups: SegmentGroupAtOriginalPosition[] = [];
    for (let start = 0; start < segments.length;) {
      const segment = segments[start];
      let end = start + 1;
      while (end < segments.length && sameOriginalRange(segment, segments[end])) end++;
      if (pos <= segment.originalEnd)
        groups.push(
          new SegmentGroupAtOriginalPosition(
            segments.slice(start, end),
            pos === segment.originalEnd && pos !== segment.originalStart,
          ),
        );
      start = end;
    }
    return groups;
  }
}

/**
 * Maps a boundary of an original range through a verbatim segment, which keeps the boundary's offset in the
 * segment, or through an atom, to its virtual start, or to its virtual end for the range's end (`high`).
 */
function originalBoundaryProjection(segment: SpanMapSegment, boundary: number, high: boolean): number {
  if (segment.kind !== SpanMapKind.Verbatim) return high ? segment.virtualEnd : segment.virtualStart;
  return clamp(segment.virtualStart + (boundary - segment.originalStart), segment.virtualStart, segment.virtualEnd);
}

/**
 * The projections, in ascending order, of a boundary of an original range through each of `segments` that
 * takes part in `feature`. For the start of the range, the segments are those that contain it, and each copy
 * of a duplicated segment has a result at the same offset:
 *
 * ```text
 * original:       [---------)
 *                    ^ start
 *
 * virtual:    [---------)   [---------)
 *                ^             ^
 *              result        result
 * ```
 *
 * For the end (`high`), the segments are those that contain the last character, `end - 1`, so an end at a
 * segment boundary takes the segment on its left, and the boundary mapped is `end` itself:
 *
 * ```text
 * original:       [---------)[ next segment )
 *                          ^`-- end
 *                          `--- end - 1
 *
 * virtual:    [---------)   [---------)
 *                       ^             ^
 *                     result        result
 * ```
 */
function originalBoundaryProjections(
  segments: readonly SpanMapSegment[],
  boundary: number,
  feature: SpanMapFeature,
  high: boolean,
): number[] {
  const results: number[] = [];
  for (const segment of segments)
    if (supportsFeature(segment, feature)) results.push(originalBoundaryProjection(segment, boundary, high));
  return results.sort((a, b) => a - b);
}

/** Whether two segments have the same original range, and so belong to one group of duplicates. */
function sameOriginalRange(left: SpanMapSegment, right: SpanMapSegment): boolean {
  return left.originalStart === right.originalStart && left.originalEnd === right.originalEnd;
}

/** The index of the first of `segments`, in original-text order, whose original start is `pos` or later. */
function firstSegmentStartingAt(segments: readonly SpanMapSegment[], pos: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].originalStart < pos) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Appends to `results`, in original-text order, the segments among the first `limit` whose original end is
 * past `pos`, or at `pos` with `includeEnd`. `node` is the tree node over the segments `[start, end)`; a node
 * past `limit`, or whose greatest end does not reach `pos`, is left without visiting its leaves.
 */
function collectSegmentsEndingAtOrAfter(
  index: OriginalIndex,
  node: number,
  start: number,
  end: number,
  limit: number,
  pos: number,
  includeEnd: boolean,
  results: SpanMapSegment[],
): void {
  const maxEnd = index.maxEnds[node];
  if (start >= limit || maxEnd < pos || (!includeEnd && maxEnd === pos)) return;
  if (end - start === 1) {
    results.push(index.segments[start]);
    return;
  }
  const middle = start + ((end - start) >>> 1);
  collectSegmentsEndingAtOrAfter(index, 2 * node, start, middle, limit, pos, includeEnd, results);
  collectSegmentsEndingAtOrAfter(index, 2 * node + 1, middle, end, limit, pos, includeEnd, results);
}

/** Whether `segment` takes part in `feature`. */
function supportsFeature(segment: SpanMapSegment, feature: SpanMapFeature): boolean {
  return (segment.features & feature) !== 0;
}

/** Confines `value` to the interval `[low, high]`. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}
