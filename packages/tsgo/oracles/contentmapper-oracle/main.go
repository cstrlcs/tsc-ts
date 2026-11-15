// Command contentmapper-oracle prints what TypeScript-Go makes of a content
// mapper for the JSON request in the file named by the first argument, as
// JSON on stdout.
//
// The request is a list of cases. Each has a mapper (the entry of
// "contentMappers" and the manifest of its package), compiler options, a
// file name and its content, and the responses a mapper process gives to
// "initialize", "openProject" and "transform". A response of the form
// {"$error": "message"} fails the request instead. The oracle runs
// TypeScript-Go's content mapper host against a mapper that gives those
// responses, and answers with the mapper's identities, the compiler options
// as JSON, the parameters each request carried, the decoded transform result
// or its error, and the virtual files the result is parsed into.
//
// Positions are printed as UTF-16 offsets, where TypeScript-Go counts bytes.
package main

import (
	"context"
	stdjson "encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/contentmapper"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/ipc"
	"github.com/microsoft/TypeScript/tsc/internal/json"
	"github.com/microsoft/TypeScript/tsc/internal/locale"
	"github.com/microsoft/TypeScript/tsc/internal/spanmap"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
)

type mapperSpec struct {
	Package                 string             `json:"package"`
	Extensions              []string           `json:"extensions"`
	OutputExtensions        map[string]string  `json:"outputExtensions"`
	Options                 stdjson.RawMessage `json:"options"`
	Name                    string             `json:"name"`
	Version                 string             `json:"version"`
	Exec                    []string           `json:"exec"`
	CompilerOptions         []string           `json:"compilerOptions"`
	DynamicConfig           bool               `json:"dynamicConfig"`
	DefaultOutputExtensions map[string]string  `json:"defaultOutputExtensions"`
	ContributionID          string             `json:"contributionId"`
}

type request struct {
	Mapper          mapperSpec         `json:"mapper"`
	CompilerOptions stdjson.RawMessage `json:"compilerOptions"`
	ConfigFileName  string             `json:"configFileName"`
	FileName        string             `json:"fileName"`
	Content         string             `json:"content"`
	Initialize      stdjson.RawMessage `json:"initialize"`
	OpenProject     stdjson.RawMessage `json:"openProject"`
	Transform       stdjson.RawMessage `json:"transform"`
}

type answer struct {
	Identity          string            `json:"identity"`
	DiagnosticName    string            `json:"diagnosticName"`
	CompilerOptions   string            `json:"compilerOptions"`
	DeclaredOptions   string            `json:"declaredOptions"`
	TransformIdentity string            `json:"transformIdentity"`
	ProjectIdentity   any               `json:"projectIdentity"`
	Params            map[string]string `json:"params"`
	Transform         any               `json:"transform"`
	Parse             any               `json:"parse"`
	WatchedFiles      any               `json:"watchedFiles"`
	OptionDiagnostics [][]any           `json:"optionDiagnostics"`
}

// canned answers each request of the protocol with the response its case gives, and records the parameters.
type canned struct {
	request *request
	mu      sync.Mutex
	params  map[string]string
}

func (c *canned) HandleRequest(ctx context.Context, method string, params json.Value) (any, error) {
	c.mu.Lock()
	c.params[method] = string(params)
	c.mu.Unlock()
	var response stdjson.RawMessage
	switch method {
	case contentmapper.MethodInitialize:
		response = c.request.Initialize
	case contentmapper.MethodOpenProject:
		response = c.request.OpenProject
		if response == nil {
			response = stdjson.RawMessage(`{}`)
		}
	case contentmapper.MethodTransform:
		response = c.request.Transform
	case contentmapper.MethodCloseProject:
		return nil, nil
	default:
		return nil, fmt.Errorf("unexpected method %s", method)
	}
	var failure struct {
		Error *string `json:"$error"`
	}
	if stdjson.Unmarshal(response, &failure) == nil && failure.Error != nil {
		return nil, errors.New(*failure.Error)
	}
	return json.Value(response), nil
}

