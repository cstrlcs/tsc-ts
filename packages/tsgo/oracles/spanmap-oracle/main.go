// Command spanmap-oracle prints what TypeScript-Go's span map answers for the
// JSON request in the file named by the first argument, as JSON on stdout.
//
// The request is a list of cases. Each has the span map as a content mapper
// sends it ("mappings", the tuple array), the virtual and the original text
// it is validated against, and queries: a method name followed by its
// arguments. The answer to a case has whether the mappings decoded, the
// segments, the map encoded again, the validation problem, and one result
// per query. Queries are answered only for a valid map.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/spanmap"
)

type request struct {
	Mappings json.RawMessage `json:"mappings"`
	Virtual  string          `json:"virtual"`
	Original string          `json:"original"`
	Queries  [][]any         `json:"queries"`
}

type answer struct {
	Decoded  bool    `json:"decoded"`
	Segments [][]int `json:"segments"`
	Marshal  string  `json:"marshal"`
	Problem  []any   `json:"problem"`
	Results  []any   `json:"results"`
}

func tuple(s spanmap.Segment) []int {
	return []int{int(s.VirtualStart), int(s.VirtualEnd), int(s.OriginalStart), int(s.OriginalEnd), int(s.Kind), int(s.Features)}
}

func positions(mapped []spanmap.MappedPosition) [][]int {
	result := make([][]int, len(mapped))
	for i, m := range mapped {
		result[i] = []int{int(m.Position), int(m.Fidelity)}
	}
	return result
}

func spans(mapped []spanmap.MappedSpan) [][]int {
	result := make([][]int, len(mapped))
	for i, m := range mapped {
		result[i] = []int{m.Span.Pos(), m.Span.End(), int(m.Fidelity)}
	}
	return result
}

func query(m *spanmap.SpanMap, q []any) any {
	arg := func(i int) int { return int(q[i].(float64)) }
	switch q[0].(string) {
	case "virtualToOriginalSpan":
		span, fidelity := m.VirtualToOriginalSpan(core.NewTextRange(arg(1), arg(2)))
		return []int{span.Pos(), span.End(), int(fidelity)}
	case "virtualToOriginalSpanForFeature":
		span, fidelity := m.VirtualToOriginalSpanForFeature(core.NewTextRange(arg(1), arg(2)), spanmap.Feature(arg(3)))
		return []int{span.Pos(), span.End(), int(fidelity)}
	case "virtualToOriginalPosition":
		position, fidelity := m.VirtualToOriginalPosition(core.TextPos(arg(1)))
		return []int{int(position), int(fidelity)}
	case "virtualToOriginalPositionExact":
		position, ok := m.VirtualToOriginalPositionExact(core.TextPos(arg(1)))
		if !ok {
			return nil
		}
		return int(position)
	case "virtualToOriginalPositionForFeature":
		position, fidelity := m.VirtualToOriginalPositionForFeature(core.TextPos(arg(1)), spanmap.Feature(arg(2)))
		return []int{int(position), int(fidelity)}
	case "aliasForVirtualSpan":
		segment, ok := m.AliasForVirtualSpan(core.NewTextRange(arg(1), arg(2)))
		if !ok {
			return nil
		}
		return tuple(segment)
	case "originalToVirtualPositions":
		return positions(m.OriginalToVirtualPositions(core.TextPos(arg(1)), spanmap.Feature(arg(2))))
	case "originalToVirtualSpans":
		return spans(m.OriginalToVirtualSpans(core.NewTextRange(arg(1), arg(2)), spanmap.Feature(arg(3))))
	case "originalToVirtualIntersectingSpans":
		return spans(m.OriginalToVirtualIntersectingSpans(core.NewTextRange(arg(1), arg(2)), spanmap.Feature(arg(3))))
	}
	panic(fmt.Sprintf("unknown query %v", q[0]))
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var requests []request
	if err := json.Unmarshal(data, &requests); err != nil {
		panic(err)
	}
	answers := make([]answer, len(requests))
	for i, r := range requests {
		a := &answers[i]
		a.Segments = [][]int{}
		a.Results = []any{}
		m, err := spanmap.Unmarshal(r.Mappings)
		if err != nil {
			continue
		}
		a.Decoded = true
		for _, s := range m.Segments() {
			a.Segments = append(a.Segments, tuple(s))
		}
		marshaled, err := m.Marshal()
		if err != nil {
			panic(err)
		}
		a.Marshal = string(marshaled)
		if problem := m.Validate(r.Virtual, r.Original); problem != nil {
			a.Problem = []any{int(problem.Kind), int(problem.VirtualPos), int(problem.OriginalPos), problem.Error()}
			continue
		}
		for _, q := range r.Queries {
			a.Results = append(a.Results, query(m, q))
		}
	}
	out, err := json.Marshal(answers)
	if err != nil {
		panic(err)
	}
	os.Stdout.Write(out)
}
