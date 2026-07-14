const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_RE = /\b(?:mf_sk_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g;
const PHONE_RE = /(?<![\w+])(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g;

function redactCardLikeNumbers(value) {
  return value.replace(/\b\d(?:[ -]?\d){12,18}\b/g, match => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 ? '[redacted-number]' : match;
  });
}

export function redactSensitiveText(value) {
  if (typeof value !== 'string' || value === '') return value;
  return redactCardLikeNumbers(value)
    .replace(TOKEN_RE, '[redacted-token]')
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(PHONE_RE, match => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 8 ? '[redacted-phone]' : match;
    });
}

export function redactPayload(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(item => redactPayload(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactPayload(item)])
  );
}
