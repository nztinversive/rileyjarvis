"use strict";

const crypto = require("node:crypto");

function createSafetyIdentifier(subject, secret) {
  const digest = crypto.createHmac("sha256", secret).update(subject, "utf8").digest("hex");
  return `vector_${digest}`;
}

module.exports = {
  createSafetyIdentifier,
};
