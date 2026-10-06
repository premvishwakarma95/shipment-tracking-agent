// MDR requires phone numbers with a country code (e.g. +15551234567),
// confirmed 2026-10-06, defaulting to +1 when the caller doesn't give one.
// Spoken numbers reach us as whatever the extraction pass wrote ("555 123
// 4567", "(555) 123-4567", "+91 98765 43210"), so this normalizes to E.164
// deterministically instead of trusting the model's formatting.
export function normalizePhoneE164(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  let candidate: string | null;
  if (trimmed.startsWith("+")) {
    // Explicit country code — keep it, if the length is plausible (E.164
    // allows at most 15 digits).
    candidate = digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  } else if (digits.length === 10) {
    candidate = `+1${digits}`; // US/Canada default
  } else if (digits.length >= 11 && digits.length <= 15) {
    // 11-15 digits with no "+": assume the country code was spoken as part
    // of the number (e.g. "1 555 123 4567", "91 98765 43210").
    candidate = `+${digits}`;
  } else {
    candidate = null; // too short/long to be a real number — never guess
  }

  // +1 (US/Canada) numbers are always exactly 11 digits including the 1.
  // Anything else starting +1 is a malformed number — typically a number
  // that already carried its own country code (e.g. India's 91...) that
  // got a second "+1" stuck on the front. Confirmed 2026-10-06
  // (S6-CASE4-001: spoken "91 558 810 102" came back as "+191558810102").
  // Better null than a wrong number.
  if (candidate && candidate.startsWith("+1") && candidate.length !== 12) return null;

  return candidate;
}
