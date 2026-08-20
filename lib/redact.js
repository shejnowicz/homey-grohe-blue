const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_FRAGMENTS = [
  'authorization',
  'cookie',
  'token',
  'email',
  'password',
  'serial',
  'appliance_id',
  'applianceid',
  'presharedkey',
];

function isSensitiveKey(key) {
  const normalizedKey = String(key).toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
}

function redact(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  if (Array.isArray(value)) {
    const redactedArray = [];
    seen.set(value, redactedArray);
    for (const item of value) {
      redactedArray.push(redact(item, seen));
    }
    return redactedArray;
  }

  const redactedObject = {};
  seen.set(value, redactedObject);
  for (const [key, nestedValue] of Object.entries(value)) {
    redactedObject[key] = isSensitiveKey(key) ? REDACTED : redact(nestedValue, seen);
  }
  return redactedObject;
}

function safeError(error) {
  const safe = new Error('GROHE request failed');

  if (error && typeof error.name === 'string' && error.name) {
    safe.name = error.name;
  }

  if (error && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
    safe.status = error.status;
  }

  return safe;
}

module.exports = { redact, safeError };
