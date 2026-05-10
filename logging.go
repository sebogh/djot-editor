package main

// Logging plumbing for zorto. Three pieces live here:
//
//   - loggingMiddleware wraps every HTTP handler and emits one structured
//     log line per request, with the status raised to Warn/Error for 4xx/5xx.
//   - setupLogger / parseLogLevel configure the slog default handler from
//     the -log-level flag.
//   - clientIP / fatal are small utilities used by the rest of the binary.

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// responseRecorder wraps http.ResponseWriter to capture the status code and
// bytes written so the logging middleware can log them after the handler returns.
type responseRecorder struct {
	http.ResponseWriter
	status      int
	bytes       int
	wroteHeader bool
}

func (r *responseRecorder) WriteHeader(code int) {
	if r.wroteHeader {
		return
	}
	r.status = code
	r.wroteHeader = true
	r.ResponseWriter.WriteHeader(code)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.status = http.StatusOK
		r.wroteHeader = true
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		attrs := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"durationMs", time.Since(start).Milliseconds(),
			"bytesIn", r.ContentLength,
			"bytesOut", rec.bytes,
			"ip", clientIP(r),
			//"ua", r.UserAgent(),
		}

		switch {
		case rec.status >= 500:
			slog.Error("http", attrs...)
		case rec.status >= 400:
			slog.Warn("http", attrs...)
		default:
			slog.Debug("http", attrs...)
		}
	})
}

// clientIP returns the best-guess client address, honoring X-Forwarded-For /
// X-Real-IP set by an upstream reverse proxy. Safe in this deploy because the
// Go server only listens on 127.0.0.1, so the headers can't be spoofed by an
// external client — they always pass through nginx.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func setupLogger(logLevel string) {
	level, err := parseLogLevel(logLevel)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	h := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})
	slog.SetDefault(slog.New(h))
}

func parseLogLevel(s string) (slog.Level, error) {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("invalid log level %q (want debug, info, warn, error)", s)
	}
}

func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}
