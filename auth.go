package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/auth0/go-jwt-middleware/v2/jwks"
	"github.com/auth0/go-jwt-middleware/v2/validator"
)

const (
	sessionCookieName = "zorto_session"
	sessionTTL        = 30 * 24 * time.Hour
	authStateTTL      = 10 * time.Minute
)

type authConfig struct {
	Domain       string
	ClientID     string
	ClientSecret string
	RedirectURI  string // optional override of the auto-derived callback URL
}

func (a authConfig) enabled() bool {
	return a.Domain != "" && a.ClientID != "" && a.ClientSecret != ""
}

func (a authConfig) issuerURL() string {
	return "https://" + strings.TrimSuffix(a.Domain, "/") + "/"
}

func loadAuthConfig() authConfig {
	return authConfig{
		Domain:       os.Getenv("AUTH0_DOMAIN"),
		ClientID:     os.Getenv("AUTH0_CLIENT_ID"),
		ClientSecret: os.Getenv("AUTH0_CLIENT_SECRET"),
		RedirectURI:  os.Getenv("AUTH0_REDIRECT_URI"),
	}
}

// idTokenClaims captures the OIDC profile fields we cache in the session row.
type idTokenClaims struct {
	Name    string `json:"name"`
	Email   string `json:"email"`
	Picture string `json:"picture"`
}

func (c *idTokenClaims) Validate(_ context.Context) error { return nil }

type authHandler struct {
	cfg       authConfig
	db        *sql.DB
	validator *validator.Validator
	httpc     *http.Client
}

