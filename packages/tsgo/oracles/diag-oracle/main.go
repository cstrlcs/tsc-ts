// Command diag-oracle prints TypeScript-Go's diagnostic messages, their
// translations, locale matching, message formatting and diagnostic output
// for the JSON request in the file named by the first argument, as JSON on
// stdout.
//
// A file of a render may be one a content mapper produced ("mapped": the
// mapper's name, the original text, the span map as the tuples a mapper
// sends, with UTF-16 offsets, or none for the empty file of a failed
// transform, and the index of the canonical file of a supplemental one),
// and a diagnostic may be a mapper's own ("source", "code" and "text" in
// place of a key, at a range of the original text). "problems" are span
// maps to validate against their texts; the answer to each is the
// diagnostic the compiler reports for an invalid one.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	_ "unsafe"

	tsast "github.com/microsoft/TypeScript/tsc/internal/ast"
	_ "github.com/microsoft/TypeScript/tsc/internal/compiler"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/diagnostics"
	"github.com/microsoft/TypeScript/tsc/internal/diagnosticwriter"
	"github.com/microsoft/TypeScript/tsc/internal/locale"
	tsparser "github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/spanmap"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
)

//go:linkname keyToMessage github.com/microsoft/TypeScript/tsc/internal/diagnostics.keyToMessage
func keyToMessage(key diagnostics.Key) *diagnostics.Message

//go:linkname contentMapperMappingDiagnostic github.com/microsoft/TypeScript/tsc/internal/compiler.contentMapperMappingDiagnostic
func contentMapperMappingDiagnostic(file *tsast.SourceFile, label string, problem *spanmap.MappingError) *tsast.Diagnostic

type mapped struct {
	Mapper    string          `json:"mapper"`
	Original  string          `json:"original"`
	Mappings  json.RawMessage `json:"mappings"`
	Canonical *int            `json:"canonical"`
}

type file struct {
	Name   string  `json:"name"`
	Text   string  `json:"text"`
	Mapped *mapped `json:"mapped"`
}

type diagnostic struct {
	File    int          `json:"file"`
	Pos     int          `json:"pos"`
	End     int          `json:"end"`
	Key     string       `json:"key"`
	Args    []string     `json:"args"`
	Chain   []diagnostic `json:"chain"`
	Related []diagnostic `json:"related"`
	Source  string       `json:"source"`
	Code    int32        `json:"code"`
	Text    string       `json:"text"`
}

type problem struct {
	Label    string          `json:"label"`
	Virtual  string          `json:"virtual"`
	Original string          `json:"original"`
	Mappings json.RawMessage `json:"mappings"`
}

type render struct {
	Locale                    string       `json:"locale"`
	CurrentDirectory          string       `json:"currentDirectory"`
	UseCaseSensitiveFileNames bool         `json:"useCaseSensitiveFileNames"`
	NewLine                   string       `json:"newLine"`
	Files                     []file       `json:"files"`
	Diagnostics               []diagnostic `json:"diagnostics"`
}

type format struct {
	Locale string   `json:"locale"`
	Key    string   `json:"key"`
	Args   []string `json:"args"`
}

type request struct {
	Locales  []string  `json:"locales"`
	Matches  []string  `json:"matches"`
	Formats  []format  `json:"formats"`
	Renders  []render  `json:"renders"`
	Problems []problem `json:"problems"`
}

type message struct {
	Name     string `json:"name"`
	Code     int32  `json:"code"`
	Category string `json:"category"`
	Key      string `json:"key"`
	Text     string `json:"text"`
	Flags    int    `json:"flags"`
}

type rendered struct {
	Plain     string   `json:"plain"`
	Pretty    string   `json:"pretty"`
	Summary   string   `json:"summary"`
	Flattened []string `json:"flattened"`
	Status    []string `json:"status"`
	Order     []int    `json:"order"`
	Equal     []bool   `json:"equal"`
}

type response struct {
	Messages  []message           `json:"messages"`
	Localized map[string][]string `json:"localized"`
	Matches   []string            `json:"matches"`
	Formats   []string            `json:"formats"`
	Renders   []rendered          `json:"renders"`
	Problems  []string            `json:"problems"`
}

type declared struct {
	name    string
	message *diagnostics.Message
}

