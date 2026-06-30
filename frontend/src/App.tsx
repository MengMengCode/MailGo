import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import i18next from "i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import Layout from "@/app/Layout";
import { LoginPage } from "@/features/auth/LoginPage";
import { AUTH_UNAUTHORIZED_EVENT, authApi } from "@/lib/api";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: 16,
            padding: 24,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            color: "var(--geist-primary)",
            backgroundColor: "var(--geist-bg-100)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            {i18next.t("errorBoundary.title", "Something went wrong")}
          </h2>
          <p style={{ margin: 0, fontSize: 14, color: "var(--geist-secondary)" }}>
            {i18next.t(
              "errorBoundary.description",
              "Please try refreshing the application.",
            )}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8,
              padding: "8px 20px",
              cursor: "pointer",
              backgroundColor: "var(--geist-primary)",
              color: "var(--geist-bg-100)",
              border: "none",
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {i18next.t("errorBoundary.refresh", "Refresh")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  useEffect(() => {
    // i18n initialised in lib/i18n
  }, []);
  return (
    <ErrorBoundary>
      <AuthGuard />
    </ErrorBoundary>
  );
}

type AuthState = "checking" | "authenticated" | "unauthenticated";

function AuthGuard() {
  const [state, setState] = useState<AuthState>("checking");
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const intendedPath = useRef(
    location.pathname === "/login"
      ? "/"
      : `${location.pathname}${location.search}${location.hash}`,
  );

  useEffect(() => {
    let active = true;
    const unauthorized = () => {
      queryClient.clear();
      setState("unauthenticated");
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized);
    void authApi
      .session()
      .then(() => {
        if (active) setState("authenticated");
      })
      .catch(() => {
        if (active) unauthorized();
      });
    return () => {
      active = false;
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized);
    };
  }, [queryClient]);

  useEffect(() => {
    if (state === "unauthenticated" && location.pathname !== "/login") {
      navigate("/login", { replace: true });
    } else if (state === "authenticated" && location.pathname === "/login") {
      navigate(intendedPath.current, { replace: true });
    }
  }, [location.pathname, navigate, state]);

  if (state === "checking") {
    return (
      <div
        className="h-screen flex flex-col items-center justify-center gap-3"
        style={{ backgroundColor: "var(--geist-bg-100)" }}
      >
        <svg
          className="spinner"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </div>
    );
  }

  if (state === "unauthenticated") {
    return (
      <LoginPage
        onAuthenticated={() => {
          queryClient.clear();
          setState("authenticated");
        }}
      />
    );
  }

  return <Layout />;
}