func newAuthHandler(cfg authConfig, db *sql.DB) (*authHandler, error) {
	issuer, err := url.Parse(cfg.issuerURL())
	if err != nil {
		return nil, err
	}
	provider := jwks.NewCachingProvider(issuer, 5*time.Minute)
	v, err := validator.New(
		provider.KeyFunc,
		validator.RS256,
		issuer.String(),
		[]string{cfg.ClientID}, // id_token's audience is the client_id
		validator.WithAllowedClockSkew(30*time.Second),
		validator.WithCustomClaims(func() validator.CustomClaims {
			return &idTokenClaims{}
		}),
	)
	if err != nil {
		return nil, err
	}
	return &authHandler{
		cfg:       cfg,
		db:        db,
		validator: v,
		httpc:     &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// resolveURIs returns the absolute callback URL Auth0 should redirect to and
// the absolute SPA root the user lands on after login/logout. Either the
// AUTH0_REDIRECT_URI env var is honored as-is, or both are derived from the
// incoming request (honoring X-Forwarded-Proto / X-Forwarded-Host).
func (h *authHandler) resolveURIs(r *http.Request) (callback, spaRoot string) {
	if h.cfg.RedirectURI != "" {
		callback = h.cfg.RedirectURI
		root := strings.TrimSuffix(callback, "/api/auth/callback")
		if root == callback {
			root = ""
		}
		spaRoot = root + "/"
		return
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	host := r.Host
	if hh := r.Header.Get("X-Forwarded-Host"); hh != "" {
		host = hh
	}
	callback = scheme + "://" + host + "/api/auth/callback"
	spaRoot = scheme + "://" + host + "/"
	return
}

func randB64(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func pkcePair() (verifier, challenge string, err error) {
	verifier, err = randB64(32)
	if err != nil {
		return
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return
}

func (h *authHandler) handleLogin(w http.ResponseWriter, r *http.Request) {
	state, err := randB64(24)
	if err != nil {
		http.Error(w, "state", http.StatusInternalServerError)
		return
	}
	verifier, challenge, err := pkcePair()
	if err != nil {
		http.Error(w, "pkce", http.StatusInternalServerError)
		return
	}
	if _, err := h.db.ExecContext(r.Context(),
		"INSERT INTO auth_states (state, verifier, created_at) VALUES (?, ?, ?)",
		state, verifier, time.Now().Unix(),
	); err != nil {
		slog.Error("auth: store state", "err", err)
		http.Error(w, "store state", http.StatusInternalServerError)
		return
	}
	callback, _ := h.resolveURIs(r)
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", h.cfg.ClientID)
	q.Set("redirect_uri", callback)
	q.Set("scope", "openid profile email")
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	http.Redirect(w, r, h.cfg.issuerURL()+"authorize?"+q.Encode(), http.StatusFound)
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	IDToken     string `json:"id_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}

func (h *authHandler) exchangeCode(ctx context.Context, code, verifier, redirectURI string) (*tokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", h.cfg.ClientID)
	form.Set("client_secret", h.cfg.ClientSecret)
	form.Set("code", code)
	form.Set("code_verifier", verifier)
	form.Set("redirect_uri", redirectURI)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		h.cfg.issuerURL()+"oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := h.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if err != nil {
		return nil, err
	}
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("auth0 /oauth/token: %d: %s", res.StatusCode, string(body))
	}
	var tr tokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, err
	}
	return &tr, nil
}

func (h *authHandler) handleCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		http.Error(w, "missing code or state", http.StatusBadRequest)
		return
	}

	var verifier string
	var createdAt int64
	err := h.db.QueryRowContext(r.Context(),
		"SELECT verifier, created_at FROM auth_states WHERE state = ?", state,
	).Scan(&verifier, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, "lookup state", http.StatusInternalServerError)
		return
	}
	// Single-use: drop the row immediately so a stolen state can't be replayed.
	_, _ = h.db.ExecContext(r.Context(), "DELETE FROM auth_states WHERE state = ?", state)
	if time.Since(time.Unix(createdAt, 0)) > authStateTTL {
		http.Error(w, "state expired", http.StatusBadRequest)
		return
	}

	callback, spaRoot := h.resolveURIs(r)
	tr, err := h.exchangeCode(r.Context(), code, verifier, callback)
	if err != nil {
		slog.Error("auth: code exchange", "err", err)
		http.Error(w, "code exchange failed", http.StatusBadGateway)
		return
	}

	claims, err := h.validator.ValidateToken(r.Context(), tr.IDToken)
	if err != nil {
		slog.Error("auth: id_token validation", "err", err)
		http.Error(w, "id_token invalid", http.StatusBadGateway)
		return
	}
	vc, ok := claims.(*validator.ValidatedClaims)
	if !ok {
		http.Error(w, "claims shape", http.StatusInternalServerError)
		return
	}
	user := struct {
		Sub     string `json:"sub"`
		Name    string `json:"name,omitempty"`
		Email   string `json:"email,omitempty"`
		Picture string `json:"picture,omitempty"`
	}{Sub: vc.RegisteredClaims.Subject}
	if c, ok := vc.CustomClaims.(*idTokenClaims); ok && c != nil {
		user.Name = c.Name
		user.Email = c.Email
		user.Picture = c.Picture
	}
	userJSON, err := json.Marshal(user)
	if err != nil {
		http.Error(w, "encode user", http.StatusInternalServerError)
		return
	}

	sid, err := randB64(32)
	if err != nil {
		http.Error(w, "sid", http.StatusInternalServerError)
		return
	}
	now := time.Now()
	if _, err := h.db.ExecContext(r.Context(),
		"INSERT INTO sessions (id, sub, user_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
		sid, user.Sub, string(userJSON), now.Unix(), now.Add(sessionTTL).Unix(),
	); err != nil {
		slog.Error("auth: store session", "err", err)
		http.Error(w, "store session", http.StatusInternalServerError)
		return
	}

	setSessionCookie(w, r, sid, sessionTTL)
	http.Redirect(w, r, spaRoot, http.StatusFound)
}

// handleLogout drops the server-side session, clears the cookie, and tells the
// caller where Auth0's logout endpoint is. The SPA navigates the user there to
// also clear Auth0's tenant cookie; on completion Auth0 redirects the user
// back to the SPA root.
func (h *authHandler) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" {
		_, _ = h.db.ExecContext(r.Context(), "DELETE FROM sessions WHERE id = ?", c.Value)
	}
	clearSessionCookie(w, r)

	_, spaRoot := h.resolveURIs(r)
	q := url.Values{}
	q.Set("client_id", h.cfg.ClientID)
	q.Set("returnTo", spaRoot)
	logoutURL := h.cfg.issuerURL() + "v2/logout?" + q.Encode()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"logoutUrl": logoutURL})
}

// requireAuth resolves the session sub or writes 401 and returns false.
// Use it as the first line of any authenticated handler.
func (h *authHandler) requireAuth(w http.ResponseWriter, r *http.Request) (string, bool) {
	sub, ok := h.sessionSub(r)
	if !ok {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return "", false
	}
	return sub, true
}

// sessionSub returns the Auth0 subject of the user owning the request's
// session cookie, or false if the cookie is missing, unknown, or expired.
// Other handlers use this to gate access to authenticated endpoints.
func (h *authHandler) sessionSub(r *http.Request) (string, bool) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil || c.Value == "" {
		return "", false
	}
	var sub string
	var expiresAt int64
	err = h.db.QueryRowContext(r.Context(),
		"SELECT sub, expires_at FROM sessions WHERE id = ?", c.Value,
	).Scan(&sub, &expiresAt)
	if err != nil {
		return "", false
	}
	if time.Now().Unix() > expiresAt {
		return "", false
	}
	return sub, true
}

func (h *authHandler) handleMe(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil || c.Value == "" {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	var userJSON string
	var expiresAt int64
	err = h.db.QueryRowContext(r.Context(),
		"SELECT user_json, expires_at FROM sessions WHERE id = ?", c.Value,
	).Scan(&userJSON, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		clearSessionCookie(w, r)
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, "lookup", http.StatusInternalServerError)
		return
	}
	if time.Now().Unix() > expiresAt {
		_, _ = h.db.ExecContext(r.Context(), "DELETE FROM sessions WHERE id = ?", c.Value)
		clearSessionCookie(w, r)
		http.Error(w, "session expired", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(userJSON))
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, sid string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sid,
		Path:     "/",
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(ttl.Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func isSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return r.Header.Get("X-Forwarded-Proto") == "https"
}

func cleanupExpired(db *sql.DB) {
	now := time.Now()
	if _, err := db.Exec("DELETE FROM auth_states WHERE created_at < ?",
		now.Add(-authStateTTL).Unix()); err != nil {
		slog.Warn("cleanup auth_states", "err", err)
	}
	if _, err := db.Exec("DELETE FROM sessions WHERE expires_at < ?", now.Unix()); err != nil {
		slog.Warn("cleanup sessions", "err", err)
	}
}
