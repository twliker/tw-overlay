import * as crypto from 'crypto';

const GA_CLIENT_ID_PATTERN = /^[1-9]\d*\.[1-9]\d*$/;
const GA_CLIENT_ID_RANDOM_MAX = 2_147_483_647;
const GA_EVENT_NAME_MAX_LENGTH = 40;
const GA_EVENT_PARAM_STRING_MAX_LENGTH = 100;

export interface NormalizedGaClientId {
  clientId: string;
  migrated: boolean;
}

export function isValidGaClientId(value: unknown): value is string {
  return typeof value === 'string' && GA_CLIENT_ID_PATTERN.test(value);
}

export function createGaClientId(
  now: number = Date.now(),
  randomPart: number = crypto.randomInt(1, GA_CLIENT_ID_RANDOM_MAX),
): string {
  const timestampSeconds = Math.max(1, Math.floor(now / 1000));
  const normalizedRandomPart = Math.min(
    GA_CLIENT_ID_RANDOM_MAX - 1,
    Math.max(1, Math.floor(randomPart)),
  );

  return `${normalizedRandomPart}.${timestampSeconds}`;
}

export function normalizeGaClientId(
  savedClientId: unknown,
  now: number = Date.now(),
  randomPart?: number,
): NormalizedGaClientId {
  if (isValidGaClientId(savedClientId)) {
    return {
      clientId: savedClientId,
      migrated: false,
    };
  }

  return {
    clientId: createGaClientId(now, randomPart),
    migrated: typeof savedClientId === 'string' && savedClientId.length > 0,
  };
}

export function normalizeGaEventName(eventName: string): string {
  const normalizedName = eventName
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const nameWithValidPrefix = /^[\p{L}]/u.test(normalizedName)
    ? normalizedName
    : `event_${normalizedName || 'unknown'}`;

  return Array.from(nameWithValidPrefix)
    .slice(0, GA_EVENT_NAME_MAX_LENGTH)
    .join('');
}

export function normalizeGaEventParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? Array.from(value).slice(0, GA_EVENT_PARAM_STRING_MAX_LENGTH).join('')
        : value,
    ]),
  );
}
