const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const { VectorRealtimeClient } = loadTypeScriptModule("../src/lib/realtime.ts");

test("Realtime setup prepares native audio, acquires a live microphone before minting, and rejects duplicate connects", async () => {
  const order = [];
  const credential = { value: "short-lived-secret", expiresAt: 2_000_000_000 };
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const peer = new FakePeerConnection();
  const audio = new FakeAudio();
  const callbacks = callbackRecorder();
  let audioElements = 0;

  const client = new VectorRealtimeClient(
    platform({
      voiceSession: {
        async prepare() {
          order.push("audio-session");
          return { route: "speaker" };
        },
        async deactivate() {
          order.push("deactivate");
        },
        subscribe() {
          return () => {};
        },
      },
      async listToolSpecs() {
        order.push("tools");
        return [];
      },
      async createRealtimeCredential() {
        order.push("credential");
        return credential;
      },
    }),
    callbacks.value,
    dependencies({
      peer,
      stream,
      audioFactory() {
        audioElements += 1;
        return audio;
      },
      async fetchImpl(_url, init) {
        order.push("sdp");
        assert.match(init.headers.Authorization, /^Bearer short-lived-secret$/);
        return new Response("answer-sdp", { status: 200 });
      },
      getUserMedia: async () => {
        order.push("microphone");
        return stream;
      },
    }),
  );

  await client.connect();
  assert.deepEqual(order.slice(0, 5), ["audio-session", "microphone", "tools", "credential", "sdp"]);
  assert.equal(credential.value, "");
  assert.equal(peer.addedTrack, track);
  assert.equal(audioElements, 1);

  peer.dataChannel.open();
  assert.equal(callbacks.states.at(-1), "connected");
  await client.connect();
  assert.equal(audioElements, 1);
  assert.match(callbacks.statuses.at(-1), /already connected/);

  client.disconnect();
  await tick();
  assert.equal(track.stopped, true);
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.srcObject, null);
  assert.equal(audio.removeCalls, 1);
  assert.equal(order.at(-1), "deactivate");
});

test("Realtime preserves Electron credential-first setup while applying native permission-first setup", async () => {
  const order = [];
  const peer = new FakePeerConnection();
  const client = new VectorRealtimeClient(
    platform({
      presentation: "desktop",
      async listToolSpecs() {
        order.push("tools");
        return [];
      },
      async createRealtimeCredential() {
        order.push("credential");
        return { value: "desktop-ephemeral", expiresAt: 2_000_000_000 };
      },
    }),
    callbackRecorder().value,
    dependencies({
      peer,
      getUserMedia: async () => {
        order.push("microphone");
        return new FakeStream([new FakeTrack()]);
      },
      fetchImpl: async () => {
        order.push("sdp");
        return new Response("answer-sdp", { status: 200 });
      },
    }),
  );

  await client.connect();
  assert.deepEqual(order.slice(0, 4), ["tools", "credential", "microphone", "sdp"]);
  client.disconnect();
});

test("Realtime rejects a missing live audio track before requesting a credential", async () => {
  const stream = new FakeStream([]);
  const callbacks = callbackRecorder();
  let credentials = 0;
  let peerConnections = 0;

  const client = new VectorRealtimeClient(
    platform({
      async createRealtimeCredential() {
        credentials += 1;
        return { value: "must-not-be-used", expiresAt: 2_000_000_000 };
      },
    }),
    callbacks.value,
    dependencies({
      stream,
      createPeerConnection() {
        peerConnections += 1;
        return new FakePeerConnection();
      },
    }),
  );

  await client.connect();
  assert.equal(credentials, 0);
  assert.equal(peerConnections, 0);
  assert.deepEqual(callbacks.states, ["connecting", "error"]);
  assert.match(callbacks.statuses.at(-1), /No microphone input is available/);
});

test("Realtime clears and rejects an expired credential without creating a peer connection", async () => {
  const credential = { value: "expired-secret", expiresAt: 105 };
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const callbacks = callbackRecorder();
  let peerConnections = 0;

  const client = new VectorRealtimeClient(
    platform({
      async createRealtimeCredential() {
        return credential;
      },
    }),
    callbacks.value,
    dependencies({
      stream,
      now: () => 100_001,
      createPeerConnection() {
        peerConnections += 1;
        return new FakePeerConnection();
      },
    }),
  );

  await client.connect();
  assert.equal(credential.value, "");
  assert.equal(peerConnections, 0);
  assert.equal(track.stopped, true);
  assert.match(callbacks.statuses.at(-1), /credential expired/);
});