func (c *canned) HandleNotification(ctx context.Context, method string, params json.Value) error {
	return nil
}

func describeError(err error) map[string]any {
	out := map[string]any{"message": err.Error()}
	if e, ok := errors.AsType[*contentmapper.TransformError](err); ok {
		out["kind"] = int(e.Kind)
	}
	if e, ok := errors.AsType[*contentmapper.InitializeError](err); ok {
		out["initialize"] = []any{int(e.Kind), string(e.PositionEncoding), e.DiagnosticSource}
	}
	if e, ok := errors.AsType[*contentmapper.ProjectError](err); ok {
		out["project"] = int(e.Kind)
	}
	if e, ok := errors.AsType[*contentmapper.InvalidVirtualExtensionError](err); ok {
		out["extension"] = e.Extension
	}
	if e, ok := errors.AsType[*contentmapper.DiagnosticDirectiveError](err); ok {
		out["directive"] = []int{int(e.Kind), e.Index, e.SupplementalIndex, int(e.Policy)}
	}
	if e, ok := errors.AsType[*spanmap.MappingError](err); ok {
		out["mapping"] = []int{int(e.Kind), int(e.VirtualPos), int(e.OriginalPos)}
	}
	return out
}

func describeOutput(text string, extension string, mappings *spanmap.SpanMap, directives []ast.MappedDiagnosticDirective, original *ast.PositionMap) map[string]any {
	virtual := ast.ComputePositionMap(text)
	segments := [][]int{}
	for _, s := range mappings.Segments() {
		segments = append(segments, []int{
			virtual.UTF8ToUTF16(int(s.VirtualStart)), virtual.UTF8ToUTF16(int(s.VirtualEnd)),
			original.UTF8ToUTF16(int(s.OriginalStart)), original.UTF8ToUTF16(int(s.OriginalEnd)),
			int(s.Kind), int(s.Features),
		})
	}
	described := [][]any{}
	for _, d := range directives {
		described = append(described, []any{
			original.UTF8ToUTF16(d.OriginalRange.Pos()), original.UTF8ToUTF16(d.OriginalRange.End()),
			virtual.UTF8ToUTF16(d.VirtualRange.Pos()), virtual.UTF8ToUTF16(d.VirtualRange.End()),
			int(d.Policy), int(d.UnusedCode), d.UnusedMessageText, d.Source,
		})
	}
	return map[string]any{"text": text, "extension": extension, "segments": segments, "directives": described}
}

func describeResult(result contentmapper.Result, content string) map[string]any {
	original := ast.ComputePositionMap(content)
	out := describeOutput(result.Text, result.VirtualExtension, result.Mappings, result.DiagnosticDirectives, original)
	diagnostics := [][]any{}
	for _, d := range result.Diagnostics {
		diagnostics = append(diagnostics, []any{original.UTF8ToUTF16(d.Pos()), original.UTF8ToUTF16(d.End()), d.Source(), int(d.Code()), d.MessageText()})
	}
	out["diagnostics"] = diagnostics
	supplemental := []map[string]any{}
	for _, s := range result.Supplemental {
		supplemental = append(supplemental, describeOutput(s.Text, s.VirtualExtension, s.Mappings, s.DiagnosticDirectives, original))
	}
	out["supplemental"] = supplemental
	return out
}

func describeFile(file *ast.SourceFile, name tspath.RootedFilePath) []any {
	return []any{name.AsString(), int(file.ScriptKind), file.ParseOptions().ExternalModuleIndicatorOptions.Force}
}

