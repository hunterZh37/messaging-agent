/**
 * How many people the rail shows until the operator says otherwise (2026-09-29:
 * "we only want to display maybe 5 people at a time"). On its own so the
 * browser can read it without the database, the mail clients and the model SDK
 * coming along for the ride — the same reason the text helpers sit behind
 * `@messaging-agent/core/text`.
 */
export const SIDEBAR_PEOPLE = 5;

/**
 * What the number beside the heading can be set to (operator, 2026-09-29:
 * "we only want to display maybe 5 people at a time, that is what the number
 * is for"). The rail is a fixed column with folders above and the app's own
 * rows below, so this is a handful of sensible lengths rather than any number
 * at all.
 */
export const PEOPLE_CHOICES = [3, 5, 8, 12, 20] as const;

/** The most the rail will ever show, which is what the server sends. */
export const PEOPLE_MAX = 20;
