"use client";

import { useEffect, useState } from "react";

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

type State = "unsupported" | "install" | "off" | "on" | "blocked" | "working";

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Notifications on this phone (2026-09-14). An iPhone only offers them to
 * Celeste once it is on the home screen, so Safari gets a line saying that
 * instead of a switch that could never work.
 */
export function NotifyToggle() {
  const [state, setState] = useState<State>("unsupported");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState(ios && !standalone ? "install" : "unsupported");
      return;
    }
    if (Notification.permission === "denied") return setState("blocked");
    void navigator.serviceWorker
      .getRegistration("/")
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setState(sub ? "on" : "off"))
      .catch(() => setState("off"));
  }, []);

  async function turnOn() {
    setError(null);
    setState("working");
    try {
      const { key } = (await (await fetch("/api/push/key", { cache: "no-store" })).json()) as { key: string | null };
      if (!key) throw new Error("Notifications are not set up on the Mac yet.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setState(permission === "denied" ? "blocked" : "off");
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
      const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "The Mac did not take the subscription.");
      setState("on");
    } catch (err) {
      setError((err as Error).message);
      setState("off");
    }
  }

  async function turnOff() {
    setError(null);
    setState("working");
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
    setState("off");
  }

  if (state === "unsupported") return null;
  if (state === "install") {
    return (
      <p className="notify-hint">
        <BellIcon />
        <span>For notifications, tap Share, then Add to Home Screen.</span>
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className={state === "on" ? "on" : undefined}
        onClick={() => void (state === "on" ? turnOff() : turnOn())}
        disabled={state === "working" || state === "blocked"}
        aria-pressed={state === "on"}
        title={state === "blocked" ? "Notifications are blocked for Celeste in this device's settings" : undefined}
      >
        <BellIcon />
        <span className="tree-label">Notifications</span>
        <span className="tree-count">{state === "on" ? "On" : state === "blocked" ? "Blocked" : state === "working" ? "…" : "Off"}</span>
      </button>
      {error ? <p className="notify-hint error">{error}</p> : null}
    </>
  );
}
