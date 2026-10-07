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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

test('authenticated token refresh failure clears the account and requires re-login', async () => {
  const GroheApp = loadWithFakeHomey('../app');
  const removals = [];
  const rawClient = {
    async refreshTokens() {
      const error = new Error('refresh-fixture must not escape');
      error.name = 'GroheAuthenticationError';
      error.status = 401;
      throw error;
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

test('transient token refresh failures preserve the account for automatic retry', async () => {
  const GroheApp = loadWithFakeHomey('../app');
  const removals = [];
  let attempt = 0;
  const rawClient = {
    async refreshTokens() {
      attempt += 1;
      if (attempt === 2) {
        throw new TypeError('network details must not escape');
      }
      const error = new Error('upstream response must not escape');
      error.name = 'GroheRequestError';
      error.status = 503;
      throw error;
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
    name: 'GroheRequestError',
    message: 'GROHE request failed',
    status: 503,
  });
  await assert.rejects(client.refreshTokens(), {
    name: 'TypeError',
    message: 'GROHE request failed',
  });
  assert.deepEqual(removals, []);
  assert.equal(app.getClient(), client);
  assert.deepEqual(app.account, {
    refreshToken: 'refresh-fixture',
    userId: 'person@example.invalid',
  });
});

test('startup reconstructs the client from the stored refresh token', async () => {
  const GroheApp = loadWithFakeHomey('../app');
  const clientOptions = [];
  const reconstructedClient = {
    async refreshTokens() {
      return { refresh_token: 'stored-refresh-fixture' };
    },
  };
  const app = new GroheApp();
  app.createGroheClient = (options) => {
    clientOptions.push(options);
    return reconstructedClient;
  };
  app.homey = {
    settings: {
      get() {
        return {
          refreshToken: 'stored-refresh-fixture',
          userId: 'stored@example.invalid',
        };
      },
    },
  };

  await app.onInit();

  assert.deepEqual(clientOptions, [{
    tokens: { refresh_token: 'stored-refresh-fixture' },
  }]);
  assert.equal(app.getClient(), reconstructedClient);
});

test('successful token rotation persists the new refresh token', async () => {
  const GroheApp = loadWithFakeHomey('../app');
  const writes = [];
  const rawClient = {
    async refreshTokens() {
      return {
        access_token: 'rotated-access-fixture',
        refresh_token: 'rotated-refresh-fixture',
      };
    },
  };
  const app = new GroheApp();
  app.createGroheClient = () => rawClient;
  app.homey = {
    settings: {
      get() {
        return {
          refreshToken: 'stored-refresh-fixture',
          userId: 'stored@example.invalid',
        };
      },
      set(key, value) {
        writes.push({ key, value });
      },
    },
  };

  await app.onInit();
  await app.getClient().refreshTokens();

  assert.deepEqual(writes, [{
    key: 'account',
    value: {
      refreshToken: 'rotated-refresh-fixture',
      userId: 'stored@example.invalid',
    },
  }]);
});

test('stale refresh success cannot overwrite a newly logged-in account', async () => {
  const GroheApp = loadWithFakeHomey('../app');
  const staleRefresh = createDeferred();
  const writes = [];
  const clients = [
    { refreshTokens: () => staleRefresh.promise },
    { async refreshTokens() { return { refresh_token: 'new-refresh-fixture' }; } },
  ];
  const app = new GroheApp();
  app.createGroheClient = () => clients.shift();
  app.homey = {
    settings: {
      get() {
        return {
          refreshToken: 'old-refresh-fixture',
          userId: 'old@example.invalid',
        };
      },
      set(key, value) {
        writes.push({ key, value });
      },
    },
  };

  await app.onInit();
  const oldClient = app.getClient();
  const staleResult = oldClient.refreshTokens();
  await app.saveAccount({
    refreshToken: 'new-refresh-fixture',
    userId: 'new@example.invalid',
  });
  const newClient = app.getClient();
  staleRefresh.resolve({ refresh_token: 'stale-rotated-fixture' });
  await staleResult;

  assert.equal(app.getClient(), newClient);
  assert.deepEqual(app.account, {
    refreshToken: 'new-refresh-fixture',
    userId: 'new@example.invalid',
  });
  assert.deepEqual(writes, [{
    key: 'account',
    value: {
      refreshToken: 'new-refresh-fixture',
      userId: 'new@example.invalid',
    },
  }]);
});

test('stale refresh failure cannot delete a newly logged-in account', async () => {
  const GroheApp = loadWithFakeHomey('../app');
  const staleRefresh = createDeferred();
  const writes = [];
  const removals = [];
  const clients = [
    { refreshTokens: () => staleRefresh.promise },
    { async refreshTokens() { return { refresh_token: 'new-refresh-fixture' }; } },
  ];
  const app = new GroheApp();
  app.createGroheClient = () => clients.shift();
  app.homey = {
    settings: {
      get() {
        return {
          refreshToken: 'old-refresh-fixture',
          userId: 'old@example.invalid',
        };
      },
      set(key, value) {
        writes.push({ key, value });
      },
      unset(key) {
        removals.push(key);
      },
    },
  };

  await app.onInit();
  const oldClient = app.getClient();
  const staleResult = oldClient.refreshTokens();
  await app.saveAccount({
    refreshToken: 'new-refresh-fixture',
    userId: 'new@example.invalid',
  });
  const newClient = app.getClient();
  const staleError = new Error('stale refresh failed');
  staleError.name = 'GroheAuthenticationError';
  staleError.status = 401;
  staleRefresh.reject(staleError);
  await assert.rejects(staleResult, { name: 'GroheAuthenticationError' });

  assert.equal(app.getClient(), newClient);
  assert.deepEqual(app.account, {
    refreshToken: 'new-refresh-fixture',
    userId: 'new@example.invalid',
  });
  assert.deepEqual(removals, []);
  assert.deepEqual(writes, [{
    key: 'account',
    value: {
      refreshToken: 'new-refresh-fixture',
      userId: 'new@example.invalid',
    },
  }]);
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
  await assert.rejects(handlers.get('list_devices')(), {
    name: 'GroheAuthenticationError',
    message: 'GROHE request failed',
  });
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

test('repair signs in again, stores the account, and recovers the repaired device', async () => {
  const loginCalls = [];
  const storedAccounts = [];
  const recoveries = [];
  const fakeClient = {
    async login(...args) {
      loginCalls.push(args);
      return {
        access_token: 'access-fixture',
        refresh_token: 'repaired-refresh-fixture',
      };
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
  const device = {
    async onAccountRepaired() {
      recoveries.push(storedAccounts.length);
    },
  };

  await driver.onRepair(session, device);
  assert.deepEqual([...handlers.keys()], ['login']);

  assert.equal(await handlers.get('login')({
    username: 'person@example.invalid',
    password: 'password-fixture',
  }), true);

  assert.deepEqual(loginCalls, [[
    'person@example.invalid',
    'password-fixture',
  ]]);
  assert.deepEqual(storedAccounts, [{
    refreshToken: 'repaired-refresh-fixture',
    userId: 'person@example.invalid',
  }]);
  // The device recovers only after the new account has been persisted.
  assert.deepEqual(recoveries, [1]);
  assert.equal(JSON.stringify(storedAccounts).includes('password-fixture'), false);
});

test('a failed repair login is redacted and leaves the account and device untouched', async () => {
  const storedAccounts = [];
  const recoveries = [];
  const fakeClient = {
    async login() {
      const error = new Error('rejected credentials for person@example.invalid');
      error.name = 'GroheAuthenticationError';
      error.status = 401;
      throw error;
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
  const device = {
    async onAccountRepaired() {
      recoveries.push(undefined);
    },
  };

  await driver.onRepair(session, device);
  await assert.rejects(
    handlers.get('login')({
      username: 'person@example.invalid',
      password: 'password-fixture',
    }),
    (error) => {
      assert.equal(error.name, 'GroheAuthenticationError');
      assert.equal(error.message, 'GROHE request failed');
      assert.equal(error.status, 401);
      assert.equal(error.message.includes('person@example.invalid'), false);
      return true;
    },
  );

  assert.deepEqual(storedAccounts, []);
  assert.deepEqual(recoveries, []);
});

test('a failed recovery read does not undo an otherwise successful repair', async () => {
  const storedAccounts = [];
  const loggedErrors = [];
  const fakeClient = {
    async login() {
      return { refresh_token: 'repaired-refresh-fixture' };
    },
  };
  const handlers = new Map();
  const Driver = loadWithFakeHomey('../drivers/blue_home/driver');
  const driver = new Driver();
  driver.createPairingClient = () => fakeClient;
  driver.error = (error) => {
    loggedErrors.push(error);
  };
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
  const device = {
    async onAccountRepaired() {
      throw new Error('recovery secret must not escape');
    },
  };

  await driver.onRepair(session, device);
  assert.equal(await handlers.get('login')({
    username: 'person@example.invalid',
    password: 'password-fixture',
  }), true);

  assert.deepEqual(storedAccounts, [{
    refreshToken: 'repaired-refresh-fixture',
    userId: 'person@example.invalid',
  }]);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0].message, 'GROHE request failed');
});

test('Compose declares credential-first pairing and read-only monitoring capabilities', () => {
  const appManifest = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, '.homeycompose/app.json'),
    'utf8',
  ));
  const driver = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'drivers/blue_home/driver.compose.json'),
    'utf8',
  ));
  assert.equal(appManifest.id, 'com.seweryn.groheblue');
  assert.equal(appManifest.sdk, 3);
  assert.deepEqual(appManifest.platforms, ['local']);
  assert.deepEqual(appManifest.category, ['appliances']);
  assert.equal(typeof appManifest.brandColor, 'string');
  assert.deepEqual(Object.keys(appManifest.images).sort(), ['large', 'small', 'xlarge']);
  assert.deepEqual(
    driver.pair.map(({ id }) => id),
    ['login_credentials', 'list_devices', 'add_devices'],
  );
  assert.deepEqual(
    driver.repair.map(({ id }) => id),
    ['login_credentials'],
  );
  assert.equal(driver.connectivity.includes('cloud'), true);
  assert.equal(driver.capabilities.includes('grohe_auto_flush'), true);

  // Homey resolves custom pair and repair views from separate folders, so both
  // view files have to exist. The locales they reference must exist too.
  for (const [viewType, view] of [['pair', 'login_credentials'], ['repair', 'login_credentials']]) {
    assert.equal(
      fs.existsSync(path.join(
        PROJECT_ROOT,
        `drivers/blue_home/${viewType}/${view}.html`,
      )),
      true,
      `${viewType}/${view}.html`,
    );
  }
  const locales = ['en', 'pl'].map((language) => JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, `locales/${language}.json`),
    'utf8',
  )));
  for (const locale of locales) {
    assert.equal(typeof locale.repair?.login?.title, 'string');
    assert.equal(typeof locale.repair?.login?.hint, 'string');
  }

  const generatedManifest = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'app.json'),
    'utf8',
  ));
  const generatedDriver = generatedManifest.drivers.find(({ id }) => id === 'blue_home');
  assert.equal(generatedManifest.version, appManifest.version);
  assert.deepEqual(generatedDriver.repair, driver.repair);

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
  assert.equal(autoFlush.getable, true);
  assert.equal(autoFlush.setable, true);

  const readOnlyIds = [
    'grohe_online',
    'grohe_measurement_timestamp',
    'alarm_grohe_filter_low',
    'alarm_grohe_co2_low',
  ];
  for (const id of readOnlyIds) {
    const capability = JSON.parse(fs.readFileSync(
      path.join(PROJECT_ROOT, `.homeycompose/capabilities/${id}.json`),
      'utf8',
    ));
    assert.equal(capability.getable, true, id);
    assert.equal(capability.setable, false, id);
  }

  const booleanInsightIds = [
    'grohe_online',
    'alarm_grohe_filter_low',
    'alarm_grohe_co2_low',
  ];
  for (const id of booleanInsightIds) {
    const capability = JSON.parse(fs.readFileSync(
      path.join(PROJECT_ROOT, `.homeycompose/capabilities/${id}.json`),
      'utf8',
    ));
    assert.equal(capability.insights, true, id);
    assert.equal(typeof capability.insightsTitleTrue?.en, 'string', id);
    assert.equal(typeof capability.insightsTitleTrue?.pl, 'string', id);
    assert.equal(typeof capability.insightsTitleFalse?.en, 'string', id);
    assert.equal(typeof capability.insightsTitleFalse?.pl, 'string', id);
  }
});
