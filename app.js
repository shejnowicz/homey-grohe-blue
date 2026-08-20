const Homey = require('homey');

const { GroheClient } = require('./lib/grohe-client');

const ACCOUNT_KEY = 'account';

function loginRequiredError() {
  const error = new Error('GROHE login required');
  error.name = 'GroheAuthenticationError';
  return error;
}

class GroheBlueApp extends Homey.App {
  async onInit() {
    this.account = this.#readAccount();
    this.client = this.account ? this.#createAccountClient(this.account) : undefined;
  }

  createGroheClient(options) {
    return new GroheClient(options);
  }

  getClient() {
    if (!this.client) {
      throw loginRequiredError();
    }
    return this.client;
  }

  saveAccount({ refreshToken, userId }) {
    const account = { refreshToken, userId };
    const client = this.#createAccountClient(account);
    this.homey.settings.set(ACCOUNT_KEY, account);
    this.account = account;
    this.client = client;
  }

  #readAccount() {
    const account = this.homey.settings.get(ACCOUNT_KEY);
    if (
      !account
      || typeof account.refreshToken !== 'string'
      || !account.refreshToken
      || typeof account.userId !== 'string'
      || !account.userId
    ) {
      return undefined;
    }
    return {
      refreshToken: account.refreshToken,
      userId: account.userId,
    };
  }

  #createAccountClient(account) {
    const client = this.createGroheClient({
      tokens: { refresh_token: account.refreshToken },
    });
    const refreshTokens = client.refreshTokens.bind(client);

    client.refreshTokens = async () => {
      try {
        const tokens = await refreshTokens();
        if (
          this.client === client
          && tokens.refresh_token
          && tokens.refresh_token !== this.account?.refreshToken
        ) {
          const updatedAccount = {
            refreshToken: tokens.refresh_token,
            userId: account.userId,
          };
          this.homey.settings.set(ACCOUNT_KEY, updatedAccount);
          this.account = updatedAccount;
        }
        return tokens;
      } catch {
        if (this.client === client) {
          this.homey.settings.unset(ACCOUNT_KEY);
          this.client = undefined;
          this.account = undefined;
        }
        throw loginRequiredError();
      }
    };

    return client;
  }
}

module.exports = GroheBlueApp;