// The messages in declaration order, read from the generated Go source and
// resolved to the compiled message values.
func readMessages() []declared {
	_, self, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(self), "../../internal/diagnostics/diagnostics_generated.go")
	parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		panic(err)
	}
	var result []declared
	for _, decl := range parsed.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.VAR {
			continue
		}
		for _, spec := range gen.Specs {
			name := spec.(*ast.ValueSpec).Names[0].Name
			// Messages are `&Message{...}`; other variables, such as the list of all messages, are skipped.
			unary, ok := spec.(*ast.ValueSpec).Values[0].(*ast.UnaryExpr)
			if !ok {
				continue
			}
			value := unary.X.(*ast.CompositeLit)
			for _, element := range value.Elts {
				field := element.(*ast.KeyValueExpr)
				if field.Key.(*ast.Ident).Name != "key" {
					continue
				}
				key, _ := strconv.Unquote(field.Value.(*ast.BasicLit).Value)
				m := keyToMessage(diagnostics.Key(key))
				if m == nil {
					panic("unknown key " + key)
				}
				result = append(result, declared{name, m})
			}
		}
	}
	return result
}

func parseLocale(tag string) locale.Locale {
	l, _ := locale.Parse(tag)
	return l
}

// Converts a UTF-16 offset in text to a UTF-8 byte offset.
func byteOffset(text string, pos int) int {
	if pos < 0 {
		return pos
	}
	units := 0
	for i, r := range text {
		if units >= pos {
			return i
		}
		units += len(utf16.Encode([]rune{r}))
	}
	return len(text)
}

// The span map of the tuples a content mapper sends, whose offsets are
// UTF-16 offsets into the virtual and the original text.
func spanMap(mappings json.RawMessage, virtual string, original string) *spanmap.SpanMap {
	decoded, err := spanmap.Unmarshal(mappings)
	if err != nil {
		panic(err)
	}
	segments := decoded.Segments()
	for i := range segments {
		s := &segments[i]
		s.VirtualStart = core.TextPos(byteOffset(virtual, int(s.VirtualStart)))
		s.VirtualEnd = core.TextPos(byteOffset(virtual, int(s.VirtualEnd)))
		s.OriginalStart = core.TextPos(byteOffset(original, int(s.OriginalStart)))
		s.OriginalEnd = core.TextPos(byteOffset(original, int(s.OriginalEnd)))
	}
	return spanmap.New(segments)
}

func build(d diagnostic, files []*tsast.SourceFile) *tsast.Diagnostic {
	var f *tsast.SourceFile
	if d.File >= 0 {
		f = files[d.File]
	}
	var chain, related []*tsast.Diagnostic
	for _, c := range d.Chain {
		chain = append(chain, build(c, files))
	}
	for _, r := range d.Related {
		related = append(related, build(r, files))
	}
	pos, end := d.Pos, d.End
	if d.Source != "" {
		// A content mapper's diagnostic, at a range of the original text.
		if f != nil {
			pos, end = byteOffset(f.OriginalText(), pos), byteOffset(f.OriginalText(), end)
		}
		return tsast.NewExternalDiagnostic(f, core.NewTextRange(pos, end), d.Source, diagnostics.CategoryError, d.Code, d.Text).SetMessageChain(chain).SetRelatedInfo(related)
	}
	m := keyToMessage(diagnostics.Key(d.Key))
	if m == nil {
		panic("unknown key " + d.Key)
	}
	if f != nil {
		pos, end = byteOffset(f.Text(), pos), byteOffset(f.Text(), end)
	}
	args := d.Args
	if args == nil {
		args = []string{}
	}
	return tsast.NewDiagnosticFromSerialized(f, core.NewTextRange(pos, end), m.Code(), m.Category(), m.Key(), args, chain, related, m.ReportsUnnecessary(), m.ReportsDeprecated(), false)
}

