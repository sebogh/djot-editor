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
	"log"
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
	flag.Parse()

	db, err := sql.Open("sqlite", *dbPath)
	if err != nil {
		log.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := db.Exec(pragma); err != nil {
			log.Fatalf("pragma %q: %v", pragma, err)
		}
	}

	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS shares (
		id         TEXT PRIMARY KEY,
		ciphertext TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`); err != nil {
		log.Fatalf("schema: %v", err)
	}

	dist, err := fs.Sub(distFS, "web/dist")
	if err != nil {
		log.Fatalf("embed: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /api/shares", func(w http.ResponseWriter, r *http.Request) {
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

	log.Printf("listening on %s", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}

func newShareID() (string, error) {
	b := make([]byte, 9) // 12 chars in base64url, ~7e21 collision space
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
