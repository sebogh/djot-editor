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

const maxShareBytes = 1 << 20 // 1 MB

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

	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS shares (
		id         TEXT PRIMARY KEY,
		ciphertext TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`); err != nil {
		fatal("schema", "err", err)
	}

	dist, err := fs.Sub(distFS, "web/dist")
	if err != nil {
		fatal("embed", "err", err)
	}

	authCfg := loadAuthConfig()
	var tv *tokenValidator
	if authCfg.enabled() {
		var err error
		tv, err = newTokenValidator(authCfg)
		if err != nil {
			fatal("auth", "err", err)
		}
		slog.Info("auth enabled", "domain", authCfg.Domain, "audience", authCfg.Audience)
	} else {
		slog.Info("auth disabled (set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE to enable)")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := map[string]any{"shareEnabled": *share}
		if authCfg.enabled() {
			resp["auth"] = map[string]string{
				"domain":   authCfg.Domain,
				"clientId": authCfg.ClientID,
				"audience": authCfg.Audience,
			}
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
	if tv != nil {
		mux.Handle("GET /api/me", tv.authenticate(http.HandlerFunc(handleMe)))
	}
	mux.HandleFunc("POST /api/shares", func(w http.ResponseWriter, r *http.Request) {
		if !*share {
			http.Error(w, "sharing is disabled", http.StatusForbidden)
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
			"INSERT INTO shares (id, ciphertext, created_at) VALUES (?, ?, ?)",
			id, req.Ciphertext, time.Now().Unix(),
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
