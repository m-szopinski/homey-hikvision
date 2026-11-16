'use strict';

import { DigestHttp, DigestHttpOptions } from './DigestHttp';
import { AlertStream } from './AlertStream';
import { HikEvent } from './events';

export interface Subscriber {
  onEvent(event: HikEvent): void;
  onConnected(): void;
  onDisconnected(err: Error): void;
}

type Logger = (...args: unknown[]) => void;

interface SharedConnection {
  stream: AlertStream;
  subscribers: Set<Subscriber>;
  connected: boolean;
}

/**
 * Keeps exactly one alert-stream connection per physical device, no matter
 * how many Homey devices (e.g. all channels of one NVR) subscribe to it.
 * Connections are reference-counted and torn down when the last subscriber
 * releases them.
 */
export class ConnectionManager {

  private connections: Map<string, SharedConnection> = new Map();
  private log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  private static key(opts: DigestHttpOptions): string {
    return [opts.host, opts.port, opts.secure ? 1 : 0, opts.username, opts.password].join('|');
  }

  /**
   * Subscribe to the alert stream of the device described by `opts`.
   * Returns a release function; calling it removes the subscriber and closes
   * the underlying connection when it was the last one.
   */
  acquire(opts: DigestHttpOptions, subscriber: Subscriber): () => void {
    const key = ConnectionManager.key(opts);
    let conn = this.connections.get(key);

    if (!conn) {
      const client = new DigestHttp(opts);
      const stream = new AlertStream(client, this.log);
      const created: SharedConnection = { stream, subscribers: new Set(), connected: false };

      stream.on('connect', () => {
        created.connected = true;
        created.subscribers.forEach((sub) => sub.onConnected());
      });
      stream.on('disconnect', (err: Error) => {
        created.connected = false;
        created.subscribers.forEach((sub) => sub.onDisconnected(err));
      });
      stream.on('event', (event: HikEvent) => {
        created.subscribers.forEach((sub) => sub.onEvent(event));
      });

      this.connections.set(key, created);
      conn = created;
      stream.start();
    }

    conn.subscribers.add(subscriber);
    if (conn.connected) subscriber.onConnected();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.connections.get(key);
      if (!current) return;
      current.subscribers.delete(subscriber);
      if (current.subscribers.size === 0) {
        current.stream.stop();
        this.connections.delete(key);
        this.log(`[connections] closed ${opts.host}:${opts.port} (no subscribers left)`);
      }
    };
  }

  destroy(): void {
    this.connections.forEach((conn) => conn.stream.stop());
    this.connections.clear();
  }

}
