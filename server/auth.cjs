"use strict";

const crypto = require("node:crypto");

function createBootstrapAuthenticator(authTokens) {
  const records = authTokens.map(({ subject, token }) => ({
    subject,
    digest: digestToken(token),
  }));

  return {
    authenticate(request) {
      const token = parseBearerToken(request.headers.authorization);
      if (!token) return null;

      const candidate = digestToken(token);
      let authenticatedSubject = null;
      for (const record of records) {
        const matches = crypto.timingSafeEqual(candidate, record.digest);
        if (matches) authenticatedSubject = record.subject;
      }
      return authenticatedSubject ? { subject: authenticatedSubject } : null;
    },
  };
}

function parseBearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? match[1] : null;
}

function digestToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

module.exports = {
  createBootstrapAuthenticator,
  parseBearerToken,
};
