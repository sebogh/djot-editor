package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/auth0/go-jwt-middleware/v2/jwks"
	"github.com/auth0/go-jwt-middleware/v2/validator"
)

type authConfig struct {
	Domain   string
	ClientID string
	Audience string
}

func (a authConfig) enabled() bool {
	return a.Domain != "" && a.ClientID != "" && a.Audience != ""
}

func (a authConfig) issuerURL() string {
	return "https://" + strings.TrimSuffix(a.Domain, "/") + "/"
}

func loadAuthConfig() authConfig {
	return authConfig{
		Domain:   os.Getenv("AUTH0_DOMAIN"),
		ClientID: os.Getenv("AUTH0_CLIENT_ID"),
		Audience: os.Getenv("AUTH0_AUDIENCE"),
	}
}

type tokenValidator struct {
	v *validator.Validator
}

func newTokenValidator(cfg authConfig) (*tokenValidator, error) {
	issuer, err := url.Parse(cfg.issuerURL())
	if err != nil {
		return nil, err
	}
	provider := jwks.NewCachingProvider(issuer, 5*time.Minute)
	v, err := validator.New(
		provider.KeyFunc,
		validator.RS256,
		issuer.String(),
		[]string{cfg.Audience},
		validator.WithAllowedClockSkew(30*time.Second),
	)
	if err != nil {
		return nil, err
	}
	return &tokenValidator{v: v}, nil
}

type principal struct {
	Sub string
}

type ctxKey int

const principalKey ctxKey = 0

func principalFrom(ctx context.Context) (principal, bool) {
	p, ok := ctx.Value(principalKey).(principal)
	return p, ok
}

// authenticate parses and validates a Bearer token if present. It never
// rejects: a missing or invalid token simply leaves the request unauthenticated.
// Endpoints that require auth check principalFrom themselves.
func (tv *tokenValidator) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		claims, err := tv.v.ValidateToken(r.Context(), token)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		vc, ok := claims.(*validator.ValidatedClaims)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		ctx := context.WithValue(r.Context(), principalKey, principal{Sub: vc.RegisteredClaims.Subject})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(h[len(prefix):]), true
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	p, ok := principalFrom(r.Context())
	if !ok {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"sub": p.Sub})
}
