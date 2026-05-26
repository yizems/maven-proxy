const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function parseDurationToMs(raw, fallbackMs) {
  const text = String(raw || "").trim();
  if (!text) {
    return fallbackMs;
  }

  const match = text.match(/^(\d+)([smhd])$/i);
  if (!match) {
    return fallbackMs;
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value < 0) {
    return fallbackMs;
  }

  if (unit === "s") {
    return value * SECOND_MS;
  }
  if (unit === "m") {
    return value * MINUTE_MS;
  }
  if (unit === "h") {
    return value * HOUR_MS;
  }

  return value * DAY_MS;
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value < 0) {
    return "0B";
  }

  if (value >= 1024 ** 4) {
    return `${(value / (1024 ** 4)).toFixed(2)}TB`;
  }
  if (value >= 1024 ** 3) {
    return `${(value / (1024 ** 3)).toFixed(2)}GB`;
  }
  if (value >= 1024 ** 2) {
    return `${(value / (1024 ** 2)).toFixed(2)}MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)}KB`;
  }

  return `${Math.floor(value)}B`;
}

export default { parseDurationToMs, formatBytes };