test("native microphone denial uses fixed Settings guidance without exposing plugin details", async () => {
  const callbacks = callbackRecorder();
  const nativeError = new Error("private native permission diagnostic");
  nativeError.code = "MICROPHONE_PERMISSION_RESTRICTED";
  const client = new VectorRealtimeClient(
    platform({
      voiceSession: {
        async prepare() {
          throw nativeError;
        },
        async deactivate() {},
        subscribe() {
          return () => {};
        },
      },
    }),
    callbacks.value,
    dependencies(),
  );

  await client.connect();
  assert.match(callbacks.statuses.at(-1), /Settings > Privacy & Security > Microphone/);
  assert.doesNotMatch(callbacks.statuses.join(" "), /private native|diagnostic/);
});

test("disconnect aborts stale credential setup without surfacing transport or credential details", async () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const callbacks = callbackRecorder();
  let observedSignal;
  let peerConnections = 0;

  const client = new VectorRealtimeClient(
    platform({
      createRealtimeCredential(options) {
        observedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("private-bootstrap-token transport detail")));
        });
      },
    }),
    callbacks.value,
    dependencies({
      stream,
      createPeerConnection() {
        peerConnections += 1;
        return new FakePeerConnection();
      },
    }),
  );

  const connecting = client.connect();
  await tick();
  client.disconnect();
  await connecting;

  assert.equal(observedSignal.aborted, true);
  assert.equal(peerConnections, 0);
  assert.equal(track.stopped, true);
  assert.deepEqual(callbacks.states, ["connecting", "idle"]);
  assert.doesNotMatch(callbacks.statuses.join(" "), /private-bootstrap-token|transport detail/);
});

test("SDP rejection and timeout expose only bounded sanitized diagnostics", async (t) => {
  await t.test("HTTP rejection never reads or reports the response body", async () => {
    const callbacks = callbackRecorder();
    let bodyRead = false;
    const client = connectedClient(callbacks, {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        async text() {
          bodyRead = true;
          return "private-credential and sdp";
        },
      }),
    });

    await client.connect();
    assert.equal(bodyRead, false);
    assert.match(callbacks.statuses.at(-1), /HTTP 401/);
    assert.doesNotMatch(callbacks.statuses.join(" "), /private-credential|sdp/);
  });

  await t.test("a bounded request abort reports a generic timeout", async () => {
    const callbacks = callbackRecorder();
    const client = connectedClient(callbacks, {
      sdpTimeoutMs: 5,
      fetchImpl(_url, init) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("secret SDP timeout detail")));
        });
      },
    });

    await client.connect();
    assert.match(callbacks.statuses.at(-1), /connection timed out/);
    assert.doesNotMatch(callbacks.statuses.join(" "), /secret SDP|detail/);
  });

  await t.test("the same deadline bounds reading the SDP response body", async () => {
    const callbacks = callbackRecorder();
    let requestSignal;
    const client = connectedClient(callbacks, {
      sdpTimeoutMs: 5,
      async fetchImpl(_url, init) {
        requestSignal = init.signal;
        return {
          ok: true,
          status: 200,
          text() {
            return new Promise((_resolve, reject) => {
              requestSignal.addEventListener("abort", () => reject(new Error("private response-body detail")));
            });
          },
        };
      },
    });

    await client.connect();
    assert.equal(requestSignal.aborted, true);
    assert.match(callbacks.statuses.at(-1), /connection timed out/);
    assert.doesNotMatch(callbacks.statuses.join(" "), /private response-body|detail/);
  });

  await t.test("an oversized SDP answer is rejected without parsing", async () => {
    const callbacks = callbackRecorder();
    const client = connectedClient(callbacks, {
      fetchImpl: async () => new Response("x".repeat(256_001), { status: 200 }),
    });

    await client.connect();
    assert.match(callbacks.statuses.at(-1), /unusable connection response/);
  });
});

