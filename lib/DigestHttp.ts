'use strict';

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';

export interface DigestHttpOptions {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface HttpResult {
  statusCode: number;
  body: string;
}

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

/**
 * Build an RFC 2617 Digest Authorization header from a WWW-Authenticate
 * challenge. Hikvision devices use MD5 with qop="auth"; older firmware
 * sometimes omits qop entirely, both forms are supported.
 */
function buildDigestHeader(
  username: string,
  password: string,
  method: string,
  uri: string,
  challenge: string,
): string {
  const params: { [key: string]: string } = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match = re.exec(challenge);
  while (match !== null) {
    params[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    match = re.exec(challenge);
  }

  const realm = params.realm || '';
  const nonce = params.nonce || '';
  const hasQopAuth = (params.qop || '').split(',').map((s) => s.trim()).indexOf('auth') !== -1;

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  let response: string;
  let extra = '';
  if (hasQopAuth) {
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    extra = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", `
    + `uri="${uri}", response="${response}"${extra}`;
  if (params.opaque !== undefined) header += `, opaque="${params.opaque}"`;
  if (params.algorithm !== undefined) header += `, algorithm=${params.algorithm}`;
  return header;
}

/**
 * Minimal dependency-free HTTP client with Digest (and Basic fallback)
 * authentication, supporting both buffered requests and long-lived
 * streaming responses. Hikvision firmware defaults to Digest; Basic is
 * only used when the device explicitly challenges with it.
 */
export class DigestHttp {

  private opts: DigestHttpOptions;

  constructor(opts: DigestHttpOptions) {
    this.opts = opts;
  }

  get label(): string {
    return `${this.opts.host}:${this.opts.port}`;
  }

  private rawRequest(
    method: string,
    path: string,
    headers: { [key: string]: string },
    timeoutMs: number,
  ): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const transport = this.opts.secure ? https : http;
      const req = transport.request({
        host: this.opts.host,
        port: this.opts.port,
        method,
        path,
        headers,
        // Hikvision devices commonly use self-signed certificates.
        rejectUnauthorized: false,
      } as https.RequestOptions, resolve);
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Timeout connecting to ${this.label}`));
      });
      req.end();
    });
  }

  private static drain(res: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 1024 * 1024) body += chunk;
      });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(body));
    });
  }

  private authHeaderFor(method: string, path: string, challenge: string): string {
    if (/^basic/i.test(challenge)) {
      const token = Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64');
      return `Basic ${token}`;
    }
    return buildDigestHeader(this.opts.username, this.opts.password, method, path, challenge);
  }

  /**
   * Open a request and resolve with the (possibly streaming) response once
   * authentication has completed. The caller owns the response and must
   * destroy it when done.
   */
  async open(method: string, path: string, timeoutMs: number): Promise<http.IncomingMessage> {
    const first = await this.rawRequest(method, path, { Accept: '*/*' }, timeoutMs);

    if (first.statusCode !== 401) return first;

    const challenge = first.headers['www-authenticate'];
    await DigestHttp.drain(first);
    if (!challenge) {
      throw new Error(`Authentication required but no challenge received from ${this.label}`);
    }

    const second = await this.rawRequest(method, path, {
      Accept: '*/*',
      Authorization: this.authHeaderFor(method, path, Array.isArray(challenge) ? challenge[0] : challenge),
    }, timeoutMs);

    if (second.statusCode === 401) {
      await DigestHttp.drain(second);
      throw new Error(`Invalid username or password for ${this.label}`);
    }
    return second;
  }

  /**
   * Buffered GET helper for regular ISAPI calls.
   */
  async get(path: string, timeoutMs = 10000): Promise<HttpResult> {
    const res = await this.open('GET', path, timeoutMs);
    const body = await DigestHttp.drain(res);
    return { statusCode: res.statusCode || 0, body };
  }

}
