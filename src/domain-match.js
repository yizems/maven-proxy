function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .split("*")
    .map((segment) => escapeRegExp(segment))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesDomain(hostname, patterns) {
  if (!hostname || !patterns || patterns.length === 0) {
    return false;
  }

  const host = hostname.toLowerCase();

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim().toLowerCase();
    if (!pattern) {
      continue;
    }

    if (pattern.includes("*")) {
      if (wildcardToRegExp(pattern).test(host)) {
        return true;
      }
      continue;
    }

    if (host === pattern || host.endsWith(`.${pattern}`)) {
      return true;
    }
  }

  return false;
}