test("remote output uses one audio element and offline teardown permits a fresh explicit reconnect", async () => {
  const callbacks = callbackRecorder();
  const onlineEvents = new EventTarget();
  const peers = [];
  const audios = [];
  const tracks = [];
  let credentials = 0;
  const client = new VectorRealtimeClient(
    platform({
      async createRealtimeCredential() {
        credentials += 1;
        return { value: `ephemeral-${credentials}`, expiresAt: 2_000_000_000 };
      },
    }),
    callbacks.value,
    {
      getUserMedia: async () => {
        const track = new FakeTrack();
        tracks.push(track);
        return new FakeStream([track]);
      },
      createPeerConnection() {
        const peer = new FakePeerConnection();
        peers.push(peer);
        return peer;
      },
      createAudioElement() {
        const audio = new FakeAudio();
        audios.push(audio);
        return audio;
      },
      createMediaStream: (streamTracks) => new FakeStream(streamTracks),
      createAudioContext: () => new FakeAudioContext(),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      onlineEvents,
      isOnline: () => true,
      fetchImpl: async () => new Response("answer-sdp", { status: 200 }),
      now: () => 1_000,
    },
  );

  await client.connect();
  peers[0].dataChannel.open();
  const remoteOne = new FakeStream([new FakeTrack()]);
  const remoteTwo = new FakeStream([new FakeTrack()]);
  peers[0].dispatchTrack(remoteOne);
  peers[0].dispatchTrack(remoteTwo);
  assert.equal(audios.length, 1);
  assert.equal(audios[0].srcObject, remoteTwo);

  onlineEvents.dispatchEvent(new Event("offline"));
  assert.equal(callbacks.states.at(-1), "error");
  assert.equal(tracks[0].stopped, true);
  assert.equal(audios[0].removeCalls, 1);

  await client.connect();
  peers[1].dataChannel.open();
  assert.equal(credentials, 2);
  assert.equal(audios.length, 2);
  assert.equal(callbacks.states.at(-1), "connected");
  client.disconnect();
});

test("typed prompts use the live data channel and remain blocked after teardown", async () => {
  const callbacks = callbackRecorder();
  const peer = new FakePeerConnection();
  const client = connectedClient(callbacks, { peer });

  await client.connect();
  peer.dataChannel.open();
  client.sendText("typed in the live session");

  assert.deepEqual(
    peer.dataChannel.sent.map((value) => JSON.parse(value).type),
    ["conversation.item.create", "response.create"],
  );

  client.disconnect();
  const sentBeforeDisconnectedPrompt = peer.dataChannel.sent.length;
  client.sendText("must remain in the composer");
  assert.equal(peer.dataChannel.sent.length, sentBeforeDisconnectedPrompt);
  assert.match(callbacks.statuses.at(-1), /Connect Vector before sending/);
});

test("remote playback failure tears down while output-meter failure leaves audible playback intact", async (t) => {
  await t.test("playback rejection fails the active session", async () => {
    const callbacks = callbackRecorder();
    const peer = new FakePeerConnection();
    const audio = new FakeAudio(true);
    const client = new VectorRealtimeClient(
      platform(),
      callbacks.value,
      dependencies({
        peer,
        audioFactory: () => audio,
        createAudioContext: () => new FakeAudioContext(),
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
      }),
    );

    await client.connect();
    peer.dataChannel.open();
    peer.dispatchTrack(new FakeStream([new FakeTrack()]));
    await tick();
    assert.equal(callbacks.states.at(-1), "error");
    assert.match(callbacks.statuses.at(-1), /Remote audio could not start/);
    assert.equal(audio.removeCalls, 1);
  });

  await t.test("visualizer setup is optional and does not tear down remote audio", async () => {
    const callbacks = callbackRecorder();
    const peer = new FakePeerConnection();
    const audio = new FakeAudio();
    const client = new VectorRealtimeClient(
      platform(),
      callbacks.value,
      dependencies({
        peer,
        audioFactory: () => audio,
        createAudioContext() {
          throw new Error("visualizer unavailable");
        },
      }),
    );

    await client.connect();
    peer.dataChannel.open();
    peer.dispatchTrack(new FakeStream([new FakeTrack()]));
    await tick();
    assert.equal(callbacks.states.at(-1), "connected");
    assert.equal(audio.removeCalls, 0);
    client.disconnect();
  });
});

test("Realtime bounds data-channel readiness and sanitizes server error payloads", async (t) => {
  await t.test("data channel must open before the post-SDP deadline", async () => {
    const callbacks = callbackRecorder();
    const client = connectedClient(callbacks, { connectionTimeoutMs: 5 });
    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(callbacks.states.at(-1), "error");
    assert.match(callbacks.statuses.at(-1), /did not become ready in time/);
  });

  await t.test("server error text is never copied to status diagnostics", async () => {
    const callbacks = callbackRecorder();
    const peer = new FakePeerConnection();
    const client = connectedClient(callbacks, { peer });
    await client.connect();
    peer.dataChannel.open();
    peer.dataChannel.message(
      JSON.stringify({ type: "error", error: { message: "ephemeral-secret raw server diagnostic" } }),
    );
    await tick();
    assert.match(callbacks.statuses.at(-1), /session reported an error/);
    assert.doesNotMatch(callbacks.statuses.join(" "), /ephemeral-secret|raw server diagnostic/);
    client.disconnect();
  });
});

