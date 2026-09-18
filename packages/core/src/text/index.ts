/**
 * The text helpers that touch nothing but strings, exported as
 * `@messaging-agent/core/text` so the browser can use them without the
 * database, the mail clients and the model SDK coming along for the ride.
 */
export * from "./quoted";
export * from "./html";
