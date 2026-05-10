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
	"time"

	_ "modernc.org/sqlite"
)

//go:embed all:web/dist
var distFS embed.FS

const (
	maxShareBytes = 1 << 20 // 1 MB
	maxStateBytes = 1 << 20 // 1 MB
)

type shareRequest struct {
	Ciphertext string `json:"ciphertext"`
}

type shareIDResponse struct {
	ID string `json:"id"`
}

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
	mux.Handle("/", http.FileServer(http.FS(dist)))

	slog.Info("listening", "addr", *addr)
	if err := http.ListenAndServe(*addr, loggingMiddleware(mux)); err != nil {
		fatal("listen", "err", err)
	}
}

func newShareID() (string, error) {
	b := make([]byte, 9) // 12 chars in base64url, ~7e21 collision space
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
