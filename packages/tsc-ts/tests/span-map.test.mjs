// Span maps (src/compiler/span-map.ts): the cases of tsgo's own span map tests, then every method compared with
// tsgo's (packages/tsgo/dist/spanmap-oracle, built by `npm run build:oracle`) on generated maps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const oracle = join(repo, 'packages/tsgo/dist/spanmap-oracle');

const out = compileSources('tsc-ts-span-map-', ['compiler/span-map.ts', 'compiler/package-json.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { SpanMap, SpanMapSegment, MappedPosition, MappedSpan } = await load('compiler/span-map.js');
const { parseJson } = await load('compiler/package-json.js');

// The module's enums are const enums, which leave no object to import. The oracle comparison below fails if
// one of these numbers is not tsgo's.
const Verbatim = 0;
const Atom = 1;
const Alias = 2;
const Feature = {
  None: 0,
  Hover: 1 << 0,
  Completion: 1 << 2,
  Definition: 1 << 3,
  InlayHints: 1 << 12,
  SemanticTokens: 1 << 13,
  All: (1 << 20) - 1,
};
const Exact = 0;
const AtomFidelity = 1;
const Approximate = 2;
const None = 3;
const ErrorKind = { Overlap: 0, OutOfBounds: 1, VerbatimMismatch: 2, Kind: 3, Feature: 4 };

/** A map of segments given as `[virtualStart, virtualEnd, originalStart, originalEnd, kind, features]`. */
function spanMap(...segments) {
  return new SpanMap(segments.map((s) => new SpanMapSegment(s[0], s[1], s[2], s[3], s[4], s[5] ?? Feature.None)));
}
const position = (pos, fidelity) => new MappedPosition(pos, fidelity);
const span = (pos, end, fidelity) => new MappedSpan(pos, end, fidelity);

test('a span in a verbatim segment maps exactly', () => {
  // Virtual [0,10) is a verbatim copy of original [100,110).
  const m = spanMap([0, 10, 100, 110, Verbatim, Feature.All]);
  assert.deepEqual(m.virtualToOriginalSpan(3, 7), span(103, 107, Exact));
  assert.deepEqual(m.originalToVirtualSpans(103, 107, Feature.All), [span(3, 7, Exact)]);
});

test('a span in an atom maps to the whole atom', () => {
  // Virtual [0,3) is a synthesized gap; [3,14) is an atom of the original [60,71).
  const m = spanMap([3, 14, 60, 71, Atom, Feature.All]);
  assert.deepEqual(m.virtualToOriginalSpan(5, 9), span(60, 71, AtomFidelity));
  assert.deepEqual(m.originalToVirtualSpans(63, 67, Feature.All), [span(3, 14, AtomFidelity)]);
});

test('an alias has atom geometry and is found by its whole virtual span', () => {
  const m = spanMap([3, 6, 10, 11, Alias, Feature.All]);
  assert.deepEqual(m.virtualToOriginalSpan(3, 6), span(10, 11, AtomFidelity));
  assert.equal(m.aliasForVirtualSpan(3, 6).kind, Alias);
  assert.equal(m.aliasForVirtualSpan(4, 6), undefined);
  assert.equal(SpanMap.unmarshal(parseJson(m.marshal())).segments[0].kind, Alias);
});

test('a gap is synthesized and maps to its insertion point', () => {
  const m = spanMap([0, 10, 100, 110, Verbatim, Feature.All], [20, 30, 200, 210, Verbatim, Feature.All]);
  assert.deepEqual(m.virtualToOriginalSpan(12, 15), span(110, 110, None));
  // An original range no segment covers has no virtual counterpart.
  assert.deepEqual(m.originalToVirtualSpans(150, 160, Feature.All), []);
});

test('intersecting spans keep covered segments when the endpoints are uncovered', () => {
  const m = spanMap([10, 20, 100, 110, Verbatim, Feature.SemanticTokens | Feature.InlayHints]);
  for (const feature of [Feature.SemanticTokens, Feature.InlayHints])
    assert.deepEqual(m.originalToVirtualIntersectingSpans(90, 120, feature), [span(10, 20, Exact)]);
});

test('an empty map describes fully synthesized text', () => {
  const m = spanMap();
  assert.deepEqual(m.virtualToOriginalSpan(5, 10), span(0, 0, None));
  assert.deepEqual(m.virtualToOriginalPosition(5), position(0, None));
  assert.deepEqual(m.originalToVirtualPositions(5, Feature.All), []);
});

test('a span crossing segments maps its endpoints approximately', () => {
  const m = spanMap([0, 10, 100, 110, Verbatim], [10, 20, 200, 210, Verbatim]);
  assert.deepEqual(m.virtualToOriginalSpan(5, 15), span(105, 205, Approximate));
});

test('virtual positions map like zero-length spans', () => {
  // Virtual [0,10) is a verbatim copy of original [100,110); [20,30) is an atom of original [200,210).
  const m = spanMap([0, 10, 100, 110, Verbatim, Feature.All], [20, 30, 200, 210, Atom, Feature.All]);
  for (const [name, pos, want, fidelity] of [
    ['verbatim interpolates', 3, 103, Exact],
    ['atom maps to its start', 25, 200, AtomFidelity],
    ['gap maps to insertion point', 15, 110, None],
  ]) {
    assert.deepEqual(m.virtualToOriginalPosition(pos), position(want, fidelity), name);
    assert.deepEqual(m.virtualToOriginalSpan(pos, pos), span(want, want, fidelity), name);
  }
});

test('an exact position is one that is unambiguously in verbatim text', () => {
  const m = spanMap(
    [0, 10, 100, 110, Verbatim, Feature.All],
    [10, 20, 110, 120, Atom, Feature.All],
    [20, 30, 120, 130, Verbatim, Feature.All],
  );
  assert.equal(m.virtualToOriginalPositionExact(5), 105);
  assert.equal(m.virtualToOriginalPositionExact(10), undefined);
  assert.equal(m.virtualToOriginalPositionExact(15), undefined);
  assert.equal(m.virtualToOriginalPositionExact(20), undefined);
  assert.equal(m.virtualToOriginalPositionExact(25), 125);
  // The boundary between two verbatim segments whose originals are not adjacent is ambiguous too.
  const discontinuous = spanMap([0, 10, 0, 10, Verbatim], [10, 20, 100, 110, Verbatim]);
  assert.equal(discontinuous.virtualToOriginalPositionExact(10), undefined);
  assert.deepEqual(discontinuous.virtualToOriginalPosition(10), position(100, Exact));
});

test('zero-length spans at segment ends', () => {
  const m = spanMap([0, 10, 100, 110, Verbatim, Feature.Hover], [20, 30, 200, 210, Verbatim, Feature.Hover]);
  assert.deepEqual(m.virtualToOriginalPosition(30), position(210, Exact));
  assert.deepEqual(m.virtualToOriginalSpan(30, 30), span(210, 210, Exact));
  for (const originalEnd of [110, 210]) {
    const positions = m.originalToVirtualPositions(originalEnd, Feature.Hover);
    assert.equal(positions.length, 1);
    assert.deepEqual(m.originalToVirtualSpans(originalEnd, originalEnd, Feature.Hover), [
      span(positions[0].position, positions[0].position, positions[0].fidelity),
    ]);
  }
});

test('original positions map through verbatim segments and atoms, and not through gaps', () => {
  // Original [100,110) is a verbatim copy of virtual [0,10); [200,210) is an atom of virtual [20,30).
  const m = spanMap([0, 10, 100, 110, Verbatim, Feature.All], [20, 30, 200, 210, Atom, Feature.All]);
  assert.deepEqual(m.originalToVirtualPositions(103, Feature.All), [position(3, Exact)]);
  assert.deepEqual(m.originalToVirtualSpans(103, 103, Feature.All), [span(3, 3, Exact)]);
  assert.deepEqual(m.originalToVirtualPositions(205, Feature.All), [position(20, AtomFidelity)]);
  assert.deepEqual(m.originalToVirtualSpans(205, 205, Feature.All), [span(20, 20, AtomFidelity)]);
  assert.deepEqual(m.originalToVirtualPositions(150, Feature.All), []);
  assert.deepEqual(m.originalToVirtualSpans(150, 150, Feature.All), []);
});

test('an original position at a shared endpoint projects from both sides', () => {
  const m = spanMap(
    [2, 5, 10, 13, Verbatim, Feature.Completion],
    [8, 11, 13, 16, Verbatim, Feature.Completion],
    [20, 23, 30, 35, Atom, Feature.Completion],
  );
  assert.deepEqual(m.originalToVirtualPositions(13, Feature.Completion), [position(5, Exact), position(8, Exact)]);
  assert.deepEqual(m.originalToVirtualPositions(35, Feature.Completion), [position(23, AtomFidelity)]);

  const filtered = spanMap([20, 23, 10, 13, Verbatim, Feature.Hover], [2, 5, 13, 16, Verbatim, Feature.Completion]);
  assert.deepEqual(filtered.originalToVirtualPositions(13, Feature.All), [position(2, Exact), position(23, Exact)]);
  assert.deepEqual(filtered.originalToVirtualPositions(13, Feature.Completion), [position(2, Exact)]);
});

test('duplicates of an original range are chosen by feature', () => {
  const m = spanMap(
    [0, 3, 10, 13, Verbatim, Feature.Definition],
    [10, 13, 10, 13, Verbatim, Feature.Hover],
    [20, 25, 10, 13, Atom, Feature.Definition],
  );
  assert.deepEqual(m.originalToVirtualPositions(11, Feature.Hover), [position(11, Exact)]);
  assert.deepEqual(m.originalToVirtualPositions(11, Feature.Definition), [
    position(1, Exact),
    position(20, AtomFidelity),
  ]);
  assert.deepEqual(m.originalToVirtualSpans(10, 13, Feature.Definition), [
    span(0, 3, Exact),
    span(20, 25, AtomFidelity),
  ]);
});

test('every segment that covers an original span maps it', () => {
  const m = spanMap(
    [0, 6, 0, 6, Verbatim, Feature.Hover],
    [10, 12, 2, 4, Verbatim, Feature.Hover],
    [20, 24, 3, 7, Verbatim, Feature.Hover],
  );
  assert.deepEqual(m.originalToVirtualPositions(3, Feature.Hover), [
    position(3, Exact),
    position(11, Exact),
    position(20, Exact),
  ]);
  assert.deepEqual(m.originalToVirtualSpans(3, 4, Feature.Hover), [
    span(3, 4, Exact),
    span(11, 12, Exact),
    span(20, 21, Exact),
  ]);
});

test('the original index finds an early covering segment', () => {
  // A binary search lands near [90,95), which does not contain 97. The index still finds the earlier [0,100).
  const m = spanMap(
    [0, 100, 0, 100, Verbatim, Feature.Hover],
    [100, 105, 80, 85, Verbatim, Feature.Hover],
    [105, 110, 90, 95, Verbatim, Feature.Hover],
    [110, 113, 100, 103, Verbatim, Feature.Hover],
  );
  assert.deepEqual(m.originalToVirtualPositions(97, Feature.Hover), [position(97, Exact)]);
  assert.deepEqual(m.originalToVirtualSpans(97, 98, Feature.Hover), [span(97, 98, Exact)]);
  // A position takes both sides of a shared endpoint; a non-empty span takes only the segment that starts there.
  assert.deepEqual(m.originalToVirtualPositions(100, Feature.Hover), [position(100, Exact), position(110, Exact)]);
  assert.deepEqual(m.originalToVirtualSpans(100, 101, Feature.Hover), [span(110, 111, Exact)]);
});

test('a containing segment that does not take part falls back to the segments that do', () => {
  const m = spanMap(
    [0, 6, 0, 6, Verbatim, Feature.Definition],
    [10, 13, 0, 3, Verbatim, Feature.Hover],
    [13, 16, 3, 6, Verbatim, Feature.Hover],
  );
  assert.deepEqual(m.originalToVirtualSpans(1, 5, Feature.Hover), [span(11, 15, Approximate)]);
});

test('a span across duplicated groups maps to the smallest range around each copy', () => {
  const m = spanMap(
    [0, 2, 0, 2, Verbatim, Feature.Hover],
    [2, 4, 2, 4, Verbatim, Feature.Hover],
    [10, 12, 0, 2, Verbatim, Feature.Hover],
    [12, 14, 2, 4, Verbatim, Feature.Hover],
  );
  assert.deepEqual(m.originalToVirtualSpans(1, 3, Feature.Hover), [span(1, 3, Approximate), span(11, 13, Approximate)]);
});

test('a segment with no features maps no original position, and encodes its features', () => {
  const m = spanMap([0, 3, 10, 13, Verbatim, Feature.None]);
  assert.deepEqual(m.originalToVirtualPositions(11, Feature.Hover), []);
  assert.deepEqual(m.originalToVirtualPositions(11, Feature.Definition), []);
  assert.deepEqual(m.originalToVirtualSpans(10, 13, Feature.Hover), []);
  assert.equal(m.marshal(), '[[0,3,10,3,0,0]]');
  assert.equal(SpanMap.unmarshal(parseJson(m.marshal())).segments[0].features, Feature.None);

  const legacy = SpanMap.unmarshal(parseJson('[[0,3,10,3,0]]'));
  assert.equal(legacy.segments[0].features, Feature.All);
  assert.equal(legacy.originalToVirtualPositions(11, Feature.Hover).length, 1);
  assert.equal(legacy.marshal(), '[[0,3,10,3,0]]');
});

test('features limit the language service and not diagnostics', () => {
  const m = spanMap([0, 3, 10, 13, Verbatim, Feature.Hover], [3, 6, 20, 23, Verbatim, Feature.Completion]);
  assert.equal(m.originalToVirtualPositions(11, Feature.Hover).length, 1);
  assert.equal(m.originalToVirtualPositions(11, Feature.Completion).length, 0);
  assert.deepEqual(m.virtualToOriginalSpanForFeature(0, 3, Feature.Hover), span(10, 13, Exact));
  assert.deepEqual(m.virtualToOriginalSpanForFeature(0, 3, Feature.Completion), span(10, 13, None));
  assert.deepEqual(m.virtualToOriginalPositionForFeature(1, Feature.Hover), position(11, Exact));
  assert.deepEqual(m.virtualToOriginalPositionForFeature(1, Feature.Completion), position(11, None));
  assert.deepEqual(m.virtualToOriginalSpan(0, 3), span(10, 13, Exact));
});

test('spans round-trip when original and virtual order differ', () => {
  const m = spanMap([0, 10, 200, 210, Verbatim, Feature.All], [10, 20, 100, 110, Verbatim, Feature.All]);
  for (const [pos, end] of [
    [2, 8],
    [12, 18],
  ]) {
    const original = m.virtualToOriginalSpan(pos, end);
    assert.equal(original.fidelity, Exact);
    assert.deepEqual(m.originalToVirtualSpans(original.pos, original.end, Feature.All), [span(pos, end, Exact)]);
  }
});

test('a map survives encoding and decoding', () => {
  const original = spanMap([3, 14, 60, 71, Atom], [14, 24, 71, 81, Verbatim]);
  const decoded = SpanMap.unmarshal(parseJson(original.marshal()));
  assert.deepEqual(decoded.segments, original.segments);
  for (const [pos, end] of [
    [1, 2],
    [4, 10],
    [16, 20],
  ])
    assert.deepEqual(decoded.virtualToOriginalSpan(pos, end), original.virtualToOriginalSpan(pos, end));
});

test('decoding rejects what is not an array of five or six 32-bit integers', () => {
  assert.deepEqual(SpanMap.unmarshal(parseJson('null')).segments, []);
  assert.deepEqual(SpanMap.unmarshal(parseJson('[]')).segments, []);
  for (const text of [
    '{}',
    '"[]"',
    '[null]',
    '[[0,3,10,3]]',
    '[[0,3,10,3,0,0,0]]',
    '[[0,3,10,3,"0"]]',
    '[[0,3,10,3.5,0]]',
    '[[0,3,10,2147483648,0]]',
    '[[0,3,10,3,0],5]',
  ])
    assert.equal(SpanMap.unmarshal(parseJson(text)), undefined, text);
});

test('validation names the first problem of a map', () => {
  const transformed = 'const greeting = 1;\n';
  const original = '<x>const greeting = 1;\n</x>';
  const length = transformed.length;
  for (const [name, segments, kind] of [
    ['valid verbatim', [[0, length, 3, 3 + length, Verbatim]], undefined],
    ['empty is valid', [], undefined],
    ['gap is allowed', [[3, length, 0, 0, Atom]], undefined],
    [
      'overlap',
      [
        [0, 10, 0, 0, Atom],
        [5, length, 0, 0, Atom],
      ],
      ErrorKind.Overlap,
    ],
    ['past the virtual text', [[0, length + 1, 0, 0, Atom]], ErrorKind.Overlap],
    ['original out of bounds', [[0, length, 0, original.length + 10, Atom]], ErrorKind.OutOfBounds],
    ['verbatim text mismatch', [[0, length, 0, length, Verbatim]], ErrorKind.VerbatimMismatch],
    ['verbatim length mismatch', [[0, length, 3, 2 + length, Verbatim]], ErrorKind.VerbatimMismatch],
    ['unknown kind', [[0, 1, 0, 1, 3]], ErrorKind.Kind],
  ])
    assert.equal(spanMap(...segments).validate(transformed, original)?.kind, kind, name);
});

test('validation allows overlapping originals and rejects unknown features', () => {
  for (const [name, segments, kind] of [
    [
      'identical duplicate group',
      [
        [0, 3, 0, 3, Verbatim, Feature.Definition],
        [3, 6, 0, 3, Verbatim, Feature.Hover],
      ],
      undefined,
    ],
    [
      'partial original overlap',
      [
        [0, 3, 0, 3, Atom],
        [3, 6, 2, 5, Atom],
      ],
      undefined,
    ],
    [
      'nested original overlap',
      [
        [0, 5, 0, 5, Atom],
        [5, 6, 1, 4, Atom],
      ],
      undefined,
    ],
    [
      'duplicate without explicit features',
      [
        [0, 3, 0, 3, Atom],
        [3, 6, 0, 3, Atom, Feature.Definition],
      ],
      undefined,
    ],
    [
      'duplicate with shared feature members',
      [
        [0, 3, 0, 3, Atom, Feature.Hover],
        [3, 6, 0, 3, Atom, Feature.Hover | Feature.Definition],
      ],
      undefined,
    ],
    ['features on sole cover', [[0, 3, 0, 3, Atom, Feature.Definition]], undefined],
    ['unknown feature flag', [[0, 3, 0, 3, Atom, 1 << 22]], ErrorKind.Feature],
  ])
    assert.equal(spanMap(...segments).validate('abcabc', 'abcdef')?.kind, kind, name);
});

test('a validation problem reads as in tsgo', () => {
  const problem = spanMap([0, 3, 1, 4, Verbatim]).validate('abc', 'abcd');
  assert.deepEqual([problem.kind, problem.virtualPos, problem.originalPos], [ErrorKind.VerbatimMismatch, 0, 1]);
  assert.equal(
    problem.error(),
    'content mapper verbatim mapping does not match the original content at virtual offset 0, original offset 1',
  );
});

test('fidelity predicates', () => {
  assert.equal(SpanMap.isExact(Exact), true);
  assert.equal(SpanMap.isExact(AtomFidelity), false);
  assert.equal(SpanMap.isSingleSegment(Exact), true);
  assert.equal(SpanMap.isSingleSegment(AtomFidelity), true);
  assert.equal(SpanMap.isSingleSegment(Approximate), false);
  assert.equal(SpanMap.isNone(None), true);
  assert.equal(SpanMap.isNone(Approximate), false);
});

// ---- Generated maps, compared with tsgo

/** A deterministic generator of integers below `bound`. */
function random(seed) {
  let state = seed >>> 0;
  return (bound) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 4294967296) * bound);
  };
}

