const { safeError } = require('./redact');

const API_BASE = 'https://idp2-apigw.cloud.grohe.com/v3/iot';
const TRUSTED_ORIGIN = new URL(API_BASE).origin;
const TOKEN_PATH = '/v3/iot/oidc/token';
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

function trustedHttpsUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw requestError('GroheProtocolError');
  }
  if (
    url.protocol !== 'https:'
    || url.origin !== TRUSTED_ORIGIN
    || url.username
    || url.password
  ) {
    throw requestError('GroheProtocolError');
  }
  return url;
}

function tokenExchangeUrl(value) {
  let callback;
  try {
    callback = new URL(value);
  } catch {
    throw requestError('GroheProtocolError');
  }
  if (
    callback.protocol !== 'ondus:'
    || callback.host !== new URL(TRUSTED_ORIGIN).host
    || callback.pathname !== TOKEN_PATH
    || callback.username
    || callback.password
    || callback.hash
  ) {
    throw requestError('GroheProtocolError');
  }
  return new URL(`https://${callback.host}${callback.pathname}${callback.search}`);
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
  #now;
  #nextSequence = 0;

  constructor(now) {
    this.#now = now;
  }

  store(response, responseUrl) {
    const url = new URL(responseUrl);
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);

    for (const value of values) {
      const parts = value.split(';');
      const pair = parts.shift();
      const separator = pair.indexOf('=');
      if (separator <= 0) {
        continue;
      }

      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      const cookieAttributes = new Map();
      for (const part of parts) {
        const attributeSeparator = part.indexOf('=');
        const attributeName = (attributeSeparator < 0 ? part : part.slice(0, attributeSeparator))
          .trim()
          .toLowerCase();
        const attributeValue = attributeSeparator < 0
          ? ''
          : part.slice(attributeSeparator + 1).trim();
        cookieAttributes.set(attributeName, attributeValue);
      }

      const requestedDomain = cookieAttributes.get('domain')?.replace(/^\./, '').toLowerCase();
      const domain = url.hostname.toLowerCase();
      if (requestedDomain && requestedDomain !== domain) {
        continue;
      }

      const defaultPath = url.pathname.includes('/')
        ? url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
        : '/';
      const requestedPath = cookieAttributes.get('path');
      const path = requestedPath?.startsWith('/') ? requestedPath : defaultPath;
      const key = `${name}\t${domain}\t${path}`;

      let expiresAt = Number.POSITIVE_INFINITY;
      const maxAge = cookieAttributes.get('max-age');
      if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) {
        expiresAt = this.#now() + (Number(maxAge) * 1_000);
      } else if (cookieAttributes.has('expires')) {
        const parsedExpiry = Date.parse(cookieAttributes.get('expires'));
        if (Number.isFinite(parsedExpiry)) {
          expiresAt = parsedExpiry;
        }
      }

      if (expiresAt <= this.#now()) {
        this.#cookies.delete(key);
        continue;
      }

      const previous = this.#cookies.get(key);
      this.#cookies.set(key, {
        name,
        value: cookieValue,
        domain,
        path,
        secure: cookieAttributes.has('secure'),
        expiresAt,
        sequence: previous?.sequence ?? this.#nextSequence++,
      });
    }
  }

  header(requestUrl) {
    const url = new URL(requestUrl);
    const now = this.#now();
    const matching = [];
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expiresAt <= now) {
        this.#cookies.delete(key);
        continue;
      }
      const pathMatches = url.pathname === cookie.path
        || (
          url.pathname.startsWith(cookie.path)
          && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/')
        );
      if (
        url.hostname.toLowerCase() === cookie.domain
        && pathMatches
        && (!cookie.secure || url.protocol === 'https:')
      ) {
        matching.push(cookie);
      }
    }

    if (matching.length === 0) {
      return undefined;
    }
    matching.sort((left, right) => right.path.length - left.path.length || left.sequence - right.sequence);
    return matching.map(({ name, value }) => `${name}=${value}`).join('; ');
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

      const refreshedTokens = await response.json();
      this.setTokens({
        ...refreshedTokens,
        refresh_token: refreshedTokens.refresh_token || refreshToken,
      });
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
          config: enabled
            ? { auto_flush_active: true, flush_confirmed: true }
            : { auto_flush_active: false },
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
    const cookieJar = new CookieJar(this.#now);
    let loginEmail = email;
    let loginPassword = password;

    const request = async (url, options = {}) => {
      const trustedUrl = trustedHttpsUrl(url);
      const headers = { ...options.headers };
      const cookie = cookieJar.header(trustedUrl);
      if (cookie) {
        headers.Cookie = cookie;
      }

      const response = await this.#fetch(trustedUrl, { ...options, headers, redirect: 'manual' });
      cookieJar.store(response, trustedUrl);
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
        pageUrl = trustedHttpsUrl(location, pageUrl).toString();
        pageResponse = await request(pageUrl);
      }

      if (!pageResponse.ok) {
        throw requestError('GroheRequestError', pageResponse.status);
      }

      const form = findLoginForm(await pageResponse.text());
      const actionUrl = trustedHttpsUrl(form.action, pageUrl).toString();
      form.fields.set('username', loginEmail);
      form.fields.set('password', loginPassword);
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
      if (!callback) {
        throw requestError('GroheProtocolError');
      }
      const tokenUrl = tokenExchangeUrl(callback);
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
