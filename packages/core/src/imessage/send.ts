import { execFile } from "node:child_process";
import type { Sender } from "../connectors/types";
import type { AppleScriptRunner, ImessageSource } from "./types";

/** Runs a script with osascript on this Mac. */
export const osascript: AppleScriptRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });

/** AppleScript's string literal: double quotes and backslashes escaped. */
export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Which Messages service a chat's guid or a text's service names: iMessage, or SMS for SMS and RCS. */
export function serviceFor(service: string): "iMessage" | "SMS" {
  return /^imessage$/i.test(service.trim()) ? "iMessage" : "SMS";
}

/**
 * The script that hands one text to Messages.app for a handle (operator,
 * 2026-09-11: replies go out through the same gate as mail, then Messages
 * sends them). The first run makes macOS ask, once, whether the app may
 * control Messages.
 */
/** A handle Messages can text: a phone number with an optional +, or an Apple ID (an email), with no whitespace or control characters in it. */
export function isHandle(h: string): boolean {
  if (/[\s\x00-\x1f"]/.test(h)) return false;
  if (/^\+?\d{3,15}$/.test(h)) return true;
  const at = h.indexOf("@");
  return at > 0 && at === h.lastIndexOf("@") && at < h.length - 1;
}

export function sendScript(handle: string, service: "iMessage" | "SMS", text: string): string {
  return [
    'tell application "Messages"',
    `  set theService to 1st account whose service type = ${service}`,
    `  set theBuddy to participant ${appleScriptString(handle)} of theService`,
    `  send ${appleScriptString(text)} to theBuddy`,
    "end tell",
  ].join("\n");
}

/**
 * The sender behind a text reply. `to[0]` is the handle; the service comes
 * from the chat's guid ("iMessage;-;+1…", "SMS;-;…"), or iMessage when the
 * guid does not say. After the send, chat.db is watched for a few seconds
 * for the text Messages wrote, so the draft can point at it the way a mail
 * draft points at its sent message; when it has not shown up yet, the
 * draft is filed under a local id and the next sync brings the real one.
 */
export function imessageSender(source: ImessageSource | null, run: AppleScriptRunner = osascript, clock: () => number = Date.now): Sender {
  return {
    async sendReply(p) {
      const handle = p.to[0];
      if (!handle) throw new Error("No one to text.");
      if (p.to.length > 1 || p.cc.length > 0) throw new Error("A text goes to one person.");
      if (!isHandle(handle)) throw new Error(`Not a number or an Apple ID: ${handle}`);
      const guidService = p.providerThreadId.split(";")[0] ?? "";
      const service = serviceFor(guidService === "any" || guidService === "" ? "iMessage" : guidService);
      const startedAt = clock();
      await run(sendScript(handle, service, p.body));
      if (source) {
        for (let i = 0; i < 10; i++) {
          const own = source.latestOwnText(p.providerThreadId, startedAt - 2000);
          if (own && (own.text ?? "").trim() === p.body.trim()) return { id: own.guid };
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      return { id: `local-${startedAt}` };
    },
  };
}
