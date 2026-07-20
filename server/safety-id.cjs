"use strict";

const crypto = require("node:crypto");

function createSafetyIdentifier(subject, secret) {
  return crypto.createHmac("sha256", secret).update(subject, "utf8").digest("hex");
}

module.exports = {
  createSafetyIdentifier,
};