const features = [Feature.All, Feature.All, Feature.None, Feature.Hover, Feature.Definition, 5, 1 << 19, (1 << 20) - 2];

function text(next, length) {
  let result = '';
  for (let i = 0; i < length; i++) result += 'abcdefgh'[next(8)];
  return result;
}

/**
 * A case: a map of up to `maxSegments` segments in virtual order, with gaps and segments that are empty, share
 * an original range or overlap one, and the texts it is valid for. `spoil` then breaks it in one way, or
 * leaves it valid when it is 0.
 */
function generate(next, maxSegments, spoil) {
  const original = text(next, 20 + next(60));
  const tuples = [];
  let virtual = '';
  const ranges = [];
  const count = next(maxSegments + 1);
  for (let i = 0; i < count; i++) {
    virtual += text(next, [0, 0, 1, 3][next(4)]);
    const kind = next(3);
    let originalStart = next(original.length + 1);
    let originalLength = next(Math.min(8, original.length - originalStart + 1));
    // Reuse an earlier original range now and then, so the map has duplicates.
    if (ranges.length > 0 && next(4) === 0) [originalStart, originalLength] = ranges[next(ranges.length)];
    ranges.push([originalStart, originalLength]);
    const piece =
      kind === Verbatim ? original.slice(originalStart, originalStart + originalLength) : text(next, next(6));
    const tuple = [virtual.length, piece.length, originalStart, originalLength, kind];
    const feature = features[next(features.length)];
    // Features that are all of them are left out half of the time, as a mapper may.
    if (feature !== Feature.All || next(2) === 0) tuple.push(feature);
    tuples.push(tuple);
    virtual += piece;
  }
  virtual += text(next, next(3));
  let mappings = tuples;
  const pick = () => tuples[next(tuples.length)];
  if (tuples.length > 0)
    switch (spoil) {
      case 1:
        tuples.reverse();
        break;
      case 2:
        pick()[0] -= 1 + next(3);
        break;
      case 3:
        pick()[1] += virtual.length;
        break;
      case 4:
        pick()[2] += original.length;
        break;
      case 5:
        pick()[3] = -1 - next(3);
        break;
      case 6:
        pick()[4] = [3, -1, 7][next(3)];
        break;
      case 7:
        pick()[5] = [1 << 20, -1, (1 << 20) + 1][next(3)];
        break;
      case 8:
        virtual = virtual.replaceAll('a', 'b');
        break;
      case 9:
        pick().pop();
        pick().pop();
        break;
      case 10:
        pick().push(0, 0);
        break;
      case 11:
        pick()[next(5)] = [1.5, '1', null, 2 ** 31, -(2 ** 31) - 1, true][next(6)];
        break;
      case 12:
        mappings = [tuples, null, {}, 'x', [null], [[]]][next(6)];
        break;
      case 13:
        pick()[1] = 2 ** 31 - 1;
        break;
    }
  return { mappings, virtual, original };
}

