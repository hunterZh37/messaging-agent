import { ImageResponse } from "next/og";

/**
 * Celeste's home-screen icon (2026-09-14): the Celeste mark, the four-point
 * star every generated thing wears, in the night theme's signal lime on its
 * near-black ground. Drawn full bleed: iOS and Android round the corners.
 */
export function appIcon(size: number): ImageResponse {
  const star = Math.round(size * 0.56);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d0e0b" }}>
        <svg width={star} height={star} viewBox="0 0 24 24">
          <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" fill="#deff9a" />
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}
