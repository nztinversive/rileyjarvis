"use strict";

function createInMemoryRateLimiter({ max, windowMs, clock = Date.now }) {
  const subjects = new Map();

  return {
    consume(subject) {
      const now = clock();
      const current = subjects.get(subject);
      if (!current || now >= current.resetAt) {
        const next = { count: 1, resetAt: now + windowMs };
        subjects.set(subject, next);
        return { allowed: true, remaining: max - 1, resetAt: next.resetAt };
      }
      if (current.count >= max) {
        return { allowed: false, remaining: 0, resetAt: current.resetAt };
      }
      current.count += 1;
      return { allowed: true, remaining: max - current.count, resetAt: current.resetAt };
    },
  };
}

module.exports = {
  createInMemoryRateLimiter,
};
