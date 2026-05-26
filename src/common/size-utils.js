export function parseSizeToBytes(raw, fallbackBytes = 0) {
  const text = String(raw || "").trim();
  if (!text) {
    return fallbackBytes;
  }

  const match = text.match(/^(\d+)([KMGT]?)$/i);
  if (!match) {
    return fallbackBytes;
  }

  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value) || value < 0) {
    return fallbackBytes;
  }

  const unit = String(match[2] || "").toUpperCase();
  const unitPow = {
    "": 0,
    K: 1,
    M: 2,
    G: 3,
    T: 4,
  }[unit];

  if (unitPow == null) {
    return fallbackBytes;
  }

  return value * (1024 ** unitPow);
}

export default { parseSizeToBytes };