function connectedClient(callbacks, overrides = {}) {
  const stream = new FakeStream([new FakeTrack()]);
  return new VectorRealtimeClient(
    platform(),
    callbacks.value,
    dependencies({
      stream,
      ...overrides,
    }),
  );
}

function platform(overrides = {}) {
  return {
    presentation: "native-mobile",
    async createRealtimeCredential() {
      return { value: "ephemeral-value", expiresAt: 2_000_000_000 };
    },
    async executeTool() {
      return { ok: true };
    },
    async listToolSpecs() {
      return [];
    },
    ...overrides,
  };
}

function dependencies(options = {}) {
  const peer = options.peer ?? new FakePeerConnection();
  const stream = options.stream ?? new FakeStream([new FakeTrack()]);
  const audio = new FakeAudio();
  return {
    createPeerConnection: options.createPeerConnection ?? (() => peer),
    getUserMedia: options.getUserMedia ?? (async () => stream),
    createAudioElement: options.audioFactory ?? (() => audio),
    createMediaStream: (tracks) => new FakeStream(tracks),
    onlineEvents: new EventTarget(),
    isOnline: () => true,
    fetchImpl: options.fetchImpl ?? (async () => new Response("answer-sdp", { status: 200 })),
    now: options.now ?? (() => 1_000),
    sdpTimeoutMs: options.sdpTimeoutMs,
    connectionTimeoutMs: options.connectionTimeoutMs,
    createAudioContext: options.createAudioContext,
    requestAnimationFrame: options.requestAnimationFrame,
    cancelAnimationFrame: options.cancelAnimationFrame,
  };
}

function callbackRecorder() {
  const states = [];
  const statuses = [];
  const moods = [];
  return {
    states,
    statuses,
    moods,
    value: {
      onConnectionState: (state) => states.push(state),
      onMood: (mood) => moods.push(mood),
      onMouthShape() {},
      onTranscript() {},
      onArtifact() {},
      onMode() {},
      onStatus: (status) => statuses.push(status),
      onThumbnailReady() {},
    },
  };
}

class FakeTrack extends EventTarget {
  constructor() {
    super();
    this.readyState = "live";
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(tracks) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks;
  }
}

class FakeDataChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = "connecting";
    this.sent = [];
  }

  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  send(value) {
    this.sent.push(value);
  }

  message(value) {
    const event = new Event("message");
    event.data = value;
    this.dispatchEvent(event);
  }

  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection extends EventTarget {
  constructor() {
    super();
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.dataChannel = new FakeDataChannel();
    this.addedTrack = null;
    this.closed = false;
  }

  addTrack(track) {
    this.addedTrack = track;
  }

  createDataChannel() {
    return this.dataChannel;
  }

  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription() {}

  async setRemoteDescription() {}

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }

  dispatchTrack(stream) {
    const event = new Event("track");
    event.streams = [stream];
    event.track = stream.getAudioTracks()[0];
    this.dispatchEvent(event);
  }
}

class FakeAudio {
  constructor(rejectPlayback = false) {
    this.autoplay = false;
    this.srcObject = null;
    this.style = {};
    this.pauseCalls = 0;
    this.removeCalls = 0;
    this.attributes = new Map();
    this.rejectPlayback = rejectPlayback;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  async play() {
    if (this.rejectPlayback) throw new Error("private playback diagnostic");
  }

  pause() {
    this.pauseCalls += 1;
  }

  load() {}

  remove() {
    this.removeCalls += 1;
  }
}

class FakeAudioContext {
  constructor() {
    this.destination = {};
  }

  createMediaStreamSource() {
    return { connect() {} };
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 32,
      getByteTimeDomainData(values) {
        values.fill(128);
      },
      getByteFrequencyData(values) {
        values.fill(0);
      },
    };
  }

  async close() {}
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadTypeScriptModule(relativePath) {
  const filename = path.resolve(__dirname, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(output, filename);
  return loaded.exports;
}
