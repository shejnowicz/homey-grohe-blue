const test = require('node:test');
const assert = require('node:assert/strict');

const { redact, safeError } = require('../lib/redact');

test('redact replaces sensitive values at every nested level', () => {
  const value = {
    request: {
      headers: {
        Authorization: 'Bearer access-secret',
        Cookie: 'session=cookie-secret',
      },
      credentials: {
        access_token: 'access-secret',
        refreshToken: 'refresh-secret',
        email: 'owner@example.com',
        password: 'password-secret',
      },
    },
    appliance: {
      serialNumber: 'serial-secret',
      appliance_id: 'appliance-secret',
      presharedkey: 'preshared-secret',
    },
  };

  assert.deepEqual(redact(value), {
    request: {
      headers: {
        Authorization: '[REDACTED]',
        Cookie: '[REDACTED]',
      },
      credentials: {
        access_token: '[REDACTED]',
        refreshToken: '[REDACTED]',
        email: '[REDACTED]',
        password: '[REDACTED]',
      },
    },
    appliance: {
      serialNumber: '[REDACTED]',
      appliance_id: '[REDACTED]',
      presharedkey: '[REDACTED]',
    },
  });
});

test('redact preserves ordinary measurements', () => {
  const value = {
    filterPercent: 74,
    co2Liters: 285,
    measurements: [{ temperature: 8.5, online: true }],
  };

  assert.deepEqual(redact(value), value);
});

test('safeError preserves only an error name, HTTP status, and generic message', () => {
  const error = new Error('Request failed for Bearer access-secret');
  error.name = 'GroheRequestError';
  error.status = 401;
  error.token = 'access-secret';
  error.appliance_id = 'appliance-secret';

  const safe = safeError(error);

  assert.equal(safe.name, 'GroheRequestError');
  assert.equal(safe.status, 401);
  assert.equal(safe.message, 'GROHE request failed');
  assert.equal(Object.hasOwn(safe, 'token'), false);
  assert.equal(Object.hasOwn(safe, 'appliance_id'), false);
  assert.equal(safe.message.includes('access-secret'), false);
});
