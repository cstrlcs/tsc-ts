// The span maps of tsc-ts's public API: TypeScript 7's `SpanMap`, over the compiler's.

import {
  SpanMap as CompilerSpanMap,
  type SpanMapFeature as CompilerSpanMapFeature,
  type SpanMapKind as CompilerSpanMapKind,
  SpanMapSegment as CompilerSpanMapSegment,
} from '../compiler/span-map.js';
import type { ReadonlyTextRange } from './ast.js';
import { SpanMapFeature, SpanMapFidelity, type SpanMapKind } from './enums.generated.js';

/** Maps one half-open virtual range to one half-open original range. Without `features`, every feature uses it. */
export interface SpanMapSegment {
  readonly virtualStart: number;
  readonly virtualEnd: number;
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly kind: SpanMapKind;
  readonly features?: SpanMapFeature | undefined;
}

/** One projection of a position and how faithful it is. */
export interface MappedPosition {
  readonly position: number;
  readonly fidelity: SpanMapFidelity;
}

/** One projection of a range and how faithful it is. */
export interface MappedRange {
  readonly range: ReadonlyTextRange;
  readonly fidelity: SpanMapFidelity;
}

const mappedPosition = (position: number, fidelity: number): MappedPosition => ({
  position,
  fidelity: fidelity as SpanMapFidelity,
});

const mappedRange = (pos: number, end: number, fidelity: number): MappedRange => ({
  range: { pos, end },
  fidelity: fidelity as SpanMapFidelity,
});

/**
 * How the text of a file a content mapper produced (the virtual text) corresponds to the text the mapper
 * transformed (the original text), as TypeScript 7's API gives it: segments that each map a range of the
 * virtual text to a range of the original, in UTF-16 offsets. A virtual position in no segment is
 * synthesized: it has no original counterpart, and maps to the place in the original where it was inserted,
 * with `SpanMapFidelity.None`.
 */
export class SpanMap {
  /** The segments ordered by virtual start, each with its features. */
  readonly segments: readonly (SpanMapSegment & { readonly features: SpanMapFeature })[];
  private readonly map: CompilerSpanMap;

  /** Copies `segments` and sorts the copy by virtual start; a segment without features gets every feature. */
  constructor(segments: readonly SpanMapSegment[]) {
    this.map = new CompilerSpanMap(
      segments.map(
        (segment) =>
          new CompilerSpanMapSegment(
            segment.virtualStart,
            segment.virtualEnd,
            segment.originalStart,
            segment.originalEnd,
            segment.kind as number as CompilerSpanMapKind,
            (segment.features ?? SpanMapFeature.All) as number as CompilerSpanMapFeature,
          ),
      ),
    );
    this.segments = this.map.segments as unknown as readonly (SpanMapSegment & { readonly features: SpanMapFeature })[];
  }

  /** Whether a mapping went through one verbatim segment, so its result can host a text edit. */
  static isExact(fidelity: SpanMapFidelity): boolean {
    return fidelity === SpanMapFidelity.Exact;
  }

  /** Whether a mapping went through one segment, verbatim or atom. */
  static isSingleSegment(fidelity: SpanMapFidelity): boolean {
    return fidelity === SpanMapFidelity.Exact || fidelity === SpanMapFidelity.Atom;
  }

  /** Whether the input had no counterpart in the other text. */
  static isNone(fidelity: SpanMapFidelity): boolean {
    return fidelity === SpanMapFidelity.None;
  }

  /**
   * Maps a virtual range to the original text. A range in a gap between segments maps to the insertion point
   * with `None` fidelity, and one that crosses segment boundaries maps its ends, with `Approximate` fidelity.
   */
  virtualToOriginalSpan(range: ReadonlyTextRange): MappedRange {
    const mapped = this.map.virtualToOriginalSpan(range.pos, range.end);
    return mappedRange(mapped.pos, mapped.end, mapped.fidelity);
  }

  /** `virtualToOriginalSpan`, with `None` fidelity unless segments that take part in `feature` cover the range. */
  virtualToOriginalSpanForFeature(range: ReadonlyTextRange, feature: SpanMapFeature): MappedRange {
    const mapped = this.map.virtualToOriginalSpanForFeature(
      range.pos,
      range.end,
      feature as number as CompilerSpanMapFeature,
    );
    return mappedRange(mapped.pos, mapped.end, mapped.fidelity);
  }

  /** Maps a virtual position to the original text, with `None` fidelity in a gap between segments. */
  virtualToOriginalPosition(position: number): MappedPosition {
    const mapped = this.map.virtualToOriginalPosition(position);
    return mappedPosition(mapped.position, mapped.fidelity);
  }

  /** `virtualToOriginalPosition`, with `None` fidelity unless the position's segment takes part in `feature`. */
  virtualToOriginalPositionForFeature(position: number, feature: SpanMapFeature): MappedPosition {
    const mapped = this.map.virtualToOriginalPositionForFeature(position, feature as number as CompilerSpanMapFeature);
    return mappedPosition(mapped.position, mapped.fidelity);
  }

  /**
   * Every virtual projection of an original position through a segment that takes part in `feature`, ordered by
   * virtual position. The end of a segment counts, so adjacent segments may both give one.
   */
  originalToVirtualPositions(position: number, feature: SpanMapFeature): readonly MappedPosition[] {
    return this.map
      .originalToVirtualPositions(position, feature as number as CompilerSpanMapFeature)
      .map((mapped) => mappedPosition(mapped.position, mapped.fidelity));
  }

  /**
   * Every virtual projection of an original range through segments that take part in `feature`: one exact or atom
   * range per segment that contains it, or, for a range that starts in one segment and ends in another, the
   * smallest range around each place it may be, with `Approximate` fidelity.
   */
  originalToVirtualSpans(range: ReadonlyTextRange, feature: SpanMapFeature): readonly MappedRange[] {
    return this.map
      .originalToVirtualSpans(range.pos, range.end, feature as number as CompilerSpanMapFeature)
      .map((mapped) => mappedRange(mapped.pos, mapped.end, mapped.fidelity));
  }
}
