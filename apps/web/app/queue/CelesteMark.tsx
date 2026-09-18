/**
 * Marks anything Celeste generated (a sort reason, a draft, a summary) so the
 * operator can always tell machine output from mail. Operator rule,
 * 2026-09-07: "for any AI generated content or summary or action, I want to
 * have a Celeste in front of it."
 */
export function CelesteMark({ suffix }: { suffix?: string }) {
  return (
    <span className="celeste">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
      </svg>
      Celeste{suffix ? ` ${suffix}` : ""}
    </span>
  );
}
