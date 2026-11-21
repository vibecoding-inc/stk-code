const MAX_RX_QUEUE = 256;
const MAX_TX_PENDING = 32;

export function resolve_ws_url(configured_url, location_obj) {
  if (!configured_url || typeof configured_url !== "string") {
    return null;
  }
  let trimmed = configured_url.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) {
    return trimmed;
  }
  if (!location_obj || !location_obj.host) {
    return null;
  }
  let proto = location_obj.protocol === "https:" ? "wss:" : "ws:";
  let path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${proto}//${location_obj.host}${path}`;
}

export function create_lan_bridge({
  get_url,
  get_credentials,
  get_heap_u8,
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
}) {
  let ws = null;
  let ready = false;
  let active_sockets = new Set();
  let rx_queue = [];
  let tx_pending = [];
  let ready_waiters = [];
  let status_listeners = [];

  function emit_status(status) {
    for (let fn of status_listeners) {
      try {
        fn(status);
      }
      catch {}
    }
  }

  function settle_waiters(err) {
    let waiters = ready_waiters;
    ready_waiters = [];
    for (let w of waiters) {
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  function isAvailable() {
    let url = get_url();
    let creds = get_credentials();
    return Boolean(
      url &&
      creds &&
      creds.access_token &&
      creds.instance_id &&
      typeof WebSocketImpl === "function"
    );
  }

  function reset_socket_state(err = null) {
    ws = null;
    ready = false;
    tx_pending = [];
    if (err) {
      settle_waiters(err);
    }
  }

  function ensure_connected() {
    if (ws) {
      return true;
    }
    if (!isAvailable()) {
      return false;
    }
    let url = get_url();
    let creds = get_credentials();
    try {
      emit_status("connecting");
      let socket = new WebSocketImpl(url);
      socket.binaryType = "arraybuffer";
      ws = socket;
      ready = false;

      socket.addEventListener("open", () => {
        if (ws !== socket) return;
        emit_status("authenticating");
        try {
          socket.send(JSON.stringify({
            access_token: creds.access_token,
            instance_id: creds.instance_id,
          }));
        }
        catch (err) {
          logger.warn("[lan-bridge] failed to send auth handshake:", err);
        }
      });

      socket.addEventListener("message", (event) => {
        if (ws !== socket) return;
        if (typeof event.data === "string") {
          try {
            let msg = JSON.parse(event.data);
            if (msg && typeof msg.status === "string" && msg.ok === undefined) {
              emit_status(msg.status);
              return;
            }
            if (msg && msg.ok) {
              ready = true;
              emit_status("ready");
              settle_waiters(null);
              logger.log(`[lan-bridge] connected to Discord room ${msg.instance_id || creds.instance_id}`);
              let queued = tx_pending;
              tx_pending = [];
              for (let pkt of queued) {
                try {
                  socket.send(pkt);
                }
                catch {
                  break;
                }
              }
            }
            else {
              let err_msg = (msg && msg.error) || "auth_rejected";
              logger.warn("[lan-bridge] auth rejected:", err_msg);
              settle_waiters(new Error(`Multiplayer gateway rejected connection: ${err_msg}`));
              socket.close();
            }
          }
          catch (err) {
            logger.warn("[lan-bridge] invalid handshake JSON:", err);
            settle_waiters(new Error("Multiplayer gateway returned an invalid handshake."));
            socket.close();
          }
          return;
        }

        let bytes = null;
        if (event.data instanceof ArrayBuffer) {
          bytes = new Uint8Array(event.data);
        }
        else if (event.data instanceof Uint8Array) {
          bytes = event.data;
        }
        if (bytes && bytes.length > 0) {
          if (rx_queue.length >= MAX_RX_QUEUE) {
            rx_queue.shift();
          }
          rx_queue.push(bytes);
        }
      });

      socket.addEventListener("error", (err) => {
        if (ws !== socket) return;
        logger.warn("[lan-bridge] WebSocket error:", err);
      });

      socket.addEventListener("close", () => {
        if (ws !== socket) return;
        let was_ready = ready;
        logger.log("[lan-bridge] WebSocket closed.");
        reset_socket_state(was_ready ? null : new Error("Connection to multiplayer gateway closed before ready."));
      });

      return true;
    }
    catch (err) {
      logger.warn("[lan-bridge] failed to open WebSocket:", err);
      reset_socket_state(err);
      return false;
    }
  }

  function preconnect({on_status} = {}) {
    if (!isAvailable()) {
      return Promise.reject(new Error("Discord Activity multiplayer is not available."));
    }
    if (ready && ws && ws.readyState === 1) {
      if (typeof on_status === "function") on_status("ready");
      return Promise.resolve();
    }
    if (typeof on_status === "function") {
      status_listeners.push(on_status);
    }
    return new Promise((resolve, reject) => {
      ready_waiters.push({
        resolve: () => {
          if (typeof on_status === "function") {
            status_listeners = status_listeners.filter((fn) => fn !== on_status);
          }
          resolve();
        },
        reject: (err) => {
          if (typeof on_status === "function") {
            status_listeners = status_listeners.filter((fn) => fn !== on_status);
          }
          reject(err);
        },
      });
      if (!ensure_connected()) {
        settle_waiters(new Error("Failed to open WebSocket to multiplayer gateway."));
      }
    });
  }

  function open(sock_id) {
    active_sockets.add(sock_id);
    ensure_connected();
  }

  function close(sock_id) {
    active_sockets.delete(sock_id);
    if (active_sockets.size === 0 && ws) {
      try {
        ws.close();
      }
      catch {}
      reset_socket_state();
      rx_queue = [];
    }
  }

  function send(sock_id, ptr, len) {
    if (len <= 0) return 0;
    if (!ws && !ensure_connected()) {
      return -1;
    }
    let heap = get_heap_u8();
    if (!heap) return -1;
    let payload = heap.slice(ptr, ptr + len);
    if (ws && ready && ws.readyState === 1) {
      try {
        ws.send(payload);
        return len;
      }
      catch {
        return -1;
      }
    }
    if (ws && (ws.readyState === 0 || (ws.readyState === 1 && !ready))) {
      if (tx_pending.length >= MAX_TX_PENDING) {
        tx_pending.shift();
      }
      tx_pending.push(payload);
      return len;
    }
    return -1;
  }

  function recv(_sock_id, ptr, max_len) {
    if (rx_queue.length === 0) return 0;
    let heap = get_heap_u8();
    if (!heap) return 0;
    let pkt = rx_queue.shift();
    let n = Math.min(pkt.length, max_len);
    heap.set(pkt.subarray(0, n), ptr);
    return n;
  }

  function hasPending(_sock_id) {
    return rx_queue.length > 0;
  }

  return {
    isAvailable,
    preconnect,
    open,
    close,
    send,
    recv,
    hasPending,
  };
}
