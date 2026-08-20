const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GroheClient } = require('../lib/grohe-client');

const API_BASE = 'https://idp2-apigw.cloud.grohe.com/v3/iot';
const LOGIN_URL = `${API_BASE}/oidc/login`;
const REFRESH_URL = `${API_BASE}/oidc/refresh`;
const DASHBOARD_URL = `${API_BASE}/dashboard`;
const IDP_BASE = 'https://identity.fixture.invalid';
const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'fixtures/login.html'), 'utf8');
const DASHBOARD = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/dashboard.json'), 'utf8'),
);

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function createFetch(sequence) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const response = sequence.shift();
    assert.ok(response, `Unexpected request to ${url}`);
    return typeof response === 'function' ? response(String(url), options) : response;
  };
  return { fetch, calls };
}

function loginResponses() {
  return [
    new Response(null, {
      status: 302,
      headers: {
        location: `${IDP_BASE}/authorize`,
        'set-cookie': 'oidc_state=state-fixture; Path=/; HttpOnly',
      },
    }),
    new Response(LOGIN_HTML, {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'set-cookie': 'idp_session=session-fixture; Path=/; Secure; HttpOnly',
      },
    }),
    new Response(null, {
      status: 302,
      headers: {
        location: 'ondus://idp2-apigw.cloud.grohe.com/v3/iot/oidc/token?code=synthetic-code',
      },
    }),
    jsonResponse({
      access_token: 'access-fixture',
      refresh_token: 'refresh-fixture',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
  ];
}

test('login discovers the form target, forwards cookies, and exchanges the ondus callback', async () => {
  const { fetch, calls } = createFetch(loginResponses());
  const client = new GroheClient({ fetch, now: () => 1_000 });

  const tokens = await client.login('person@example.invalid', 'password-fixture');

  assert.deepEqual(tokens, {
    access_token: 'access-fixture',
    refresh_token: 'refresh-fixture',
    expires_in: 3600,
    token_type: 'Bearer',
  });
  assert.deepEqual(client.getTokens(), tokens);
  assert.equal(calls[0].url, LOGIN_URL);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[1].url, `${IDP_BASE}/authorize`);
  assert.equal(calls[1].options.redirect, 'manual');

  assert.equal(
    calls[2].url,
    `${IDP_BASE}/realms/grohe/login-actions/authenticate?session_code=synthetic-session`,
  );
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.redirect, 'manual');
  assert.equal(calls[2].options.headers.Cookie, 'oidc_state=state-fixture; idp_session=session-fixture');
  assert.equal(calls[2].options.headers.Referer, `${IDP_BASE}/authorize`);
  assert.equal(calls[2].options.body, [
    'execution=synthetic-execution',
    'client_id=synthetic-client',
    'username=person%40example.invalid',
    'password=password-fixture',
  ].join('&'));

  assert.equal(
    calls[3].url,
    'https://idp2-apigw.cloud.grohe.com/v3/iot/oidc/token?code=synthetic-code',
  );
  assert.equal(calls[3].options.redirect, 'manual');
});

test('login rejects invalid credentials without exposing them', async () => {
  const responses = loginResponses();
  responses[2] = jsonResponse(
    { errorMessage: 'password-fixture was rejected for person@example.invalid' },
    { status: 401 },
  );
  responses.length = 3;
  const { fetch } = createFetch(responses);
  const client = new GroheClient({ fetch });

  await assert.rejects(
    client.login('person@example.invalid', 'password-fixture'),
    (error) => {
      assert.equal(error.name, 'GroheAuthenticationError');
      assert.equal(error.status, 401);
      assert.equal(error.message, 'GROHE request failed');
      assert.equal(JSON.stringify(error).includes('person@example.invalid'), false);
      assert.equal(JSON.stringify(error).includes('password-fixture'), false);
      return true;
    },
  );
});

test('login sanitizes transport failures', async () => {
  const transportError = new Error('request contained password-fixture');
  transportError.token = 'access-fixture';
  const { fetch } = createFetch([
    () => {
      throw transportError;
    },
  ]);
  const client = new GroheClient({ fetch });

  await assert.rejects(client.login('person@example.invalid', 'password-fixture'), (error) => {
    assert.equal(error.message, 'GROHE request failed');
    assert.equal(Object.hasOwn(error, 'token'), false);
    assert.equal(error.message.includes('password-fixture'), false);
    return true;
  });
});

