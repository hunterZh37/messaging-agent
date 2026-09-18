import type { MetadataRoute } from "next";

/**
 * Celeste as a home-screen app (2026-09-14): opened from its icon it fills the
 * screen with no browser around it, and lands where `/` decides: Need to
 * reply, Unopened, or the Inbox (2026-09-15).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Celeste",
    short_name: "Celeste",
    description: "Your mail, texts and WhatsApp, sorted, with replies drafted.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0d0e0b",
    theme_color: "#0d0e0b",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