func run(r *request) answer {
	mapper := &contentmapper.Mapper{
		Definition: contentmapper.Definition{
			Package:          r.Mapper.Package,
			Extensions:       r.Mapper.Extensions,
			OutputExtensions: r.Mapper.OutputExtensions,
			Options:          json.Value(r.Mapper.Options),
		},
		Manifest: contentmapper.Manifest{
			Name:                    r.Mapper.Name,
			Version:                 r.Mapper.Version,
			Exec:                    r.Mapper.Exec,
			CompilerOptions:         r.Mapper.CompilerOptions,
			DynamicConfig:           r.Mapper.DynamicConfig,
			DefaultOutputExtensions: r.Mapper.DefaultOutputExtensions,
		},
		ContributionID: r.Mapper.ContributionID,
	}
	options := &core.CompilerOptions{}
	if r.CompilerOptions != nil {
		if err := json.Unmarshal(r.CompilerOptions, options); err != nil {
			panic(err)
		}
	}
	a := answer{Identity: mapper.Identity(), DiagnosticName: mapper.DiagnosticName(), OptionDiagnostics: [][]any{}}
	marshaled, err := json.Marshal(options)
	if err != nil {
		panic(err)
	}
	a.CompilerOptions = string(marshaled)
	declared, err := mapper.MarshalDeclaredOptions(options)
	if err != nil {
		panic(err)
	}
	marshaled, err = json.Marshal(declared)
	if err != nil {
		panic(err)
	}
	a.DeclaredOptions = string(marshaled)
	a.TransformIdentity = fmt.Sprintf("%x", mapper.TransformIdentity(options).Bytes())

	handler := &canned{request: r, params: map[string]string{}}
	spawner := contentmapper.SpawnerFunc(func(command []string, dir string, stderr io.Writer) (io.ReadWriteCloser, error) {
		client, server := net.Pipe()
		go func() { _ = ipc.NewAsyncConn(server, handler).Run(context.Background()) }()
		return client, nil
	})
	host := contentmapper.NewHost(context.Background(), spawner, locale.Default)
	defer host.Close()
	project := host.Project(contentmapper.ProjectSpec{
		ConfigFileName:  tspath.RootedFilePath(r.ConfigFileName),
		Mappers:         []*contentmapper.Mapper{mapper},
		CompilerOptions: options,
	})
	defer project.Close()

	fileName := tspath.RootedFilePath(r.FileName)
	result, err := project.Transform(mapper, contentmapper.Request{FileName: fileName, Content: r.Content})
	if err != nil {
		a.Transform = map[string]any{"error": describeError(err)}
	} else {
		a.Transform = map[string]any{"result": describeResult(result, r.Content)}
		parseOptions := ast.SourceFileParseOptions{FileName: fileName, PathKey: tspath.PathKey(r.FileName)}
		files, err := contentmapper.ParseResult(parseOptions, r.Content, mapper, "identity", result)
		if err != nil {
			a.Parse = map[string]any{"error": describeError(err)}
		} else {
			described := [][]any{describeFile(files.Canonical, files.Canonical.VirtualFileName())}
			for _, file := range files.Supplemental {
				described = append(described, describeFile(file, file.FileName()))
			}
			a.Parse = map[string]any{"files": described}
		}
	}
	if identity, err := project.Identity(mapper); err != nil {
		a.ProjectIdentity = map[string]any{"error": describeError(err)}
	} else {
		a.ProjectIdentity = identity
	}
	if watched, err := project.WatchedFiles(); err != nil {
		a.WatchedFiles = map[string]any{"error": describeError(err)}
	} else {
		names := []string{}
		for _, name := range watched {
			names = append(names, name.AsString())
		}
		a.WatchedFiles = names
	}
	for _, d := range project.Diagnostics() {
		path := []any{}
		for _, segment := range d.Path {
			if segment.IsIndex {
				path = append(path, segment.Index)
			} else {
				path = append(path, segment.Property)
			}
		}
		a.OptionDiagnostics = append(a.OptionDiagnostics, []any{path, d.Source, int(d.Code), d.MessageText})
	}
	handler.mu.Lock()
	a.Params = handler.params
	handler.mu.Unlock()
	return a
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var requests []request
	if err := stdjson.Unmarshal(data, &requests); err != nil {
		panic(err)
	}
	answers := make([]answer, len(requests))
	for i := range requests {
		answers[i] = run(&requests[i])
	}
	out, err := stdjson.Marshal(answers)
	if err != nil {
		panic(err)
	}
	os.Stdout.Write(out)
}
