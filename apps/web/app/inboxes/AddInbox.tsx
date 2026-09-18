"use client";

import { CloseButton } from "../CloseButton";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ImapSettings } from "@messaging-agent/core";
import { connectImapAction, detectAction } from "./actions";

const APP_PASSWORDS_URL = "https://myaccount.google.com/apppasswords";

function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}



type Step = "address" | "gmail" | "outlook" | "generic";

export interface AddInboxProps {
  microsoftReady: boolean;
  /** GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set: Gmail can sign in with Google (2026-09-11). */
  googleReady?: boolean;
  /** Opens straight into the form, skipping the trigger button. Used by the empty-queue onboarding. */
  defaultOpen?: boolean;
  triggerLabel?: string;
  /** Reconnect: the address is known, so it opens at the password step. */
  initial?: { address: string; step: Exclude<Step, "address">; settings?: ImapSettings };
}

function defaultSmtpHost(address: string): string {
  const domain = address.split("@")[1] ?? "";
  return domain ? `smtp.${domain}` : "";
}

/**
 * The one "Add inbox" entry point. The operator types an address; the app
 * works out how that mailbox connects and asks only for what it cannot know:
 * an app password, a Microsoft sign-in, or an IMAP host.
 */
export function AddInbox({ microsoftReady, googleReady = false, defaultOpen = false, triggerLabel = "Add inbox", initial }: AddInboxProps) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [step, setStep] = useState<Step>(initial?.step ?? "address");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState(initial?.settings?.imapHost ?? "");
  const [imapPort, setImapPort] = useState(String(initial?.settings?.imapPort ?? 993));
  const [smtpHost, setSmtpHost] = useState(initial?.settings?.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(String(initial?.settings?.smtpPort ?? 465));
  const [gmailSettings, setGmailSettings] = useState<ImapSettings | null>(initial?.step === "gmail" ? initial.settings ?? null : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function onContinue() {
    setError(null);
    setBusy(true);
    const r = await detectAction(address);
    setBusy(false);
    if ("error" in r) {
      setError(r.error);
      return;
    }
    if (r.provider === "gmail") {
      setGmailSettings(r.settings ?? null);
      setStep("gmail");
      return;
    }
    if (r.provider === "outlook") {
      setStep("outlook");
      return;
    }
    setImapHost((h) => h || `imap.${address.split("@")[1] ?? ""}`);
    setSmtpHost((h) => h || defaultSmtpHost(address));
    setStep("generic");
  }

  async function onConnect(settings: ImapSettings) {
    setError(null);
    setBusy(true);
    const r = await connectImapAction({ email: address, settings, password });
    if ("error" in r) {
      setBusy(false);
      setError(r.error);
      return;
    }
    setPassword("");
    router.push(`/connecting/${r.accountId}`);
  }

  function reset() {
    setOpen(false);
    setError(null);
    setPassword("");
    setStep(initial?.step ?? "address");
  }

  if (!open) {
    return (
      <div className="row">
        <button type="button" className="btn primary" onClick={() => setOpen(true)}>
          {triggerLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="card add-inbox" style={{ marginTop: 16 }}>
      <CloseButton onClick={reset} label="Close" />
      {step === "address" ? (
        <>
          <label htmlFor="inbox-address">Email address</label>
          <input
            id="inbox-address"
            className="field"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={address}
            disabled={busy}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && address.trim()) void onContinue();
            }}
          />
          {error ? <div className="error">{error}</div> : null}
          <div className="row">
            <button type="button" className="btn primary" onClick={() => void onContinue()} disabled={busy || !address.trim()}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </div>
          <div style={{ marginTop: 20 }}>
          </div>
        </>
      ) : null}

      {step === "gmail" ? (
        <>
          <div className="meta">
            <MailGlyph />
            <b style={{ color: "var(--fg)" }}>{address}</b>
          </div>
          {/* Sign in with Google (2026-09-11): for an account that cannot
              make an app password, a school's for one. The password stays
              as the other door. */}
          {googleReady ? (
            <>
              <p style={{ fontSize: 14, marginTop: 12 }}>Sign in with Google, or paste an app password below.</p>
              <div className="row">
                <a className="btn primary" href="/api/oauth/google/start">
                  Sign in with Google
                </a>
              </div>
            </>
          ) : null}
          <p style={{ fontSize: 14, marginTop: 12 }}>
            {googleReady ? "An app password works too. " : "Gmail and Google Workspace connect with an app password. "}
            <a href={APP_PASSWORDS_URL} target="_blank" rel="noreferrer">
              Create one here
            </a>
            , then paste it below.
          </p>
          <label htmlFor="inbox-password">App password</label>
          <input
            id="inbox-password"
            className="field"
            type="password"
            autoComplete="off"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <div className="error">{error}</div> : null}
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !password.trim() || !gmailSettings}
              onClick={() => gmailSettings && void onConnect(gmailSettings)}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </>
      ) : null}

      {step === "outlook" ? (
        <>
          <div className="meta">
            <MailGlyph />
            <b style={{ color: "var(--fg)" }}>{address}</b>
          </div>
          <p style={{ fontSize: 14, marginTop: 12 }}>
            Outlook.com signs in with Microsoft. Microsoft no longer allows a password over IMAP.
          </p>
          {microsoftReady ? null : <div className="error">MICROSOFT_CLIENT_ID is not set in .env.</div>}
          <div className="row">
            <a className="btn primary" href="/api/oauth/microsoft/start" aria-disabled={!microsoftReady}>
              Continue with Microsoft
            </a>
          </div>
        </>
      ) : null}

      {step === "generic" ? (
        <>
          <div className="meta">
            <MailGlyph />
            <b style={{ color: "var(--fg)" }}>{address}</b>
          </div>
          <label htmlFor="imap-host">IMAP host</label>
          <input id="imap-host" className="field" value={imapHost} disabled={busy} onChange={(e) => setImapHost(e.target.value)} />
          <label htmlFor="imap-port">IMAP port</label>
          <input id="imap-port" className="field" inputMode="numeric" value={imapPort} disabled={busy} onChange={(e) => setImapPort(e.target.value)} />
          <label htmlFor="smtp-host">SMTP host</label>
          <input id="smtp-host" className="field" value={smtpHost} disabled={busy} onChange={(e) => setSmtpHost(e.target.value)} />
          <label htmlFor="smtp-port">SMTP port</label>
          <input id="smtp-port" className="field" inputMode="numeric" value={smtpPort} disabled={busy} onChange={(e) => setSmtpPort(e.target.value)} />
          <label htmlFor="generic-password">Password</label>
          <input
            id="generic-password"
            className="field"
            type="password"
            autoComplete="off"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <div className="error">{error}</div> : null}
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !password.trim() || !imapHost.trim() || !smtpHost.trim()}
              onClick={() =>
                void onConnect({
                  imapHost: imapHost.trim(),
                  imapPort: Number(imapPort),
                  smtpHost: smtpHost.trim(),
                  smtpPort: Number(smtpPort),
                  kind: "generic",
                })
              }
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
