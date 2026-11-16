'use strict';

import Homey from 'homey';
import { DigestHttpOptions } from './DigestHttp';
import {
  HikEvent, MOTION_EVENTS, TAMPER_EVENTS, TRIGGER_CARDS,
} from './events';

interface HikvisionAppLike extends Homey.App {
  connections: {
    acquire(opts: DigestHttpOptions, subscriber: {
      onEvent(event: HikEvent): void;
      onConnected(): void;
      onDisconnected(err: Error): void;
    }): () => void;
  };
}

/**
 * Shared behaviour for both directly-connected cameras and NVR channels:
 * subscribes to the (shared) alert stream, filters events by channel, keeps
 * alarm capabilities in sync and fires Flow triggers exactly once per event
 * episode.
 *
 * Hikvision repeats an "active" notification roughly every second for as
 * long as a detection lasts and does not always send a matching "inactive".
 * An episode therefore starts on the first active notification (rising
 * edge → Flow trigger) and ends either on an explicit inactive notification
 * or when no repeat arrives within the configured quiet period.
 */
export = class HikvisionDevice extends Homey.Device {

  private releaseConnection: (() => void) | null = null;
  private clearTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;

  async onInit() {
    this.connect();
    this.log(`${this.getName()} initialized (channel ${this.getChannel()})`);
  }

  private connectionOptions(): DigestHttpOptions {
    const settings = this.getSettings();
    return {
      host: String(settings.address || '').trim(),
      port: Number(settings.port) || 80,
      secure: Boolean(settings.use_https),
      username: String(settings.username || ''),
      password: String(settings.password || ''),
    };
  }

  private getChannel(): number {
    return Number(this.getSetting('channel')) || 1;
  }

  private getQuietPeriodMs(): number {
    const seconds = Number(this.getSetting('alarm_auto_reset'));
    return (Number.isFinite(seconds) && seconds >= 1 ? seconds : 10) * 1000;
  }

  protected connect(): void {
    this.disconnect();
    const opts = this.connectionOptions();
    if (!opts.host) {
      this.setUnavailable(this.homey.__('device.no_address')).catch(this.error);
      return;
    }
    const app = this.homey.app as HikvisionAppLike;
    this.releaseConnection = app.connections.acquire(opts, {
      onEvent: (event) => this.handleEvent(event),
      onConnected: () => {
        this.setAvailable().catch(this.error);
      },
      onDisconnected: (err) => {
        this.setUnavailable(`${this.homey.__('device.connection_lost')}: ${err.message}`).catch(this.error);
      },
    });
  }

  protected disconnect(): void {
    if (this.releaseConnection) {
      this.releaseConnection();
      this.releaseConnection = null;
    }
    this.clearTimers.forEach((timer) => clearTimeout(timer));
    this.clearTimers.clear();
  }

  private handleEvent(event: HikEvent): void {
    if (event.channel !== this.getChannel()) return;

    if (event.active) {
      const isNewEpisode = !this.clearTimers.has(event.type);

      const existing = this.clearTimers.get(event.type);
      if (existing) clearTimeout(existing);
      this.clearTimers.set(event.type, this.homey.setTimeout(() => {
        this.endEpisode(event.type);
      }, this.getQuietPeriodMs()));

      if (isNewEpisode) this.beginEpisode(event);
    } else {
      this.endEpisode(event.type);
    }
  }

  private beginEpisode(event: HikEvent): void {
    this.log(`event started: ${event.type} (raw: ${event.rawType}, channel ${event.channel})`);
    this.syncCapabilities();

    const tokens = {
      event_type: event.type,
      channel: event.channel,
      description: event.description || '',
    };

    const cardId = TRIGGER_CARDS[event.type];
    if (cardId) {
      this.homey.flow.getDeviceTriggerCard(cardId)
        .trigger(this, tokens, {})
        .catch((err: Error) => this.error(`Failed to trigger ${cardId}:`, err));
    }

    this.homey.flow.getDeviceTriggerCard('event_received')
      .trigger(this, tokens, {})
      .catch((err: Error) => this.error('Failed to trigger event_received:', err));
  }

  private endEpisode(type: string): void {
    const timer = this.clearTimers.get(type);
    if (!timer) return;
    clearTimeout(timer);
    this.clearTimers.delete(type);
    this.log(`event ended: ${type}`);
    this.syncCapabilities();
  }

  /**
   * Recompute all alarm capabilities from the set of currently active
   * episodes, so overlapping events (e.g. line crossing during motion)
   * cannot clear each other's alarms prematurely.
   */
  private syncCapabilities(): void {
    const active: string[] = [];
    this.clearTimers.forEach((_timer, type) => active.push(type));

    const anyOf = (types: string[]) => active.some((t) => types.indexOf(t) !== -1);
    const isSmart = (t: string) => MOTION_EVENTS.indexOf(t) === -1
      && TAMPER_EVENTS.indexOf(t) === -1 && t !== 'videoloss';

    this.setAlarm('alarm_motion', anyOf(MOTION_EVENTS));
    this.setAlarm('alarm_tamper', anyOf(TAMPER_EVENTS));
    this.setAlarm('alarm_generic', active.some(isSmart));
  }

  private setAlarm(capability: string, value: boolean): void {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value)
      .catch((err: Error) => this.error(`Failed to set ${capability}:`, err));
  }

  async onSettings({ changedKeys }: {
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }) {
    const connectionKeys = ['address', 'port', 'use_https', 'username', 'password'];
    if (changedKeys.some((key) => connectionKeys.indexOf(key) !== -1)) {
      // Reconnect after the new settings have been persisted.
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = this.homey.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 1000);
    }
  }

  async onDeleted() {
    this.disconnect();
  }

  async onUninit() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.disconnect();
  }

};