/** Queries of every method over the positions of a case, and over spans around them. */
function queriesFor(next, { virtual, original }) {
  const queries = [];
  const feature = () => [Feature.All, Feature.Hover, Feature.Definition, Feature.None, 5][next(5)];
  for (let pos = 0; pos <= virtual.length + 1; pos++) {
    const end = pos + next(6) - 1;
    queries.push(
      ['virtualToOriginalPosition', pos],
      ['virtualToOriginalPositionExact', pos],
      ['virtualToOriginalPositionForFeature', pos, feature()],
      ['virtualToOriginalSpan', pos, end],
      ['virtualToOriginalSpan', pos, pos + next(virtual.length + 2)],
      ['virtualToOriginalSpanForFeature', pos, end, feature()],
      ['virtualToOriginalSpanForFeature', pos, pos + next(virtual.length + 2), feature()],
      ['aliasForVirtualSpan', pos, end],
    );
  }
  for (let pos = 0; pos <= original.length + 1; pos++) {
    const end = pos + next(6) - 1;
    queries.push(
      ['originalToVirtualPositions', pos, feature()],
      ['originalToVirtualSpans', pos, end, feature()],
      ['originalToVirtualSpans', pos, pos + next(original.length + 2), feature()],
      ['originalToVirtualIntersectingSpans', pos, end, feature()],
      ['originalToVirtualIntersectingSpans', pos, pos + next(original.length + 2), feature()],
    );
  }
  return queries;
}

