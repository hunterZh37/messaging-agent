import { appIcon } from "@/lib/appIcon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** What "Add to Home Screen" on an iPhone puts on the home screen (2026-09-14). */
export default function AppleIcon() {
  return appIcon(180);
}
