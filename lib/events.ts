'use strict';

/**
 * Normalization of Hikvision ISAPI eventType values. Different firmware
 * generations report the same detection under different names (e.g. motion
 * is "VMD" on most devices but "motiondetection" or "PIR" on others), so
 * everything is lower-cased and mapped onto a stable set of keys that the
 * rest of the app (capabilities, Flow cards) works with.
 */

export interface HikEvent {
  /** Normalized event key, e.g. 'motion', 'linecrossing', 'intrusion'. */
  type: string;
  /** Raw eventType string exactly as reported by the device. */
  rawType: string;
  /** 1-based channel number (dynChannelID preferred, then channelID). */
  channel: number;
  /** true while the event is active, false when the device reports it ended. */
  active: boolean;
  /** Optional human-readable description from the device. */
  description: string;
}

const ALIASES: { [raw: string]: string } = {
  vmd: 'motion',
  motiondetection: 'motion',
  pir: 'motion',
  linedetection: 'linecrossing',
  linecrossing: 'linecrossing',
  fielddetection: 'intrusion',
  intrusiondetection: 'intrusion',
  regionentrance: 'regionentrance',
  regionexiting: 'regionexiting',
  shelteralarm: 'tamper',
  tamperdetection: 'tamper',
  scenechangedetection: 'scenechange',
  facedetection: 'facedetection',
  videoloss: 'videoloss',
};

export function normalizeEventType(rawType: string): string {
  const key = String(rawType || '').toLowerCase();
  return ALIASES[key] || key;
}

/** Normalized event keys that should raise the motion alarm capability. */
export const MOTION_EVENTS = ['motion'];

/** Normalized event keys that should raise the tamper alarm capability. */
export const TAMPER_EVENTS = ['tamper'];

/**
 * Normalized event keys that count as "smart events" and raise the generic
 * alarm capability. Any VCA event that is not motion/tamper/videoloss also
 * falls into this bucket at runtime.
 */
export const SMART_EVENTS = [
  'linecrossing',
  'intrusion',
  'regionentrance',
  'regionexiting',
  'scenechange',
  'facedetection',
  'loitering',
  'group',
  'rapidmove',
  'parking',
  'unattendedbaggage',
  'attendedbaggage',
];

/** Normalized event key → dedicated Flow trigger card id. */
export const TRIGGER_CARDS: { [type: string]: string } = {
  motion: 'motion_detected',
  linecrossing: 'line_crossing',
  intrusion: 'intrusion',
  regionentrance: 'region_entrance',
  regionexiting: 'region_exiting',
};