test('getDashboard refreshes the access token 60 seconds before expiry', async () => {
  let now = 10_000;
  const { fetch, calls } = createFetch([
    jsonResponse({
      access_token: 'fresh-access-fixture',
      refresh_token: 'fresh-refresh-fixture',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
    jsonResponse(DASHBOARD),
  ]);
  const client = new GroheClient({
    fetch,
    now: () => now,
    tokens: {
      access_token: 'expiring-access-fixture',
      refresh_token: 'refresh-fixture',
      expires_in: 120,
      token_type: 'Bearer',
    },
  });
  now = 70_000;

  assert.deepEqual(await client.getDashboard(), DASHBOARD);
  assert.equal(calls[0].url, REFRESH_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, JSON.stringify({
    refresh_token: 'refresh-fixture',
    grant_type: 'refresh_token',
  }));
  assert.equal(calls[1].url, DASHBOARD_URL);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fresh-access-fixture');
});

test('concurrent safe GETs share one token refresh', async () => {
  let releaseRefresh;
  const refreshReady = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshRequests = 0;
  const fetch = async (url, options = {}) => {
    if (url === REFRESH_URL) {
      refreshRequests += 1;
      await refreshReady;
      return jsonResponse({
        access_token: 'fresh-access-fixture',
        refresh_token: 'fresh-refresh-fixture',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    assert.equal(url, DASHBOARD_URL);
    assert.equal(options.headers.Authorization, 'Bearer fresh-access-fixture');
    return jsonResponse(DASHBOARD);
  };
  const client = new GroheClient({
    fetch,
    now: () => 70_000,
    tokens: {
      access_token: 'expiring-access-fixture',
      refresh_token: 'refresh-fixture',
      expires_in: 60,
    },
  });

  const first = client.getDashboard();
  const second = client.getDashboard();
  await Promise.resolve();
  assert.equal(refreshRequests, 1);
  releaseRefresh();

  assert.deepEqual(await Promise.all([first, second]), [DASHBOARD, DASHBOARD]);
  assert.equal(refreshRequests, 1);
});

test('getDashboard refreshes once after a 401 and retries the safe GET once', async () => {
  const { fetch, calls } = createFetch([
    jsonResponse({ errorMessage: 'expired access fixture' }, { status: 401 }),
    jsonResponse({
      access_token: 'fresh-access-fixture',
      refresh_token: 'fresh-refresh-fixture',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
    jsonResponse(DASHBOARD),
  ]);
  const client = new GroheClient({
    fetch,
    now: () => 10_000,
    tokens: {
      access_token: 'stale-access-fixture',
      refresh_token: 'refresh-fixture',
      expires_in: 3600,
    },
  });

  assert.deepEqual(await client.getDashboard(), DASHBOARD);
  assert.deepEqual(calls.map(({ url }) => url), [DASHBOARD_URL, REFRESH_URL, DASHBOARD_URL]);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer stale-access-fixture');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer fresh-access-fixture');
});

for (const enabled of [true, false]) {
  test(`setAutoFlush sends exactly auto_flush_active=${enabled} to the appliance`, async () => {
    const updated = { config: { auto_flush_active: enabled } };
    const { fetch, calls } = createFetch([jsonResponse(updated)]);
    const client = new GroheClient({
      fetch,
      now: () => 10_000,
      tokens: {
        access_token: 'access-fixture',
        refresh_token: 'refresh-fixture',
        expires_in: 3600,
      },
    });

    const result = await client.setAutoFlush({
      locationId: 'location fixture',
      roomId: 'room/fixture',
      applianceId: 'appliance?fixture',
    }, enabled);

    assert.deepEqual(result, updated);
    assert.equal(
      calls[0].url,
      `${API_BASE}/locations/location%20fixture/rooms/room%2Ffixture/appliances/appliance%3Ffixture`,
    );
    assert.equal(calls[0].options.method, 'PUT');
    assert.deepEqual(calls[0].options.headers, {
      Authorization: 'Bearer access-fixture',
      'Content-Type': 'application/json',
    });
    assert.equal(calls[0].options.body, JSON.stringify({
      config: { auto_flush_active: enabled },
    }));
  });
}

test('setAutoFlush does not retry an ambiguous transport failure', async () => {
  const { fetch, calls } = createFetch([
    () => {
      throw new Error('socket closed after sending access-fixture');
    },
  ]);
  const client = new GroheClient({
    fetch,
    now: () => 10_000,
    tokens: {
      access_token: 'access-fixture',
      refresh_token: 'refresh-fixture',
      expires_in: 3600,
    },
  });

  await assert.rejects(
    client.setAutoFlush({
      locationId: 'location-fixture',
      roomId: 'room-fixture',
      applianceId: 'appliance-fixture',
    }, true),
    (error) => {
      assert.equal(error.message, 'GROHE request failed');
      assert.equal(error.message.includes('access-fixture'), false);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});
