const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const PROJECT_ROOT = path.join(__dirname, '..');

class FakeHomeyApp {}
class FakeHomeyDriver {}

function loadWithFakeHomey(modulePath) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'homey') {
      return { App: FakeHomeyApp, Driver: FakeHomeyDriver };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('app persists only the refresh token and account identifier', async () => {
  const GroheApp = loadWithFakeHomey('../app');
  const writes = [];
  const app = new GroheApp();
  app.homey = {
    settings: {
      set(key, value) {
        writes.push({ key, value });
      },
    },
  };

  await app.saveAccount({
    refreshToken: 'refresh-fixture',
    userId: 'person@example.invalid',
    password: 'password-fixture',
    accessToken: 'access-fixture',
  });

  assert.deepEqual(writes, [{
    key: 'account',
    value: {
      refreshToken: 'refresh-fixture',
      userId: 'person@example.invalid',
    },
  }]);
  assert.equal(JSON.stringify(writes).includes('password-fixture'), false);
  assert.equal(JSON.stringify(writes).includes('access-fixture'), false);
});

test('failed token refresh clears the account and requires re-login', async () => {
  const GroheApp = loadWithFakeHomey('../app');
  const removals = [];
  const rawClient = {
    async refreshTokens() {
      throw new Error('refresh-fixture must not escape');
    },
  };
  const app = new GroheApp();
  app.createGroheClient = () => rawClient;
  app.homey = {
    settings: {
      get() {
        return {
          refreshToken: 'refresh-fixture',
          userId: 'person@example.invalid',
        };
      },
      unset(key) {
        removals.push(key);
      },
    },
  };

  await app.onInit();
  const client = app.getClient();
  await assert.rejects(client.refreshTokens(), {
    name: 'GroheAuthenticationError',
    message: 'GROHE login required',
  });
  assert.deepEqual(removals, ['account']);
  assert.throws(() => app.getClient(), {
    name: 'GroheAuthenticationError',
    message: 'GROHE login required',
  });
});

test('pairing uses credentials only for login and returns secret-free device data', async () => {
  const loginCalls = [];
  const storedAccounts = [];
  const dashboard = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/dashboard.json'), 'utf8'),
  );
  const fakeClient = {
    async login(...args) {
      loginCalls.push(args);
      return {
        access_token: 'access-fixture',
        refresh_token: 'refresh-fixture',
      };
    },
    async getDashboard() {
      return dashboard;
    },
  };
  const handlers = new Map();
  const Driver = loadWithFakeHomey('../drivers/blue_home/driver');
  const driver = new Driver();
  driver.createPairingClient = () => fakeClient;
  driver.homey = {
    app: {
      async saveAccount(account) {
        storedAccounts.push(account);
      },
    },
  };
  const session = {
    setHandler(name, handler) {
      handlers.set(name, handler);
    },
  };

  await driver.onPair(session);
  assert.deepEqual([...handlers.keys()], ['login', 'list_devices']);
  assert.equal(await handlers.get('login')({
    username: 'person@example.invalid',
    password: 'password-fixture',
  }), true);
  const devices = await handlers.get('list_devices')();

  assert.deepEqual(loginCalls, [[
    'person@example.invalid',
    'password-fixture',
  ]]);
  assert.deepEqual(storedAccounts, [{
    refreshToken: 'refresh-fixture',
    userId: 'person@example.invalid',
  }]);
  assert.deepEqual(devices, [{
    name: 'Synthetic Blue Home',
    data: { id: 'appliance-fixture' },
    store: {
      route: {
        locationId: 'location-fixture',
        roomId: 'room-fixture',
        applianceId: 'appliance-fixture',
      },
      model: 'Blue Home',
      firmware: '3.2.1',
    },
  }]);
  assert.equal(devices.some((device) => Object.hasOwn(device, 'settings')), false);
  assert.equal(JSON.stringify({ devices, storedAccounts }).includes('password-fixture'), false);
});

test('Compose declares credential-first pairing and read-only monitoring capabilities', () => {
  const driver = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'drivers/blue_home/driver.compose.json'),
    'utf8',
  ));
  assert.deepEqual(
    driver.pair.map(({ id }) => id),
    ['login_credentials', 'list_devices', 'add_devices'],
  );
  assert.equal(driver.connectivity.includes('cloud'), true);
  assert.equal(driver.capabilities.includes('grohe_auto_flush'), true);

  const numericMonitoringIds = [
    'grohe_filter_percent',
    'grohe_co2_percent',
    'grohe_filter_liters',
    'grohe_co2_liters',
    'grohe_idle_minutes',
    'grohe_still_cycles',
    'grohe_carbonated_cycles',
  ];
  for (const id of numericMonitoringIds) {
    const capability = JSON.parse(fs.readFileSync(
      path.join(PROJECT_ROOT, `.homeycompose/capabilities/${id}.json`),
      'utf8',
    ));
    assert.equal(capability.type, 'number', id);
    assert.equal(capability.setable, false, id);
    assert.equal(capability.insights, true, id);
  }

  const autoFlush = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, '.homeycompose/capabilities/grohe_auto_flush.json'),
    'utf8',
  ));
  assert.equal(autoFlush.setable, true);
});
