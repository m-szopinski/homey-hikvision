'use strict';

import Homey from 'homey';
import { DigestHttp, DigestHttpOptions } from './DigestHttp';
import {
  HikEvent, MOTION_EVENTS, TAMPER_EVENTS, TRIGGER_CARDS,
} from './events';

/**
 * Minimal typings for the video API (Homey >= 12.7.0). It is missing from the
 * bundled SDK types and absent at runtime on older firmware, so it is always
 * feature-detected before use.
 */
interface HomeyVideo {
  registerVideoUrlListener(listener: () => Promise<{ url: string }>): unknown;
  unregister(): Promise<void>;
}

interface HomeyVideosManager {
  createVideoRTSP(options?: {
    acceptInvalidCertificates?: boolean;
    demuxer?: string;
    disableWebRTCProxy?: boolean;
  }): Promise<HomeyVideo>;
}

interface VideoCapableDevice {
  setCameraVideo?(id: string, title: string, video: HomeyVideo): Promise<unknown>;
}

// Image and video share one id, so Homey shows the snapshot as the
// background while the live stream is loading.
const PREVIEW_ID = 'live';

// Cleared app-wide once Homey reports it cannot stream video, so remaining
// devices skip the attempt instead of each logging the same failure.
let videoSupported = true;

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
  private snapshotImage: Homey.Image | null = null;
  private liveVideo: HomeyVideo | null = null;

  async onInit() {
    this.connect();
    this.setupPreview().catch(this.error);
    this.log(`${this.getName()} initialized (channel ${this.getChannel()})`);
  }

  /**
   * Register the camera preview: a JPEG snapshot (every Homey version) and,
   * when the firmware supports it, a live RTSP stream. Both sources read the
   * current settings on every request, so they never need re-registering
   * after a settings change.
   */
  private async setupPreview(): Promise<void> {
    const title = this.homey.__('device.preview_title');

    try {
      const image = await this.homey.images.createImage();
      image.setStream((stream: NodeJS.WritableStream) => this.pipeSnapshot(stream));
      await this.setCameraImage(PREVIEW_ID, title, image);
      this.snapshotImage = image;
    } catch (err) {
      this.error('Failed to register camera snapshot:', err);
    }

    const { videos } = this.homey as unknown as { videos?: HomeyVideosManager };
    const device = this as unknown as VideoCapableDevice;
    if (!videos || typeof device.setCameraVideo !== 'function') {
      // Firmware older than v12.7.0: no video API at all.
      this.markVideoUnsupported('no video API in this Homey version');
      return;
    }
    if (!videoSupported) return;

    let video: HomeyVideo;
    try {
      video = await videos.createVideoRTSP();
    } catch (err) {
      // The API can exist on hardware that cannot stream (only Homey Pro
      // 2023+ and Homey Pro mini can); Homey then throws "Videos are not
      // supported on this Homey". Expected, not an error.
      this.markVideoUnsupported(err instanceof Error ? err.message : String(err));
      return;
    }

    try {
      video.registerVideoUrlListener(async () => ({ url: this.rtspUrl() }));
      await device.setCameraVideo(PREVIEW_ID, title, video);
      this.liveVideo = video;
    } catch (err) {
      this.error('Failed to register live video:', err);
      video.unregister().catch(() => undefined);
    }
  }

  private markVideoUnsupported(reason: string): void {
    if (!videoSupported) return;
    videoSupported = false;
    this.log(`Live video unavailable (${reason}), camera preview shows snapshots only`);
  }

  private async pipeSnapshot(stream: NodeJS.WritableStream): Promise<void> {
    const opts = this.connectionOptions();
    if (!opts.host) throw new Error(this.homey.__('device.no_address'));

    // Channel N, main stream → streaming channel N01 (full-resolution JPEG).
    const path = `/ISAPI/Streaming/channels/${this.getChannel() * 100 + 1}/picture`;
    const res = await new DigestHttp(opts).open('GET', path, 10000);
    // An unhandled 'error' on the response would crash the whole app.
    res.on('error', (err: Error) => this.error('Snapshot transfer failed:', err.message));
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`Snapshot request failed (HTTP ${res.statusCode})`);
    }
    res.pipe(stream);
  }

  private rtspUrl(): string {
    const opts = this.connectionOptions();
    if (!opts.host) throw new Error(this.homey.__('device.no_address'));

    const port = Number(this.getSetting('rtsp_port')) || 554;
    const streamType = this.getSetting('video_stream') === 'main' ? 1 : 2;
    const auth = opts.username
      ? `${encodeURIComponent(opts.username)}:${encodeURIComponent(opts.password)}@`
      : '';
    return `rtsp://${auth}${opts.host}:${port}/Streaming/Channels/${this.getChannel() * 100 + streamType}`;
  }

  private teardownPreview(): void {
    if (this.snapshotImage) {
      this.snapshotImage.unregister().catch(this.error);
      this.snapshotImage = null;
    }
    if (this.liveVideo) {
      this.liveVideo.unregister().catch(this.error);
      this.liveVideo = null;
    }
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

    // Let open device views fetch a fresh frame showing the event.
    if (this.snapshotImage) {
      this.snapshotImage.update().catch((err: Error) => this.error('Failed to refresh snapshot:', err));
    }

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
    this.teardownPreview();
  }

  async onUninit() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.disconnect();
  }

};
