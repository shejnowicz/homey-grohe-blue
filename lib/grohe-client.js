const { safeError } = require('./redact');

const API_BASE = 'https://idp2-apigw.cloud.grohe.com/v3/iot';
const LOGIN_URL = `${API_BASE}/oidc/login`;
const REFRESH_URL = `${API_BASE}/oidc/refresh`;
const REFRESH_EARLY_MS = 60_000;

function requestError(name, status) {
  const error = new Error('GROHE request failed');
  error.name = name;
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function isRedirect(response) {
  return response.status >= 300 && response.status < 400;
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function attributes(source) {
  const result = {};
  const pattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function findLoginForm(html) {
  const formMatch = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) {
    throw requestError('GroheProtocolError');
  }

  const formAttributes = attributes(formMatch[1]);
  if (!formAttributes.action) {
    throw requestError('GroheProtocolError');
  }

  const fields = new URLSearchParams();
  for (const input of formMatch[2].matchAll(/<input\b([^>]*)>/gi)) {
    const inputAttributes = attributes(input[1]);
    if (inputAttributes.name) {
      fields.set(inputAttributes.name, inputAttributes.value || '');
    }
  }

  return { action: formAttributes.action, fields };
}

class CookieJar {
  #cookies = new Map();

  store(response) {
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);

    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.#cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
  }

  header() {
    if (this.#cookies.size === 0) {
      return undefined;
    }
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  clear() {
    this.#cookies.clear();
  }
}

class GroheClient {
  #fetch;
  #now;
  #tokens;
  #accessTokenExpiresAt;
  #refreshPromise;

  constructor({ fetch = globalThis.fetch, now = Date.now, tokens } = {}) {
    this.#fetch = fetch;
    this.#now = now;
    this.#tokens = undefined;
    this.#accessTokenExpiresAt = Number.NEGATIVE_INFINITY;
    this.#refreshPromise = undefined;
    if (tokens) {
      this.setTokens(tokens);
    }
  }

  setTokens(tokens) {
    this.#tokens = { ...tokens };
    this.#accessTokenExpiresAt = Number.isFinite(tokens.expires_in)
      ? this.#now() + (tokens.expires_in * 1_000)
      : Number.NEGATIVE_INFINITY;
    return this.getTokens();
  }

  getTokens() {
    return this.#tokens && { ...this.#tokens };
  }

  async refreshTokens() {
    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }

    this.#refreshPromise = this.#performRefresh();
    try {
      return await this.#refreshPromise;
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  async #performRefresh() {
    try {
      const refreshToken = this.#tokens?.refresh_token;
      if (!refreshToken) {
        throw requestError('GroheAuthenticationError');
      }

      const response = await this.#fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      if (!response.ok) {
        const name = response.status === 401 || response.status === 403
          ? 'GroheAuthenticationError'
          : 'GroheRequestError';
        throw requestError(name, response.status);
      }

      this.setTokens(await response.json());
      return this.getTokens();
    } catch (error) {
      throw safeError(error);
    }
  }

  async #ensureFreshAccessToken() {
    if (!this.#tokens?.access_token || this.#now() >= this.#accessTokenExpiresAt - REFRESH_EARLY_MS) {
      await this.refreshTokens();
    }
    return this.#tokens.access_token;
  }

  async #get(url) {
    try {
      const accessToken = await this.#ensureFreshAccessToken();
      let response = await this.#fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.status === 401) {
        if (this.#tokens?.access_token === accessToken) {
          await this.refreshTokens();
        }
        response = await this.#fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.#tokens.access_token}` },
        });
      }

      if (!response.ok) {
        throw requestError('GroheRequestError', response.status);
      }
      return await response.json();
    } catch (error) {
      throw safeError(error);
    }
  }

  async getDashboard() {
    return this.#get(`${API_BASE}/dashboard`);
  }

  async setAutoFlush(route, enabled) {
    try {
      const accessToken = await this.#ensureFreshAccessToken();
      const locationId = encodeURIComponent(route.locationId);
      const roomId = encodeURIComponent(route.roomId);
      const applianceId = encodeURIComponent(route.applianceId);
      const url = `${API_BASE}/locations/${locationId}/rooms/${roomId}/appliances/${applianceId}`;
      const response = await this.#fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          config: { auto_flush_active: enabled },
        }),
      });

      if (!response.ok) {
        throw requestError('GroheRequestError', response.status);
      }
      const body = await response.text();
      return body ? JSON.parse(body) : undefined;
    } catch (error) {
      throw safeError(error);
    }
  }

  async login(email, password) {
    const cookieJar = new CookieJar();
    let loginEmail = email;
    let loginPassword = password;

    const request = async (url, options = {}) => {
      const headers = { ...options.headers };
      const cookie = cookieJar.header();
      if (cookie) {
        headers.Cookie = cookie;
      }

      const response = await this.#fetch(url, { ...options, headers, redirect: 'manual' });
      cookieJar.store(response);
      return response;
    };

    try {
      let pageUrl = LOGIN_URL;
      let pageResponse = await request(pageUrl);
      for (let redirects = 0; isRedirect(pageResponse); redirects += 1) {
        if (redirects >= 10) {
          throw requestError('GroheProtocolError');
        }
        const location = pageResponse.headers.get('location');
        if (!location) {
          throw requestError('GroheProtocolError');
        }
        pageUrl = new URL(location, pageUrl).toString();
        pageResponse = await request(pageUrl);
      }

      if (!pageResponse.ok) {
        throw requestError('GroheRequestError', pageResponse.status);
      }

      const form = findLoginForm(await pageResponse.text());
      form.fields.set('username', loginEmail);
      form.fields.set('password', loginPassword);
      const actionUrl = new URL(form.action, pageUrl).toString();
      const loginResponse = await request(actionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: pageUrl,
        },
        body: form.fields.toString(),
      });

      if (loginResponse.status === 401 || loginResponse.status === 403) {
        throw requestError('GroheAuthenticationError', loginResponse.status);
      }
      if (!isRedirect(loginResponse)) {
        throw requestError('GroheAuthenticationError', loginResponse.status);
      }

      const callback = loginResponse.headers.get('location');
      if (!callback || !callback.startsWith('ondus://')) {
        throw requestError('GroheProtocolError');
      }
      const tokenUrl = `https://${callback.slice('ondus://'.length)}`;
      const tokenResponse = await request(tokenUrl);
      if (!tokenResponse.ok) {
        throw requestError('GroheRequestError', tokenResponse.status);
      }

      const tokens = await tokenResponse.json();
      this.setTokens(tokens);
      return this.getTokens();
    } catch (error) {
      throw safeError(error);
    } finally {
      cookieJar.clear();
      loginEmail = undefined;
      loginPassword = undefined;
    }
  }
}

module.exports = { GroheClient };
