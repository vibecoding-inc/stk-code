import test from "node:test";
import assert from "node:assert/strict";
import { create_lan_bridge, resolve_ws_url } from "../lan-bridge.js";

class MockWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.binaryType = "";
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    MockWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, event = {}) {
    for (let fn of this.listeners.get(type) || []) {
      fn(event);
    }
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
}

test("resolve_ws_url handles absolute and relative URLs", () => {
  assert.equal(resolve_ws_url("wss://example.com/api/lan", null), "wss://example.com/api/lan");
  assert.equal(
    resolve_ws_url("/api/lan", {protocol: "https:", host: "123.discordsays.com"}),
    "wss://123.discordsays.com/api/lan"
  );
  assert.equal(
    resolve_ws_url("api/lan", {protocol: "http:", host: "localhost:8080"}),
    "ws://localhost:8080/api/lan"
  );
  assert.equal(resolve_ws_url("", {protocol: "https:", host: "a"}), null);
});

test("create_lan_bridge authenticates, flushes buffered sends, and receives binary frames", () => {
  MockWebSocket.instances = [];
  let heap = new Uint8Array(64);
  heap.set([1, 2, 3, 4], 10);

  let bridge = create_lan_bridge({
    get_url: () => "wss://123.discordsays.com/api/lan",
    get_credentials: () => ({access_token: "tok-abc", instance_id: "i-1-gc-2-3"}),
    get_heap_u8: () => heap,
    WebSocketImpl: MockWebSocket,
    logger: {log() {}, warn() {}},
  });

  assert.equal(bridge.isAvailable(), true);
  bridge.open(10000);
  assert.equal(MockWebSocket.instances.length, 1);

  let sock = MockWebSocket.instances[0];
  assert.equal(sock.url, "wss://123.discordsays.com/api/lan");
  assert.equal(sock.binaryType, "arraybuffer");

  // Send while still CONNECTING: should buffer, not send yet.
  assert.equal(bridge.send(10000, 10, 4), 4);
  assert.equal(sock.sent.length, 0);

  // Open socket: sends JSON auth handshake frame first.
  sock.readyState = 1;
  sock.emit("open");
  assert.equal(sock.sent.length, 1);
  assert.deepEqual(JSON.parse(sock.sent[0]), {
    access_token: "tok-abc",
    instance_id: "i-1-gc-2-3",
  });

  // Gateway replies ok: true -> flushes buffered binary packet.
  sock.emit("message", {data: JSON.stringify({ok: true, instance_id: "i-1-gc-2-3"})});
  assert.equal(sock.sent.length, 2);
  assert.deepEqual(Array.from(sock.sent[1]), [1, 2, 3, 4]);

  // Incoming binary ENet packet -> queued and read into heap.
  let incoming = new Uint8Array([9, 8, 7]).buffer;
  sock.emit("message", {data: incoming});
  assert.equal(bridge.hasPending(10000), true);
  assert.equal(bridge.recv(10000, 20, 16), 3);
  assert.deepEqual(Array.from(heap.slice(20, 23)), [9, 8, 7]);
  assert.equal(bridge.hasPending(10000), false);

  bridge.close(10000);
  assert.equal(sock.closed, true);
});

test("create_lan_bridge closes socket on auth rejection", () => {
  MockWebSocket.instances = [];
  let heap = new Uint8Array(16);
  let bridge = create_lan_bridge({
    get_url: () => "wss://123.discordsays.com/api/lan",
    get_credentials: () => ({access_token: "bad", instance_id: "i-1-gc-2-3"}),
    get_heap_u8: () => heap,
    WebSocketImpl: MockWebSocket,
    logger: {log() {}, warn() {}},
  });

  bridge.open(10001);
  let sock = MockWebSocket.instances[0];
  sock.readyState = 1;
  sock.emit("open");
  sock.emit("message", {data: JSON.stringify({ok: false, error: "user_not_in_instance"})});
  assert.equal(sock.closed, true);
});

test("preconnect emits starting_server status and resolves on ok:true", async () => {
  MockWebSocket.instances = [];
  let heap = new Uint8Array(16);
  let statuses = [];
  let bridge = create_lan_bridge({
    get_url: () => "wss://123.discordsays.com/api/lan",
    get_credentials: () => ({access_token: "tok", instance_id: "i-1-gc-2-3"}),
    get_heap_u8: () => heap,
    WebSocketImpl: MockWebSocket,
    logger: {log() {}, warn() {}},
  });

  let promise = bridge.preconnect({on_status: (s) => statuses.push(s)});
  let sock = MockWebSocket.instances[0];
  sock.readyState = 1;
  sock.emit("open");
  sock.emit("message", {data: JSON.stringify({status: "starting_server"})});
  assert.equal(sock.closed, false);
  sock.emit("message", {data: JSON.stringify({ok: true, instance_id: "i-1-gc-2-3"})});
  await promise;

  assert.deepEqual(statuses, ["connecting", "authenticating", "starting_server", "ready"]);
});

test("reconnect closes stale socket, clears rx_queue, and establishes a fresh connection", async () => {
  MockWebSocket.instances = [];
  let heap = new Uint8Array(16);
  let statuses = [];
  let bridge = create_lan_bridge({
    get_url: () => "wss://123.discordsays.com/api/lan",
    get_credentials: () => ({access_token: "tok", instance_id: "i-1-gc-2-3"}),
    get_heap_u8: () => heap,
    WebSocketImpl: MockWebSocket,
    logger: {log() {}, warn() {}},
  });

  let p1 = bridge.preconnect();
  let sock1 = MockWebSocket.instances[0];
  sock1.readyState = 1;
  sock1.emit("open");
  sock1.emit("message", {data: JSON.stringify({ok: true, instance_id: "i-1-gc-2-3"})});
  await p1;

  // Queue a stale incoming datagram and check getState().
  sock1.emit("message", {data: new Uint8Array([42]).buffer});
  assert.equal(bridge.hasPending(1), true);
  assert.equal(bridge.getState().connected, true);

  let p2 = bridge.reconnect({on_status: (s) => statuses.push(s)});
  assert.equal(sock1.closed, true);
  assert.equal(bridge.hasPending(1), false);
  assert.equal(MockWebSocket.instances.length, 2);

  let sock2 = MockWebSocket.instances[1];
  sock2.readyState = 1;
  sock2.emit("open");
  sock2.emit("message", {data: JSON.stringify({status: "waiting_for_server"})});
  sock2.emit("message", {data: JSON.stringify({ok: true, instance_id: "i-1-gc-2-3"})});
  await p2;

  assert.deepEqual(statuses, ["connecting", "authenticating", "waiting_for_server", "ready"]);
  assert.equal(bridge.getState().connected, true);

  // Close with code/reason updates getState() diagnostics.
  sock2.readyState = 3;
  sock2.emit("close", {code: 1006, reason: "server_restarted"});
  let st = bridge.getState();
  assert.equal(st.connected, false);
  assert.equal(st.lastCloseCode, 1006);
  assert.equal(st.lastCloseReason, "server_restarted");
});