func safely(f func() string) (result string) {
	defer func() {
		if r := recover(); r != nil {
			result = fmt.Sprint("panic: ", r)
		}
	}()
	return f()
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var req request
	if err := json.Unmarshal(data, &req); err != nil {
		panic(err)
	}
	messages := readMessages()
	res := response{Localized: map[string][]string{}, Matches: []string{}, Formats: []string{}, Renders: []rendered{}, Problems: []string{}}
	for _, d := range messages {
		m := d.message
		flags := int(m.Category())
		if m.ReportsUnnecessary() {
			flags |= 4
		}
		if m.ElidedInCompatibilityPyramid() {
			flags |= 8
		}
		if m.ReportsDeprecated() {
			flags |= 16
		}
		res.Messages = append(res.Messages, message{Name: d.name, Code: m.Code(), Category: m.Category().Name(), Key: string(m.Key()), Text: m.String(), Flags: flags})
	}
	for _, tag := range req.Locales {
		l := parseLocale(tag)
		texts := make([]string, len(messages))
		for i, d := range messages {
			texts[i] = diagnostics.Localize(l, d.message, "")
		}
		res.Localized[tag] = texts
	}
	for _, tag := range req.Matches {
		res.Matches = append(res.Matches, diagnostics.Identifier_expected.Localize(parseLocale(tag)))
	}
	for _, f := range req.Formats {
		res.Formats = append(res.Formats, safely(func() string {
			return diagnostics.Localize(parseLocale(f.Locale), nil, diagnostics.Key(f.Key), f.Args...)
		}))
	}
	for _, r := range req.Renders {
		var files []*tsast.SourceFile
		for _, f := range r.Files {
			parsed := tsparser.ParseSourceFile(tsast.SourceFileParseOptions{FileName: tspath.RootedFilePath(f.Name), PathKey: tspath.PathKey(f.Name)}, f.Text, core.ScriptKindTS)
			if m := f.Mapped; m != nil {
				info := tsast.ContentMapperSourceFileInfo{ContentMapper: m.Mapper, OriginalText: m.Original}
				if m.Mappings != nil {
					info.SpanMap = spanMap(m.Mappings, f.Text, m.Original)
				}
				if m.Canonical != nil {
					info.CanonicalSourceFile = files[*m.Canonical]
				}
				parsed.SetContentMapperInfo(info)
			}
			files = append(files, parsed)
		}
		var diags []*tsast.Diagnostic
		for _, d := range r.Diagnostics {
			diags = append(diags, build(d, files))
		}
		opts := &diagnosticwriter.FormattingOptions{
			Locale:              parseLocale(r.Locale),
			CaseSensitivity:     caseSensitivity(r.UseCaseSensitiveFileNames),
			CurrentDirectory:    tspath.RootedDirectoryPath(r.CurrentDirectory),
			NewLine:             r.NewLine,
		}
		wrapped := diagnosticwriter.FromASTDiagnostics(diags)
		var out rendered
		out.Plain = safely(func() string {
			var b strings.Builder
			diagnosticwriter.WriteFormatDiagnostics(&b, wrapped, opts)
			return b.String()
		})
		out.Pretty = safely(func() string {
			var b strings.Builder
			diagnosticwriter.FormatDiagnosticsWithColorAndContext(&b, wrapped, opts)
			return b.String()
		})
		out.Summary = safely(func() string {
			var b strings.Builder
			diagnosticwriter.WriteErrorSummaryText(&b, wrapped, opts)
			return b.String()
		})
		for _, d := range wrapped {
			out.Flattened = append(out.Flattened, safely(func() string {
				return diagnosticwriter.FlattenDiagnosticMessage(d, r.NewLine, opts.Locale)
			}))
			out.Status = append(out.Status, safely(func() string {
				var plain strings.Builder
				diagnosticwriter.FormatDiagnosticsStatusAndTime(&plain, "12:34:56 PM", d, opts)
				return plain.String()
			}), safely(func() string {
				var color strings.Builder
				diagnosticwriter.FormatDiagnosticsStatusWithColorAndTime(&color, "12:34:56 PM", d, opts)
				return color.String()
			}))
		}
		// The diagnostics in the order they are reported in, and whether each is the same as the one before.
		out.Order, out.Equal = make([]int, len(diags)), []bool{}
		for i := range out.Order {
			out.Order[i] = i
		}
		slices.SortStableFunc(out.Order, func(a, b int) int { return tsast.CompareDiagnostics(diags[a], diags[b]) })
		for i := 1; i < len(out.Order); i++ {
			out.Equal = append(out.Equal, tsast.EqualDiagnostics(diags[out.Order[i-1]], diags[out.Order[i]]))
		}
		res.Renders = append(res.Renders, out)
	}
	for _, p := range req.Problems {
		text := ""
		if invalid := spanMap(p.Mappings, p.Virtual, p.Original).Validate(p.Virtual, p.Original); invalid != nil {
			d := contentMapperMappingDiagnostic(nil, p.Label, invalid)
			text = fmt.Sprintf("TS%d: %s", d.Code(), d.Localize(locale.Default))
		}
		res.Problems = append(res.Problems, text)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(res); err != nil {
		panic(err)
	}
}

func caseSensitivity(sensitive bool) tspath.CaseSensitivity {
	if sensitive {
		return tspath.CaseSensitive
	}
	return tspath.CaseInsensitive
}
