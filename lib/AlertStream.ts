'use strict';

import { EventEmitter } from 'events';
import type * as http from 'http';
import { DigestHttp } from './DigestHttp';
import { HikEvent, normalizeEventType } from './events';

const STREAM_PATH = '/ISAPI/Event/notification/alertStream';

/**
 * No-data watchdog. Hikvision devices send a heartbeat (usually a videoloss
 * "inactive" notification) several times per second, so 45 s of silence
 * means the TCP connection has silently died (e.g. after an NVR reboot or a
 * network hiccup) and must be re-established. Half-open connections like
 * this are the main cause of "events stopped arriving" with naive clients.
 */
const STALL_TIMEOUT_MS = 45000;
const WATCHDOG_INTERVAL_MS = 5000;
const CONNECT_TIMEOUT_MS = 15000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_BUFFER = 512 * 1024;

type Logger = (...args: unknown[]) => void;

/**
 * Persistent subscription to a device's ISAPI alert stream.
 *
 * Instead of polling (which misses short events and adds latency), this
 * keeps one long-lived HTTP connection open on which the camera/NVR pushes
 * every event the moment it happens. Emits:
 *  - 'event'      (HikEvent) for every real notification
 *  - 'connect'    when the stream is established
 *  - 'disconnect' (Error) when the stream drops (a reconnect is scheduled)
 */
export class AlertStream extends EventEmitter {

  private client: DigestHttp;
  private log: Logger;

  private stopped = true;
  private response: http.IncomingMessage | null = null;
  private buffer = '';
  private lastDataAt = 0;
  private retryCount = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(client: DigestHttp, log: Logger) {
    super();
    // Many devices in one app may share this emitter via the connection
    // manager; raise the limit so Node does not warn.
    this.setMaxListeners(100);
    this.client = client;
    this.log = log;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.retryCount = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.closeResponse();
  }

  private clearTimers(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeResponse(): void {
    if (this.response) {
      this.response.removeAllListeners();
      this.response.destroy();
      this.response = null;
    }
    this.buffer = '';
  }

  private connect(): void {
    if (this.stopped) return;
    this.log(`[alertStream] connecting to ${this.client.label}`);

    this.client.open('GET', STREAM_PATH, CONNECT_TIMEOUT_MS)
      .then((res) => {
        if (this.stopped) {
          res.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          res.destroy();
          throw new Error(`alertStream returned HTTP ${res.statusCode}`);
        }

        this.response = res;
        this.buffer = '';
        this.lastDataAt = Date.now();
        this.retryCount = 0;
        this.log(`[alertStream] connected to ${this.client.label}`);
        this.emit('connect');

        // The stream is a quasi-multipart mix of XML documents; collecting
        // it as latin1 text and scanning for complete documents is robust
        // across firmware variations in boundary formatting.
        res.setEncoding('latin1');
        // Disable the idle timeout set during connect: silence is handled
        // by the watchdog instead, so a slow-but-alive stream is not cut.
        if (res.socket) res.socket.setTimeout(0);
        res.on('data', (chunk: string) => this.onData(chunk));
        res.on('error', (err: Error) => this.onDisconnect(err));
        res.on('end', () => this.onDisconnect(new Error('Stream ended by device')));
        res.on('close', () => this.onDisconnect(new Error('Stream closed')));

        if (!this.watchdog) {
          // eslint-disable-next-line homey-app/global-timers -- cleared in stop()
          this.watchdog = setInterval(() => this.checkStall(), WATCHDOG_INTERVAL_MS);
          if (typeof this.watchdog.unref === 'function') this.watchdog.unref();
        }
      })
      .catch((err: Error) => this.onDisconnect(err));
  }

  private checkStall(): void {
    if (this.stopped || !this.response) return;
    if (Date.now() - this.lastDataAt > STALL_TIMEOUT_MS) {
      this.onDisconnect(new Error('Stream stalled (no data received), reconnecting'));
    }
  }

  private onDisconnect(err: Error): void {
    if (this.stopped) return;
    const hadResponse = this.response !== null;
    this.closeResponse();
    if (hadResponse || this.retryCount === 0) {
      this.log(`[alertStream] ${this.client.label} disconnected: ${err.message}`);
      this.emit('disconnect', err);
    }
    if (this.reconnectTimer) return;

    const delay = RECONNECT_DELAYS_MS[Math.min(this.retryCount, RECONNECT_DELAYS_MS.length - 1)];
    this.retryCount += 1;
    // eslint-disable-next-line homey-app/global-timers -- cleared in stop()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  private onData(chunk: string): void {
    this.lastDataAt = Date.now();
    this.buffer += chunk;

    // Extract every complete XML notification currently in the buffer.
    for (;;) {
      const end = this.buffer.indexOf('</EventNotificationAlert>');
      if (end === -1) break;
      const start = this.buffer.indexOf('<EventNotificationAlert');
      const doc = start !== -1 && start < end
        ? this.buffer.slice(start, end + '</EventNotificationAlert>'.length)
        : '';
      this.buffer = this.buffer.slice(end + '</EventNotificationAlert>'.length);
      if (doc) this.handleDocument(doc);
    }

    // Some firmware (when Accept: application/json is honored) sends JSON
    // bodies instead of XML; detect those by their mandatory key.
    if (this.buffer.indexOf('"eventType"') !== -1) {
      this.extractJsonDocuments();
    }

    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(this.buffer.length - 4096);
    }
  }

  private extractJsonDocuments(): void {
    // Scan for balanced top-level {...} blocks that contain "eventType".
    let searchFrom = 0;
    for (;;) {
      const open = this.buffer.indexOf('{', searchFrom);
      if (open === -1) return;
      let depth = 0;
      let close = -1;
      for (let i = open; i < this.buffer.length; i++) {
        const ch = this.buffer[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close === -1) return; // incomplete, wait for more data
      const raw = this.buffer.slice(open, close + 1);
      this.buffer = this.buffer.slice(close + 1);
      searchFrom = 0;
      if (raw.indexOf('"eventType"') !== -1) {
        try {
          const obj = JSON.parse(raw);
          this.handleParsed(
            String(obj.eventType || ''),
            String(obj.eventState || 'active'),
            Number(obj.dynChannelID || obj.channelID || 1),
            String(obj.eventDescription || ''),
          );
        } catch (err) {
          // Not a complete/valid JSON document — ignore.
        }
      }
    }
  }

  private handleDocument(xml: string): void {
    const tag = (name: string): string => {
      const match = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
      return match ? match[1].trim() : '';
    };
    this.handleParsed(
      tag('eventType'),
      tag('eventState') || 'active',
      Number(tag('dynChannelID') || tag('channelID') || 1),
      tag('eventDescription'),
    );
  }

  private handleParsed(rawType: string, state: string, channel: number, description: string): void {
    if (!rawType) return;
    const type = normalizeEventType(rawType);
    const active = state.toLowerCase() !== 'inactive';

    // The endless "videoloss inactive" notifications are the keep-alive
    // heartbeat, not real events — they only feed the watchdog.
    if (type === 'videoloss' && !active) return;

    const event: HikEvent = {
      type,
      rawType,
      channel: Number.isFinite(channel) && channel > 0 ? channel : 1,
      active,
      description,
    };
    this.emit('event', event);
  }

}
