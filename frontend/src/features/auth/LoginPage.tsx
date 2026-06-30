import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, LockKeyhole, Languages } from "lucide-react";
import { authApi } from "@/lib/api";
import i18n, { LANG_KEY } from "@/lib/i18n";

interface LoginPageProps {
  onAuthenticated: () => void;
}

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await authApi.login(password);
      setPassword("");
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("login.loginFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      className="min-h-screen flex items-center justify-center px-5"
      style={{ backgroundColor: "var(--geist-bg-200)" }}
    >
      <div className="w-full max-w-[380px]">
        <div className="flex items-center justify-center gap-2.5 mb-7">
          <img
            src="/icon.png"
            alt="MailGo"
            className="h-10 w-10 rounded-geist object-contain"
          />
          <span className="text-heading-24">MailGo</span>
        </div>

        <form
          onSubmit={submit}
          className="rounded-geist border p-6 shadow-sm relative"
          style={{
            backgroundColor: "var(--geist-bg-100)",
            borderColor: "var(--geist-border)",
          }}
        >
          <button
            type="button"
            onClick={() => {
              const next = i18n.language === "zh-CN" ? "en" : "zh-CN";
              void i18n.changeLanguage(next);
              localStorage.setItem(LANG_KEY, next);
            }}
            className="absolute top-3 right-3 h-7 px-2 inline-flex items-center gap-1 rounded-geist text-label-12 text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--geist-bg-200)] transition-colors"
          >
            <Languages size={13} />
            {i18n.language === "zh-CN" ? "EN" : "中文"}
          </button>
          <div className="flex items-center gap-2 mb-1.5">
            <LockKeyhole size={17} />
            <h1 className="text-heading-18">{t("login.heading")}</h1>
          </div>
          <p className="text-copy-13 text-secondary mb-5">
            {t("login.description")}
          </p>

          <label className="block text-label-13 text-secondary mb-1.5" htmlFor="mailgo-password">
            {t("login.passwordLabel")}
          </label>
          <input
            id="mailgo-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="input w-full"
            aria-invalid={!!error}
          />

          {error && (
            <p className="text-label-12 mt-2" style={{ color: "var(--geist-red-500)" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!password || submitting}
            className="mt-5 h-10 w-full rounded-geist inline-flex items-center justify-center gap-2 text-label-14 font-medium transition-opacity disabled:opacity-50"
            style={{
              color: "white",
              backgroundColor: "var(--geist-primary)",
            }}
          >
            {submitting && <Loader2 size={15} className="animate-spin" />}
            {submitting ? t("login.loggingIn") : t("login.login")}
          </button>
        </form>
      </div>
    </main>
  );
}
