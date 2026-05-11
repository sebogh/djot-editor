// Package main is the zorto HTTP server: a single binary that embeds the
// built SPA, exposes a small JSON API, and (optionally) integrates Auth0 as
// a confidential OAuth client.
//
// Routes:
//
//	GET  /api/healthz         — liveness probe
//	GET  /api/config          — public feature flags consumed by the SPA
//	GET  /api/auth/login      — start Auth0 PKCE flow                 (auth-on)
//	GET  /api/auth/callback   — Auth0 redirects here after login      (auth-on)
//	POST /api/auth/logout     — drop session cookie + DB row          (auth-on)
//	GET  /api/me              — return the signed-in user's profile   (auth-on)
//	GET  /api/state           — read this user's working state JSON   (auth-on)
//	PUT  /api/state           — replace this user's working state     (auth-on)
//	POST /api/shares          — create an end-to-end encrypted share  (auth-on + -share)
//	GET  /api/shares/{id}     — fetch an opaque ciphertext blob       (always)
//	GET  /…                   — embedded SPA assets
//
// Storage is SQLite via the modernc.org/sqlite pure-Go driver (no cgo). All
// auth-related code lives in auth.go; this file owns the wiring.
package main

import (
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// distFS holds the Vite-built SPA. The `all:` prefix tells embed to include
// dotfiles too — needed because Vite emits `.vite/` metadata in some configs.
//
//go:embed all:web/dist
var distFS embed.FS

// Body-size caps for the two endpoints that accept arbitrary JSON. Both are
// per-request limits; nothing in the schema enforces a per-user total.
const (
	maxShareBytes = 1 << 20 // 1 MB
	maxStateBytes = 1 << 20 // 1 MB
)

// shareRequest is the body of POST /api/shares. The ciphertext is opaque to
// the server; the AES-GCM key never leaves the SPA.
type shareRequest struct {
	Ciphertext string `json:"ciphertext"`
}

// shareIDResponse is the body of POST /api/shares on success.
type shareIDResponse struct {
	ID string `json:"id"`
}

// shareGetResponse is the body of GET /api/shares/{id} on success.
type shareGetResponse struct {
	Ciphertext string `json:"ciphertext"`
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dbPath := flag.String("db", "zorto.db", "sqlite database path")
	share := flag.Bool("share", false, "allow creating new shares")
	logLevel := flag.String("log-level", "debug", "log level (debug, info, warn, error)")
	flag.Parse()

	setupLogger(*logLevel)

	db, err := sql.Open("sqlite", *dbPath)
	if err != nil {
		fatal("sql.Open", "err", err)
	}
	defer db.Close()

	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := db.Exec(pragma); err != nil {
			fatal("pragma", "pragma", pragma, "err", err)
		}
	}

	// Schema. Idempotent — existing tables are left in place. To migrate a
	// schema change, drop the affected table out-of-band before restart;
	// migrations are not implemented because the data is cheap to recreate.
	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS shares (
			id         TEXT PRIMARY KEY,
			owner_sub  TEXT NOT NULL,
			ciphertext TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id         TEXT PRIMARY KEY,
			sub        TEXT NOT NULL,
			user_json  TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS auth_states (
			state      TEXT PRIMARY KEY,
			verifier   TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS user_state (
			sub        TEXT PRIMARY KEY,
			state_json TEXT NOT NULL DEFAULT '{}',
			updated_at INTEGER NOT NULL
		)`,
	} {
		if _, err := db.Exec(ddl); err != nil {
			fatal("schema", "err", err)
		}
	}

	dist, err := fs.Sub(distFS, "web/dist")
	if err != nil {
		fatal("embed", "err", err)
	}

	authCfg := loadAuthConfig()
	var ah *authHandler
	if authCfg.enabled() {
		var err error
		ah, err = newAuthHandler(authCfg, db)
		if err != nil {
			fatal("auth", "err", err)
		}
		cleanupExpired(db)
		slog.Info("auth enabled", "domain", authCfg.Domain)
	} else {
		slog.Info("auth disabled (set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET to enable)")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"shareEnabled": *share,
			"authEnabled":  authCfg.enabled(),
		})
	})
	if ah != nil {
		mux.HandleFunc("GET /api/auth/login", ah.handleLogin)
		mux.HandleFunc("GET /api/auth/callback", ah.handleCallback)
		mux.HandleFunc("POST /api/auth/logout", ah.handleLogout)
		mux.HandleFunc("GET /api/me", ah.handleMe)

		mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
			sub, ok := ah.requireAuth(w, r)
			if !ok {
				return
			}
			var stateJSON string
			err := db.QueryRowContext(r.Context(),
				"SELECT state_json FROM user_state WHERE sub = ?", sub,
			).Scan(&stateJSON)
			if errors.Is(err, sql.ErrNoRows) {
				stateJSON = "{}"
			} else if err != nil {
				http.Error(w, "lookup", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(stateJSON))
		})
		mux.HandleFunc("PUT /api/state", func(w http.ResponseWriter, r *http.Request) {
			sub, ok := ah.requireAuth(w, r)
			if !ok {
				return
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, maxStateBytes+1))
			if err != nil {
				http.Error(w, "read body", http.StatusBadRequest)
				return
			}
			if len(body) > maxStateBytes {
				http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
				return
			}
			if !json.Valid(body) {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			if _, err := db.ExecContext(r.Context(),
				`INSERT INTO user_state (sub, state_json, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(sub) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
				sub, string(body), time.Now().Unix(),
			); err != nil {
				http.Error(w, "store", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}
	mux.HandleFunc("POST /api/shares", func(w http.ResponseWriter, r *http.Request) {
		if !*share {
			http.Error(w, "sharing is disabled", http.StatusForbidden)
			return
		}
		if ah == nil {
			http.Error(w, "sharing requires sign-in but auth is not configured", http.StatusForbidden)
			return
		}
		sub, ok := ah.sessionSub(r)
		if !ok {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxShareBytes+1))
		if err != nil {
			http.Error(w, "read body", http.StatusBadRequest)
			return
		}
		if len(body) > maxShareBytes {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		var req shareRequest
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if req.Ciphertext == "" {
			http.Error(w, "ciphertext required", http.StatusBadRequest)
			return
		}
		id, err := newShareID()
		if err != nil {
			http.Error(w, "generate id", http.StatusInternalServerError)
			return
		}
		if _, err := db.Exec(
			"INSERT INTO shares (id, owner_sub, ciphertext, created_at) VALUES (?, ?, ?, ?)",
			id, sub, req.Ciphertext, time.Now().Unix(),
		); err != nil {
			http.Error(w, "store", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(shareIDResponse{ID: id})
	})
	mux.HandleFunc("GET /api/shares/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var ciphertext string
		err := db.QueryRow("SELECT ciphertext FROM shares WHERE id = ?", id).Scan(&ciphertext)
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "lookup", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(shareGetResponse{Ciphertext: ciphertext})
	})
	mux.Handle("/", staticCache(http.FileServer(http.FS(dist))))

	slog.Info("listening", "addr", *addr)
	if err := http.ListenAndServe(*addr, loggingMiddleware(mux)); err != nil {
		fatal("listen", "err", err)
	}
}

// staticCache sets Cache-Control on responses from the embedded SPA. Vite
// emits content-hashed files under /assets/, so those are safe to cache
// forever. The favicon is unhashed but changes rarely, so a one-day TTL
// keeps it out of the request path without trapping a stale icon. Everything
// else (index.html, logos) must revalidate so a redeploy is picked up
// immediately.
func staticCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case r.URL.Path == "/favicon.ico":
			w.Header().Set("Cache-Control", "public, max-age=86400")
		default:
			w.Header().Set("Cache-Control", "no-cache")
		}
		h.ServeHTTP(w, r)
	})
}

// newShareID returns a random 12-character base64url id used as the primary
// key of the shares table. 9 random bytes give ~7e21 distinct values, which
// is more than enough to make collisions a non-issue at this scale and keeps
// the URL fragment short.
func newShareID() (string, error) {
	b := make([]byte, 9)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
