import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Mail,
  Server,
  Lock,
  CheckCircle2,
  Loader2,
  AlertCircle,
  ChevronRight,
  ChevronLeft,
  Download,
  Paperclip,
  Palette,
  CalendarDays,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { showToast } from "@/stores/toast.store";
import { useCreateAccount } from "@/hooks/mutations/useAccountMutations";
import {
  accountsApi,
  apiFetch,
  syncApi,
  type DetectResponse,
  type MicrosoftDeviceAuthorization,
  type ProbeResponse,
  type VerifyResponse,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";

type Step = "email" | "server" | "password" | "finish";

const STEP_ORDER: Step[] = ["email", "server", "password", "finish"];
const STEP_ICONS: Record<Step, typeof Mail> = {
  email: Mail,
  server: Server,
  password: Lock,
  finish: CheckCircle2,
};

interface WizardState {
  email: string;
  senderName: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapTLS: boolean;
  imapEncryption: string;
  smtpHost: string;
  smtpPort: number;
  smtpTLS: boolean;
  smtpEncryption: string;
  pullHistory: boolean;
  pullAttachments: boolean;
  tag_color: string;
  sync_days: string;
  sync_max_messages: string;
  avatar_url: string;
}

const INITIAL_STATE: WizardState = {
  email: "",
  senderName: "",
  username: "",
  password: "",
  imapHost: "",
  imapPort: 993,
  imapTLS: true,
  imapEncryption: "ssl",
  smtpHost: "",
  smtpPort: 587,
  smtpTLS: true,
  smtpEncryption: "starttls",
  pullHistory: true,
  pullAttachments: false,
  tag_color: "",
  sync_days: "0",
  sync_max_messages: "0",
  avatar_url: "",
};

function defaultName(email: string) {
  return email.split("@")[0] || email;
}

function configFromResult(result: DetectResponse) {
  return {
    imapHost: result.provider.imap_host,
    imapPort: result.provider.imap_port,
    imapTLS: result.provider.imap_tls,
    imapEncryption: result.provider.imap_encryption || (result.provider.imap_port === 993 ? "ssl" : "starttls"),
    smtpHost: result.provider.smtp_host,
    smtpPort: result.provider.smtp_port,
    smtpTLS: result.provider.smtp_tls,
    smtpEncryption: result.provider.smtp_encryption || (result.provider.smtp_port === 465 ? "ssl" : "starttls"),
  };
}

export function AddAccountWizard({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateAccount();
  const [step, setStep] = useState<Step>("email");
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const [detecting, setDetecting] = useState(false);
  const [detectPhase, setDetectPhase] = useState("");
  const [detectResult, setDetectResult] = useState<DetectResponse | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [probePhase, setProbePhase] = useState("");
  const [probeResult, setProbeResult] = useState<ProbeResponse | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [microsoftDevice, setMicrosoftDevice] =
    useState<MicrosoftDeviceAuthorization | null>(null);
  const [microsoftAuthorizing, setMicrosoftAuthorizing] = useState(false);
  const [microsoftAuthorized, setMicrosoftAuthorized] = useState(false);
  const [microsoftError, setMicrosoftError] = useState<string | null>(null);
  /** When false, skip auto-detection and go straight to manual server entry. */
  const [smartDetect, setSmartDetect] = useState(true);

  // Auto-fetch favicon when entering the finish step.
  useEffect(() => {
    if (step !== "finish" || !state.email) return;
    const domain = state.email.split("@")[1]?.toLowerCase();
    if (!domain || state.avatar_url) return; // already have one
    let cancelled = false;
    apiFetch(`/api/v1/avatars/fetch?domain=${encodeURIComponent(domain)}`)
      .then((r) => {
        if (!r.ok || cancelled) return;
        return r.json() as Promise<{ url: string }>;
      })
      .then((data) => {
        if (!cancelled && data?.url) {
          setState((s) => ({ ...s, avatar_url: data.url }));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepIndex = STEP_ORDER.indexOf(step);
  const emailDomain = state.email.split("@")[1]?.toLowerCase() || "";
  const isMicrosoft =
    detectResult?.auth_type === "microsoft_oauth" ||
    ["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(
      emailDomain,
    ) ||
    state.imapHost.toLowerCase() === "outlook.office365.com" ||
    state.smtpHost.toLowerCase() === "smtp-mail.outlook.com";
  const microsoftOAuthConfigured =
    detectResult?.oauth_configured ?? true;

  useEffect(() => {
    if (!microsoftDevice || microsoftAuthorized) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await accountsApi.pollMicrosoftDeviceAuth(
          microsoftDevice.flow_id,
        );
        if (cancelled) return;
        if (result.status === "authorized") {
          setMicrosoftAuthorized(true);
          setMicrosoftAuthorizing(false);
          setMicrosoftError(null);
          setStep("finish");
          return;
        }
        timer = setTimeout(
          poll,
          (result.interval || microsoftDevice.interval || 5) * 1000,
        );
      } catch (error) {
        if (cancelled) return;
        setMicrosoftAuthorizing(false);
        setMicrosoftError(
          error instanceof Error
            ? error.message
            : t("settings.wizard.microsoftAuthorizationFailed"),
        );
      }
    };
    timer = setTimeout(poll, (microsoftDevice.interval || 5) * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [microsoftAuthorized, microsoftDevice, t]);

  const reset = () => {
    setStep("email");
    setState(INITIAL_STATE);
    setDetecting(false);
    setDetectPhase("");
    setDetectResult(null);
    setDetectError(null);
    setProbing(false);
    setProbePhase("");
    setProbeResult(null);
    setVerifying(false);
    setVerifyResult(null);
    setVerifyError(null);
    setMicrosoftDevice(null);
    setMicrosoftAuthorizing(false);
    setMicrosoftAuthorized(false);
    setMicrosoftError(null);
    setSmartDetect(true);
  };

  const close = () => {
    reset();
    onClose();
  };

  const patch = (p: Partial<WizardState>) => setState((s) => ({ ...s, ...p }));

  const detectAndRoute = async () => {
    const email = state.email.trim();
    if (!email || !email.includes("@")) {
      showToast(t("settings.wizard.emailHint"), "warning");
      return;
    }

    const username = state.username.trim() || email;
    patch({ email, username, senderName: state.senderName || defaultName(email) });

    // If smart detection is off, go straight to manual server entry.
    if (!smartDetect) {
      setDetectError(null);
      setDetectResult(null);
      setStep("server");
      return;
    }

    setDetecting(true);
    setDetectError(null);
    setDetectResult(null);
    setProbeResult(null);

    // Cycle through status messages so the user sees what's happening
    // instead of a static "detecting…" label.
    const phases = [
      t("settings.probeQueryDomain"),
      t("settings.probeQueryMX"),
      t("settings.probeAutoconfig"),
      t("settings.probeConnectivity"),
    ];
    let phaseIdx = 0;
    setDetectPhase(phases[0]);
    const phaseTimer = setInterval(() => {
      phaseIdx = Math.min(phaseIdx + 1, phases.length - 1);
      setDetectPhase(phases[phaseIdx]);
    }, 1500);

    try {
      const res = await accountsApi.detect(email);
      clearInterval(phaseTimer);
      setDetectResult(res);
      patch(configFromResult(res));
      if (res.found && res.imap_ok && res.smtp_ok) {
        showToast(
          t("settings.wizard.detectSuccess", { method: res.method }),
          "success",
        );
        setStep("password");
      } else {
        setDetectError(
          res.error_message ||
            t("settings.wizard.detectFailed"),
        );
        setStep("server");
      }
    } catch (err) {
      clearInterval(phaseTimer);
      setDetectError(err instanceof Error ? err.message : t("settings.wizard.detectFailed"));
      setStep("server");
    } finally {
      clearInterval(phaseTimer);
      setDetecting(false);
      setDetectPhase("");
    }
  };

  const probeManualConfig = async () => {
    if (!state.imapHost || !state.smtpHost) {
      showToast(t("settings.wizard.detectFailed"), "warning");
      return;
    }
    setProbing(true);
    setProbePhase(t("settings.verifyIMAP"));
    setProbeResult(null);

    // Cycle probe status messages.
    const phases = [
      t("settings.verifyIMAP"),
      t("settings.verifySMTP"),
      t("settings.verifyTLS"),
    ];
    let phaseIdx = 0;
    const phaseTimer = setInterval(() => {
      phaseIdx = Math.min(phaseIdx + 1, phases.length - 1);
      setProbePhase(phases[phaseIdx]);
    }, 1500);

    try {
      const res = await accountsApi.probe({
        imap_host: state.imapHost,
        imap_port: state.imapPort || 993,
        imap_tls: state.imapTLS,
        imap_encryption: state.imapEncryption,
        smtp_host: state.smtpHost,
        smtp_port: state.smtpPort || 587,
        smtp_tls: state.smtpTLS,
        smtp_encryption: state.smtpEncryption,
      });
      clearInterval(phaseTimer);
      setProbeResult(res);
      if (res.ok) {
        setStep("password");
      } else {
        showToast(
          res.error_message || t("settings.wizard.detectFailed"),
          "error",
        );
      }
    } catch (err) {
      clearInterval(phaseTimer);
      showToast(err instanceof Error ? err.message : t("settings.wizard.detectFailed"), "error");
    } finally {
      clearInterval(phaseTimer);
      setProbing(false);
      setProbePhase("");
    }
  };

  const verifyCredentials = async () => {
    if (!state.password) {
      showToast(t("settings.wizard.passwordHint"), "warning");
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const res = await accountsApi.verify({
        imap_host: state.imapHost,
        imap_port: state.imapPort,
        imap_tls: state.imapTLS,
        imap_encryption: state.imapEncryption,
        smtp_host: state.smtpHost,
        smtp_port: state.smtpPort,
        smtp_tls: state.smtpTLS,
        smtp_encryption: state.smtpEncryption,
        username: state.username,
        password: state.password,
      });
      setVerifyResult(res);
      if (res.ok) {
        setTimeout(() => setStep("finish"), 500);
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Verify failed");
    } finally {
      setVerifying(false);
    }
  };

  const startMicrosoftAuthorization = async () => {
    if (!microsoftOAuthConfigured) {
      setMicrosoftError(
        t("settings.wizard.microsoftNotConfigured"),
      );
      return;
    }
    setMicrosoftAuthorizing(true);
    setMicrosoftError(null);
    try {
      const result = await accountsApi.startMicrosoftDeviceAuth(state.email);
      setMicrosoftDevice(result);
      window.open(result.verification_uri, "_blank", "noopener,noreferrer");
    } catch (error) {
      setMicrosoftAuthorizing(false);
      setMicrosoftError(
        error instanceof Error
          ? error.message
          : t("settings.wizard.microsoftAuthorizationFailed"),
      );
    }
  };

  const createAccount = async () => {
    try {
      const created = await create.mutateAsync({
        name: state.senderName.trim() || defaultName(state.email),
        email: state.email,
        provider: isMicrosoft ? "microsoft" : detectResult?.method || "imap",
        imap_host: state.imapHost,
        imap_port: state.imapPort,
        imap_tls: state.imapTLS,
        imap_encryption: state.imapEncryption,
        smtp_host: state.smtpHost,
        smtp_port: state.smtpPort,
        smtp_tls: state.smtpTLS,
        smtp_encryption: state.smtpEncryption,
        username: state.username,
        password: state.password,
        oauth_flow_id: microsoftDevice?.flow_id,
        tag_color: state.tag_color,
        avatar_url: state.avatar_url,
        sync_days: parseInt(state.sync_days, 10) || 0,
        sync_max_messages: parseInt(state.sync_max_messages, 10) || 0,
      });

      // Close the wizard immediately — the history pull runs in the
      // background on the server and would otherwise keep the modal open
      // for a long time (real IMAP sync can take minutes on first run).
      if (state.pullHistory) {
        showToast(
          t("settings.wizard.syncQueued"),
          "success",
        );
      } else {
        showToast(t("settings.wizard.accountCreated"), "success");
      }
      close();

      // Fire the sync without awaiting so the modal is already gone.
      if (state.pullHistory) {
        syncApi
          .trigger(created.id, {
            include_history: true,
            include_attachments: state.pullAttachments,
          })
          .catch(() => null);
      }
    } catch {
      /* toast shown by mutation */
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("settings.wizard.title")}
      size="md"
      hideClose
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="text-label-12 text-secondary">
            {t("common.step", "Step")} {stepIndex + 1} / {STEP_ORDER.length}
          </div>
          <div className="flex items-center gap-2">
            {step !== "email" && (
              <Button
                variant="secondary"
                size="small"
                leadingIcon={<ChevronLeft size={14} />}
                onClick={() => setStep(STEP_ORDER[stepIndex - 1])}
                disabled={probing || verifying || create.isPending}
              >
                {t("common.previous", "Back")}
              </Button>
            )}
            {step === "email" && (
              <Button
                size="small"
                loading={detecting}
                trailingIcon={<ChevronRight size={14} />}
                onClick={detectAndRoute}
              >
                {detecting ? t("settings.wizard.detecting") : t("common.next", "Next")}
              </Button>
            )}
            {step === "server" && (
              <Button
                size="small"
                loading={probing}
                trailingIcon={<ChevronRight size={14} />}
                onClick={probeManualConfig}
              >
                {probing
                  ? t("settings.wizard.detecting")
                  : t("common.next", "Next")}
              </Button>
            )}
            {step === "password" && (
              isMicrosoft ? (
                <Button
                  size="small"
                  loading={microsoftAuthorizing}
                  onClick={startMicrosoftAuthorization}
                  disabled={
                    !microsoftOAuthConfigured ||
                    microsoftAuthorizing ||
                    microsoftAuthorized
                  }
                >
                  {microsoftDevice
                    ? t("settings.wizard.waitingMicrosoft")
                    : t("settings.wizard.authorizeMicrosoft")}
                </Button>
              ) : (
                <Button
                  size="small"
                  loading={verifying}
                  onClick={verifyCredentials}
                  disabled={!state.password}
                >
                  {verifying
                    ? t("settings.wizard.verifying")
                    : t("common.verify", "Verify")}
                </Button>
              )
            )}
            {step === "finish" && (
              <Button size="small" loading={create.isPending} onClick={createAccount}>
                {create.isPending
                  ? t("settings.wizard.creating")
                  : t("common.finish", "Finish")}
              </Button>
            )}
            <Button variant="secondary" size="small" onClick={close}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex items-center justify-center gap-2 mb-6">
        {STEP_ORDER.map((s, i) => {
          const Icon = STEP_ICONS[s];
          const isCurrent = s === step;
          const isDone = i < stepIndex;
          return (
            <div key={s} className="flex items-center">
              <div
                className={cn(
                  "h-8 w-8 rounded-full flex items-center justify-center transition-colors",
                  (isCurrent || isDone) && "text-white",
                  !isCurrent && !isDone && "text-secondary",
                )}
                style={{
                  backgroundColor: isCurrent
                    ? "var(--geist-primary)"
                    : isDone
                    ? "var(--geist-green-500)"
                    : "var(--geist-gray-200)",
                }}
              >
                {isDone ? <CheckCircle2 size={16} /> : <Icon size={15} />}
              </div>
              {i < STEP_ORDER.length - 1 && (
                <div
                  className="w-8 h-0.5"
                  style={{
                    backgroundColor:
                      i < stepIndex
                        ? "var(--geist-green-500)"
                        : "var(--geist-gray-200)",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {step === "email" && (
        <div className="space-y-4">
          <p className="text-copy-13 text-secondary">
            {t(
              "settings.wizard.emailHint",
              "Enter your email address. MailGo will detect MX records and try common IMAP/SMTP settings.",
            )}
          </p>
          <Input
            label={t("settings.accountEmail")}
            type="email"
            value={state.email}
            autoFocus
            placeholder="you@example.com"
            onChange={(e) => {
              const email = e.target.value.trim();
              patch({
                email,
                username:
                  !state.username || state.username === state.email
                    ? email
                    : state.username,
              });
              setDetectResult(null);
              setDetectError(null);
            }}
          />
          <Input
            label={t("settings.username")}
            value={state.username}
            placeholder={state.email || "you@example.com"}
            onChange={(e) => patch({ username: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void detectAndRoute();
              }
            }}
            hint={t("settings.wizard.usernameHint", "Usually your full email address.")}
          />
          <div
            className="flex items-center justify-between gap-3 rounded-geist border px-3 py-2.5"
            style={{ borderColor: "var(--geist-border)" }}
          >
            <div>
              <p className="text-label-13 font-medium">{t("settings.smartDetect")}</p>
              <p className="text-copy-12 text-secondary mt-0.5">
                {t("settings.smartDetectDesc")}
              </p>
            </div>
            <Switch checked={smartDetect} onChange={setSmartDetect} />
          </div>
          {detecting && (
            <StatusLine icon={<Loader2 size={14} className="spinner" />}>
              {detectPhase || t("settings.wizard.detecting")}
            </StatusLine>
          )}
        </div>
      )}

      {step === "server" && (
        <div className="space-y-4">
          {/* Only show the error callout when detection actually failed.
              When the user navigates back from the password step after a
              successful detection, there's no error to show. */}
          {detectError && (
            <Callout tone="warning">
              {detectError}
            </Callout>
          )}
          {!detectError && !smartDetect && (
            <Callout tone="warning">
              {t("settings.smartDetectOff")}
            </Callout>
          )}
          {detectResult && (
            <div className="rounded-geist border p-3 text-label-12 text-secondary" style={{ borderColor: "var(--geist-border)" }}>
              <div>
                <span className="font-medium">MX:</span>{" "}
                {detectResult.mx_records.length ? detectResult.mx_records.join(", ") : "-"}
              </div>
              <div className="mt-1">
                <span className="font-medium">Default:</span>{" "}
                {state.imapHost}:{state.imapPort} / {state.smtpHost}:{state.smtpPort}
              </div>
            </div>
          )}
          <p className="text-label-13 font-medium">
            {t("settings.wizard.manualServerSettings")}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t("settings.imapHost")}
              value={state.imapHost}
              onChange={(e) => patch({ imapHost: e.target.value })}
            />
            <Input
              label={t("settings.imapPort")}
              type="number"
              value={String(state.imapPort)}
              onChange={(e) => patch({ imapPort: Number(e.target.value) })}
            />
            <Input
              label={t("settings.smtpHost")}
              value={state.smtpHost}
              onChange={(e) => patch({ smtpHost: e.target.value })}
            />
            <Input
              label={t("settings.smtpPort")}
              type="number"
              value={String(state.smtpPort)}
              onChange={(e) => patch({ smtpPort: Number(e.target.value) })}
            />
          </div>
          {/* IMAP encryption selector */}
          <div>
            <label className="text-label-13 font-medium text-secondary block mb-1.5">
              IMAP {t("settings.encryptionMethod")}
            </label>
            <EncryptionSelector
              value={state.imapEncryption}
              onChange={(enc) => patch({
                imapEncryption: enc,
                imapTLS: enc !== "none",
                imapPort: enc === "ssl" ? 993 : enc === "none" ? 143 : 143,
              })}
            />
          </div>
          {/* SMTP encryption selector */}
          <div>
            <label className="text-label-13 font-medium text-secondary block mb-1.5">
              SMTP {t("settings.encryptionMethod")}
            </label>
            <EncryptionSelector
              value={state.smtpEncryption}
              onChange={(enc) => patch({
                smtpEncryption: enc,
                smtpTLS: enc !== "none",
                smtpPort: enc === "ssl" ? 465 : enc === "none" ? 25 : 587,
              })}
            />
          </div>
          {probing && (
            <StatusLine icon={<Loader2 size={14} className="spinner" />}>
              {probePhase || t("settings.wizard.detecting")}
            </StatusLine>
          )}
          {probeResult && !probeResult.ok && (
            <Callout tone="error">
              {probeResult.error_message || t("settings.wizard.detectFailed")}
            </Callout>
          )}
        </div>
      )}

      {step === "password" && (
        <div className="space-y-4">
          <Callout tone="success">
            {t("settings.wizard.detectSuccess", { method: detectResult?.method || "server probe" })}
          </Callout>
          <div className="grid grid-cols-2 gap-3 text-label-13">
            <ServerBox label="IMAP" host={state.imapHost} port={state.imapPort} encryption={state.imapEncryption} />
            <ServerBox label="SMTP" host={state.smtpHost} port={state.smtpPort} encryption={state.smtpEncryption} />
          </div>
          {isMicrosoft ? (
            <div className="space-y-3">
              {!microsoftOAuthConfigured ? (
                <Callout tone="error">
                  {t("settings.wizard.microsoftNotConfigured")}
                </Callout>
              ) : microsoftDevice ? (
                <>
                  <div
                    className="rounded-geist border p-4 text-center"
                    style={{ borderColor: "var(--geist-border)" }}
                  >
                    <p className="text-label-12 text-secondary">
                      {t("settings.wizard.microsoftCodeHint")}
                    </p>
                    <p className="text-heading-24 tracking-widest my-3">
                      {microsoftDevice.user_code}
                    </p>
                    <a
                      href={microsoftDevice.verification_uri}
                      target="_blank"
                      rel="noreferrer"
                      className="text-label-13 underline"
                    >
                      {microsoftDevice.verification_uri}
                    </a>
                  </div>
                  <StatusLine icon={<Loader2 size={14} className="spinner" />}>
                    {t("settings.wizard.waitingMicrosoft")}
                  </StatusLine>
                </>
              ) : (
                <Callout tone="warning">
                  {t("settings.wizard.microsoftOAuthHint")}
                </Callout>
              )}
              {microsoftError && <Callout tone="error">{microsoftError}</Callout>}
            </div>
          ) : (
            <Input
              label={t("settings.password")}
              type="password"
              value={state.password}
              autoFocus
              onChange={(e) => {
                patch({ password: e.target.value });
                setVerifyResult(null);
                setVerifyError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && state.password) {
                  void verifyCredentials();
                }
              }}
              hint={t("settings.wizard.passwordHint")}
            />
          )}
          {verifying && (
            <StatusLine icon={<Loader2 size={14} className="spinner" />}>
              {t("settings.wizard.verifying")}
            </StatusLine>
          )}
          {verifyResult?.ok && (
            <Callout tone="success">{t("settings.wizard.verifySuccess")}</Callout>
          )}
          {verifyResult && !verifyResult.ok && (
            <Callout tone="error">
              {t("settings.wizard.verifyFailed", {
                error: verifyResult.error_message || "",
              })}
            </Callout>
          )}
          {verifyError && <Callout tone="error">{verifyError}</Callout>}
        </div>
      )}

      {step === "finish" && (
        <div className="space-y-5">
          <Callout tone="success">{t("settings.wizard.verifySuccess")}</Callout>
          <Input
            label={t("settings.wizard.senderName")}
            value={state.senderName}
            autoFocus
            placeholder={defaultName(state.email)}
            onChange={(e) => patch({ senderName: e.target.value })}
            hint={t("settings.wizard.senderNameHint")}
          />
          <div className="rounded-geist border p-4 space-y-4" style={{ borderColor: "var(--geist-border)" }}>
            <ToggleRow
              icon={<Download size={16} />}
              title={t("settings.wizard.pullHistory")}
              description={t("settings.wizard.pullHistoryHint")}
              checked={state.pullHistory}
              onChange={(v) => patch({ pullHistory: v })}
            />
            {state.pullHistory && (
              <>
                <div className="divider" />
                <ToggleRow
                  icon={<Paperclip size={16} />}
                  title={t("settings.wizard.pullAttachments")}
                  description={t("settings.wizard.pullAttachmentsHint")}
                  checked={state.pullAttachments}
                  onChange={(v) => patch({ pullAttachments: v })}
                />
              </>
            )}
          </div>
          {/* Avatar + Tag color picker */}
          <div className="rounded-geist border p-4 space-y-3" style={{ borderColor: "var(--geist-border)" }}>
            <div className="flex items-start gap-2.5">
              <Palette size={16} className="mt-0.5 shrink-0" style={{ color: "var(--geist-secondary)" }} />
              <div className="flex-1">
                <p className="text-label-14 font-medium">{t("settings.avatarAndColor")}</p>
                <p className="text-copy-13 text-secondary mt-0.5">
                  {t("settings.avatarAndColorDesc")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 pl-6">
              <Avatar
                src={state.avatar_url || undefined}
                name={state.senderName || defaultName(state.email)}
                email={state.email}
                tagColor={state.tag_color || undefined}
                size={48}
              />
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const domain = state.email.split("@")[1]?.toLowerCase();
                      if (!domain) return;
                      apiFetch(`/api/v1/avatars/fetch?domain=${encodeURIComponent(domain)}`)
                        .then((r) => {
                          if (!r.ok) return null;
                          return r.json() as Promise<{ url: string }>;
                        })
                        .then((data) => {
                          if (data?.url) {
                            setState((s) => ({ ...s, avatar_url: data.url }));
                          }
                        })
                        .catch(() => {});
                    }}
                    className="text-label-12 text-secondary hover:text-[var(--geist-primary)] transition-colors"
                  >
                    {t("settings.fetchAvatar")}
                  </button>
                  <label className="text-label-12 text-secondary hover:text-[var(--geist-primary)] transition-colors cursor-pointer">
                    {t("settings.uploadAvatar")}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          if (reader.result) {
                            setState((s) => ({ ...s, avatar_url: reader.result as string }));
                          }
                        };
                        reader.readAsDataURL(file);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                  {state.avatar_url && (
                    <button
                      type="button"
                      onClick={() => setState((s) => ({ ...s, avatar_url: "" }))}
                      className="text-label-12 text-secondary hover:text-[var(--geist-red-500)] transition-colors"
                    >
                      {t("settings.deleteImage")}
                    </button>
                  )}
                </div>
                <p className="text-label-11 text-secondary">
                  {state.avatar_url
                    ? state.avatar_url.startsWith("data:")
                      ? t("settings.uploadedCustomAvatar")
                      : t("settings.fetchedDomainIcon")
                    : t("settings.noIconUseInitial")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap pl-6 pt-1">
              {["#006bff", "#a000f8", "#28a948", "#f22782", "#ffae00", "#00ac96", "#e00", "#666"].map(
                (c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      setState((s) => ({ ...s, tag_color: s.tag_color === c ? "" : c }))
                    }
                    className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor:
                        state.tag_color === c
                          ? "var(--geist-primary)"
                          : "transparent",
                    }}
                  />
                ),
              )}
              {state.tag_color && (
                <button
                  type="button"
                  onClick={() => setState((s) => ({ ...s, tag_color: "" }))}
                  className="text-label-12 text-secondary hover:text-[var(--geist-red-500)] ml-1"
                >
                  {t("settings.clearColor")}
                </button>
              )}
            </div>
          </div>
          {/* Sync time range */}
          <div className="rounded-geist border p-4" style={{ borderColor: "var(--geist-border)" }}>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-start gap-2.5">
                  <CalendarDays size={16} className="mt-0.5 shrink-0" style={{ color: "var(--geist-secondary)" }} />
                  <div>
                    <p className="text-label-14 font-medium">{t("settings.syncPeriodDays")}</p>
                    <p className="text-copy-13 text-secondary mt-0.5">
                      {t("settings.syncPeriodDaysDesc")}
                    </p>
                  </div>
                </div>
                <div className="inline-flex items-center gap-1.5">
                  <Input
                    className="w-[88px]"
                    inputSize="small"
                    type="number"
                    min={0}
                    value={state.sync_days}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || Number(v) < 0) return;
                      patch({ sync_days: v });
                    }}
                  />
                  <span className="text-label-12 text-secondary">{t("settings.days")}</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-label-14 font-medium">{t("settings.syncMaxMessages")}</p>
                  <p className="text-copy-13 text-secondary mt-0.5">
                    {t("settings.syncMaxMessagesHint")}
                  </p>
                </div>
                <Input
                  className="w-[100px]"
                  inputSize="small"
                  type="number"
                  min={0}
                  value={state.sync_max_messages}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "" || Number(v) < 0) return;
                    patch({ sync_max_messages: v });
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function StatusLine({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-label-13 text-secondary">
      {icon}
      {children}
    </div>
  );
}

function Callout({ tone, children }: { tone: "success" | "warning" | "error"; children: React.ReactNode }) {
  const colors = {
    success: ["var(--geist-green-500)", "var(--geist-green-100)"],
    warning: ["#b45309", "#fffbeb"],
    error: ["var(--geist-red-500)", "var(--geist-red-100)"],
  }[tone];
  const Icon = tone === "success" ? CheckCircle2 : AlertCircle;
  return (
    <div
      className="flex items-center gap-2 rounded-geist border p-3 text-label-13"
      style={{ borderColor: colors[0], backgroundColor: colors[1], color: colors[0] }}
    >
      <Icon size={14} />
      <span>{children}</span>
    </div>
  );
}

function ServerBox({ label, host, port, encryption }: { label: string; host: string; port: number; encryption?: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-geist border p-3" style={{ borderColor: "var(--geist-border)" }}>
      <span className="text-label-12 text-secondary">{label}</span>
      <p className="text-label-13 font-medium truncate">
        {host}:{port}
      </p>
      {encryption && (
        <span className="text-label-11 text-secondary">
          {encryption === "ssl" ? "SSL/TLS" : encryption === "starttls" ? "STARTTLS" : encryption === "none" ? t("settings.noEncryption") : encryption}
        </span>
      )}
    </div>
  );
}

/**
 * EncryptionSelector renders three buttons for SSL/TLS, STARTTLS, and None.
 * Selecting one updates the wizard's encryption mode (and the legacy boolean).
 */
function EncryptionSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (enc: string) => void;
}) {
  const { t } = useTranslation();
  const options = [
    { value: "ssl", label: "SSL/TLS", hint: t("settings.implicitTLS") },
    { value: "starttls", label: "STARTTLS", hint: t("settings.upgradeConnection") },
    { value: "none", label: t("settings.noEncryption"), hint: t("settings.notRecommended") },
  ];
  return (
    <div className="flex gap-1.5">
      {options.map((opt) => {
        const active = (value || "starttls") === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 h-9 rounded-geist border text-label-12 transition-colors",
              active
                ? "border-[var(--geist-primary)] font-semibold"
                : "border-[var(--geist-border)] text-secondary hover:text-[var(--geist-primary)]",
            )}
            style={
              active
                ? {
                    backgroundColor: "color-mix(in srgb, var(--geist-primary) 10%, transparent)",
                    color: "var(--geist-primary)",
                  }
                : undefined
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-[var(--geist-tertiary)]">{icon}</span>
        <div>
          <p className="text-label-14 font-medium">{title}</p>
          <p className="text-copy-13 text-secondary mt-0.5">{description}</p>
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}