/** A map of many segments, whose original ranges are in another order than the virtual ones. */
function largeCase(next) {
  const count = 300;
  const order = [];
  for (let i = 0; i < count; i++) order.push(i);
  for (let i = count - 1; i > 0; i--) {
    const j = next(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const original = text(next, count * 4);
  const tuples = [];
  let virtual = '';
  for (const slot of order) {
    virtual += text(next, next(2));
    const kind = next(3);
    const piece = kind === Verbatim ? original.slice(slot * 4, slot * 4 + 3) : text(next, 1 + next(3));
    tuples.push([virtual.length, piece.length, slot * 4, 3, kind, features[next(features.length)]]);
    virtual += piece;
  }
  return { mappings: tuples, virtual, original };
}

const tuple = (s) => [s.virtualStart, s.virtualEnd, s.originalStart, s.originalEnd, s.kind, s.features];
const positions = (mapped) => mapped.map((m) => [m.position, m.fidelity]);
const spans = (mapped) => mapped.map((m) => [m.pos, m.end, m.fidelity]);

/** What tsc-ts answers for a case, in the oracle's shape. */
function answer({ mappings, virtual, original, queries }) {
  const result = { decoded: false, segments: [], marshal: '', problem: null, results: [] };
  const m = SpanMap.unmarshal(parseJson(JSON.stringify(mappings)));
  if (m === undefined) return result;
  result.decoded = true;
  result.segments = m.segments.map(tuple);
  result.marshal = m.marshal();
  const problem = m.validate(virtual, original);
  if (problem !== undefined) {
    result.problem = [problem.kind, problem.virtualPos, problem.originalPos, problem.error()];
    return result;
  }
  for (const [method, ...args] of queries) {
    const value = m[method](...args);
    if (method === 'virtualToOriginalPositionExact') result.results.push(value ?? null);
    else if (method === 'aliasForVirtualSpan') result.results.push(value === undefined ? null : tuple(value));
    else if (Array.isArray(value))
      result.results.push(method === 'originalToVirtualPositions' ? positions(value) : spans(value));
    else result.results.push(value instanceof MappedSpan ? spans([value])[0] : positions([value])[0]);
  }
  return result;
}

test(
  'generated maps decode, validate and map as in tsgo',
  { skip: !existsSync(oracle) && 'spanmap-oracle is not built' },
  () => {
    const next = random(20261113);
    const cases = [];
    // Maps stay under twelve segments, below which Go's sort keeps equal elements in order, as JavaScript's does.
    for (let i = 0; i < 600; i++) cases.push(generate(next, 11, i % 3 === 0 ? 0 : 1 + next(13)));
    for (let i = 0; i < 3; i++) cases.push(largeCase(next));
    for (const item of cases) item.queries = queriesFor(next, item);
    const file = join(out, 'span-map-cases.json');
    writeFileSync(file, JSON.stringify(cases));
    const expected = JSON.parse(execFileSync(oracle, [file], { encoding: 'utf8', maxBuffer: 1 << 30 }));
    assert.equal(expected.length, cases.length);
    const tally = { undecoded: 0, invalid: 0, results: 0 };
    for (let i = 0; i < cases.length; i++) {
      const actual = answer(cases[i]);
      const name = `case ${i}: ${JSON.stringify(cases[i].mappings)}`;
      assert.equal(actual.decoded, expected[i].decoded, name);
      assert.deepEqual(actual.segments, expected[i].segments, name);
      assert.equal(actual.marshal, expected[i].marshal, name);
      assert.deepEqual(actual.problem, expected[i].problem, name);
      assert.equal(actual.results.length, expected[i].results.length, name);
      for (let q = 0; q < actual.results.length; q++)
        assert.deepEqual(actual.results[q], expected[i].results[q], `${name}: ${JSON.stringify(cases[i].queries[q])}`);
      if (!actual.decoded) tally.undecoded++;
      else if (actual.problem !== null) tally.invalid++;
      tally.results += actual.results.length;
    }
    // The generator reaches every outcome.
    assert.ok(tally.undecoded > 20 && tally.invalid > 100 && tally.results > 100_000, JSON.stringify(tally));
  },
);

test(
  'an integer of a map is written without a fraction or an exponent, as tsgo demands',
  { skip: !existsSync(oracle) && 'spanmap-oracle is not built' },
  () => {
    // The maps as text: JSON.stringify writes every integer the plain way.
    const mappings = [
      '[[0,3,0,3,0]]',
      '[[0,3.0,0,3,0]]',
      '[[0,3,0,3e0,0]]',
      '[[0,3,0,3,0E0]]',
      '[[0,3,0,3,0,1.0]]',
      '[[-0,3,0,3,0]]',
      '[[0,3,0,3,0,1048575]]',
    ];
    const file = join(out, 'span-map-spellings.json');
    writeFileSync(
      file,
      `[${mappings.map((text) => `{"mappings":${text},"virtual":"abc","original":"abc","queries":[]}`).join(',')}]`,
    );
    const expected = JSON.parse(execFileSync(oracle, [file], { encoding: 'utf8' }));
    const decoded = mappings.map((text) => SpanMap.unmarshal(parseJson(text)) !== undefined);
    assert.deepEqual(
      decoded,
      expected.map((answer) => answer.decoded),
    );
    assert.deepEqual(decoded, [true, false, false, false, false, true, true]);
  },
);
