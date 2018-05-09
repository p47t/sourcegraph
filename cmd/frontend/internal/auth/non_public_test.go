package auth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sourcegraph/sourcegraph/pkg/actor"
)

func TestAllowAnonymousRequest(t *testing.T) {
	req := func(method, urlStr string) *http.Request {
		r, err := http.NewRequest(method, urlStr, nil)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	tests := []struct {
		req  *http.Request
		want bool
	}{
		{req: req("GET", "/"), want: false},
		{req: req("POST", "/"), want: false},
		{req: req("POST", "/-/sign-in"), want: true},
		{req: req("GET", "/sign-in"), want: true},
		{req: req("GET", "/doesntexist"), want: false},
		{req: req("POST", "/doesntexist"), want: false},
		{req: req("GET", "/doesnt/exist"), want: false},
		{req: req("POST", "/doesnt/exist"), want: false},
		{req: req("POST", "/.api/telemetry/log/v1/production"), want: true},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("%s %s", test.req.Method, test.req.URL), func(t *testing.T) {
			got := allowAnonymousRequest(test.req)
			if got != test.want {
				t.Errorf("got %v, want %v", got, test.want)
			}
		})
	}
}

func TestNewUserRequiredAuthzMiddleware(t *testing.T) {
	withAuth := func(r *http.Request) *http.Request {
		return r.WithContext(actor.WithActor(context.Background(), &actor.Actor{UID: 1}))
	}

	middleware := newUserRequiredAuthzMiddleware()

	testcases := []struct {
		name       string
		req        *http.Request
		allowed    bool
		wantStatus int
		location   string
	}{
		{
			name:       "no_auth__private_route",
			req:        httptest.NewRequest("GET", "/", nil),
			allowed:    false,
			wantStatus: http.StatusFound,
			location:   "/sign-in?returnTo=%2F",
		},
		{
			name:       "no_auth__api_route",
			req:        httptest.NewRequest("GET", "/.api/graphql", nil),
			allowed:    false,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "no_auth__public_route",
			req:        httptest.NewRequest("GET", "/sign-in", nil),
			allowed:    true,
			wantStatus: http.StatusOK,
		},
		{
			name:       "auth__private_route",
			req:        withAuth(httptest.NewRequest("GET", "/", nil)),
			allowed:    true,
			wantStatus: http.StatusOK,
		},
		{
			name:       "auth__api_route",
			req:        withAuth(httptest.NewRequest("GET", "/.api/graphql", nil)),
			allowed:    true,
			wantStatus: http.StatusOK,
		},
		{
			name:       "auth__public_route",
			req:        withAuth(httptest.NewRequest("GET", "/sign-in", nil)),
			allowed:    true,
			wantStatus: http.StatusOK,
		},
	}
	for _, tst := range testcases {
		t.Run(tst.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			allowed := false
			setAllowedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { allowed = true })

			handler := http.NewServeMux()
			handler.Handle("/.api/", middleware.API(setAllowedHandler))
			handler.Handle("/", middleware.App(setAllowedHandler))
			handler.ServeHTTP(rec, tst.req)

			if allowed != tst.allowed {
				t.Fatalf("got request allowed %v want %v", allowed, tst.allowed)
			}
			if status := rec.Result().StatusCode; status != tst.wantStatus {
				t.Fatalf("got status code %v want %v", status, tst.wantStatus)
			}
			loc := rec.Result().Header.Get("Location")
			if loc != tst.location {
				t.Fatalf("got location %q want %q", loc, tst.location)
			}
		})
	}
}