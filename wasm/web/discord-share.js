// Scoreboard screenshot capture & Discord Activity Share Moment flow.
//
// Called synchronously from C++ right after rendering a clean scoreboard frame
// (operations buttonbar hidden, roundedbox tightened) so ctx.drawImage() grabs
// the WebGL drawing buffer in the same requestAnimationFrame turn before the
// browser clears/composites it (no preserveDrawingBuffer overhead).
//
// Inside Discord: uploads the PNG via our same-origin Worker proxy
// (POST /api/share-attachment -> Discord /applications/{id}/attachment) and
// opens Discord's native openShareMomentDialog({ mediaUrl }).
// Outside Discord: triggers a local PNG download as a simple fallback.

const DEFAULT_MAX_WIDTH = 1280;

export function is_discord_share_available(global_scope = globalThis) {
  let sdk = global_scope && global_scope.discordSdk;
  let token = global_scope && global_scope.discordAccessToken;
  return Boolean(
    sdk &&
    sdk.commands &&
    typeof sdk.commands.openShareMomentDialog === "function" &&
    typeof token === "string" &&
    token.length > 0
  );
}

export function capture_canvas_blob({
  canvas,
  create_canvas = () => document.createElement("canvas"),
  max_width = DEFAULT_MAX_WIDTH,
}) {
  if (!canvas || !canvas.width || !canvas.height) {
    return Promise.reject(new Error("Game canvas is not ready for capture."));
  }

  let target_w = canvas.width;
  let target_h = canvas.height;
  if (max_width > 0 && target_w > max_width) {
    let scale = max_width / target_w;
    target_w = max_width;
    target_h = Math.max(1, Math.round(target_h * scale));
  }

  let offscreen = create_canvas();
  offscreen.width = target_w;
  offscreen.height = target_h;
  let ctx = offscreen.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("Could not create 2D context for screenshot capture."));
  }

  // Synchronous copy while WebGL backbuffer is still intact in this frame turn.
  ctx.drawImage(canvas, 0, 0, target_w, target_h);

  return new Promise((resolve, reject) => {
    offscreen.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      }
      else {
        reject(new Error("Failed to encode scoreboard PNG."));
      }
    }, "image/png");
  });
}

export function default_download_blob(blob, filename = "supertuxkart-scoreboard.png") {
  let url = URL.createObjectURL(blob);
  try {
    let a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function share_scoreboard_blob({
  blob,
  global_scope = globalThis,
  fetch_impl = fetch,
  download_blob = default_download_blob,
  logger = console,
  on_lifecycle = () => {},
}) {
  if (is_discord_share_available(global_scope)) {
    let form = new FormData();
    form.append("file", blob, "scoreboard.png");

    let response = await fetch_impl("/api/share-attachment", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${global_scope.discordAccessToken}`,
      },
      body: form,
    });

    let result = null;
    try {
      result = await response.json();
    }
    catch {}

    if (!response.ok || !result || !result.url) {
      let msg = (result && result.error) || `Attachment upload failed (${response.status})`;
      throw new Error(msg);
    }

    await global_scope.discordSdk.commands.openShareMomentDialog({
      mediaUrl: result.url,
    });
    on_lifecycle("scoreboard_share_ok", {mode: "discord", bytes: blob.size});
    return {mode: "discord", url: result.url};
  }

  download_blob(blob, "supertuxkart-scoreboard.png");
  on_lifecycle("scoreboard_share_ok", {mode: "download", bytes: blob.size});
  return {mode: "download"};
}

export function create_scoreboard_sharer({
  get_canvas,
  global_scope = globalThis,
  fetch_impl = fetch,
  create_canvas,
  download_blob = default_download_blob,
  logger = console,
  on_lifecycle = () => {},
}) {
  let in_flight = false;

  function capture_and_share() {
    if (in_flight) {
      return {started: false, reason: "in_flight"};
    }
    in_flight = true;

    let blob_promise;
    try {
      blob_promise = capture_canvas_blob({
        canvas: get_canvas(),
        create_canvas,
      });
    }
    catch (err) {
      in_flight = false;
      logger.warn("Scoreboard capture failed:", err);
      on_lifecycle("scoreboard_share_error", {stage: "capture", message: String(err)});
      return {started: false, reason: "capture_error", error: err};
    }

    let promise = blob_promise
      .then((blob) =>
        share_scoreboard_blob({
          blob,
          global_scope,
          fetch_impl,
          download_blob,
          logger,
          on_lifecycle,
        })
      )
      .catch((err) => {
        logger.warn("Scoreboard share failed:", err);
        on_lifecycle("scoreboard_share_error", {stage: "share", message: String(err)});
        return null;
      })
      .finally(() => {
        in_flight = false;
      });

    return {started: true, promise};
  }

  return {
    capture_and_share,
    is_in_flight: () => in_flight,
  };
}
