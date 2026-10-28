package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"html"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

//go:embed public
var publicFS embed.FS

// asset is one file from public/, ready to serve.
type asset struct {
	body, gz    []byte
	etag, ctype string
	// Set for pages with inline scripts, which the policy has to name by hash.
	policy string
}

// contentPolicy lets pages run only their own files and the inline scripts with these hashes.
func contentPolicy(scriptHashes ...string) string {
	script := "'self'"
	for _, h := range scriptHashes {
		script += " 'sha256-" + h + "'"
	}
	return "default-src 'none'; script-src " + script + "; style-src 'self'; img-src 'self' data:; " +
		"connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
}

var (
	basePolicy   = contentPolicy()
	inlineScript = regexp.MustCompile(`(?s)<script>(.*?)</script>`)
)

// Static serves the files in public/, read and gzipped once at startup and kept in memory. In
// development, STATIC_DIR serves them from disk instead, so page edits show on reload.
type Static struct {
	assets map[string]*asset
	devDir string
}

func loadStatic(devDir string) (*Static, error) {
	s := &Static{assets: map[string]*asset{}, devDir: devDir}
	if devDir != "" {
		return s, nil
	}
	err := fs.WalkDir(publicFS, "public", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := publicFS.ReadFile(p)
		if err != nil {
			return err
		}
		s.assets[strings.TrimPrefix(p, "public/")] = newAsset(p, body)
		return nil
	})
	return s, err
}

// newAsset prepares a file: its gzipped copy when that's smaller, ETag, content type and, for a
// page with inline scripts, a policy naming them.
func newAsset(name string, body []byte) *asset {
	sum := sha256.Sum256(body)
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	zw.Write(body)
	zw.Close()
	a := &asset{body: body, etag: `"` + hex.EncodeToString(sum[:8]) + `"`, ctype: mime.TypeByExtension(path.Ext(name))}
	if buf.Len() < len(body) {
		a.gz = buf.Bytes()
	}
	if a.ctype == "" {
		a.ctype = "application/octet-stream"
	}
	if strings.HasPrefix(a.ctype, "text/") && !strings.Contains(a.ctype, "charset") {
		a.ctype += "; charset=utf-8"
	}
	var hashes []string
	for _, m := range inlineScript.FindAllSubmatch(body, -1) {
		h := sha256.Sum256(m[1])
		hashes = append(hashes, base64.StdEncoding.EncodeToString(h[:]))
	}
	if hashes != nil {
		a.policy = contentPolicy(hashes...)
	}
	return a
}

func (s *Static) get(name string) *asset {
	if s.devDir == "" {
		return s.assets[name]
	}
	body, err := os.ReadFile(filepath.Join(s.devDir, filepath.FromSlash(name)))
	if err != nil {
		return nil
	}
	return newAsset(name, body)
}

func acceptsGzip(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

// Serve sends the named file from public/ with the given status, or a 404 when there's none.
func (s *Static) Serve(w http.ResponseWriter, r *http.Request, name string, status int) {
	a := s.get(name)
	if a == nil {
		writeError(w, &httpError{404, "Not found"})
		return
	}
	s.serveAsset(w, r, a, status)
}

// ServeTally fills in the tally's name and snapshot, so the first paint already shows the tally
// rather than moving everything when it loads. One pass, so neither can bring in the other's
// placeholder. The JSON encoder escapes <, > and &, so nothing in it can close the script tag.
// A nil snapshot is sent as null, and the page fetches it instead.
func (s *Static) ServeTally(w http.ResponseWriter, r *http.Request, name string, t *Tally, snap *snapshot) error {
	a := s.get(name)
	if a == nil {
		return &httpError{404, "Not found"}
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	fill := strings.NewReplacer("{{name}}", html.EscapeString(t.Name), "{{snapshot}}", string(data))
	w.Header().Set("Content-Type", a.ctype)
	if a.policy != "" {
		w.Header().Set("Content-Security-Policy", a.policy)
	}
	writeFresh(w, r, 200, []byte(fill.Replace(string(a.body))))
	return nil
}

func (s *Static) serveAsset(w http.ResponseWriter, r *http.Request, a *asset, status int) {
	h := w.Header()
	h.Set("Content-Type", a.ctype)
	h.Set("Cache-Control", "no-cache")
	h.Set("Vary", "Accept-Encoding")
	h.Set("ETag", a.etag)
	if a.policy != "" {
		h.Set("Content-Security-Policy", a.policy)
	}
	if status == http.StatusOK && r.Header.Get("If-None-Match") == a.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body := a.body
	if a.gz != nil && acceptsGzip(r) {
		h.Set("Content-Encoding", "gzip")
		body = a.gz
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		w.Write(body)
	}
}
