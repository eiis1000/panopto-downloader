// ==UserScript==
// @name         Panopto Folder Export (for panopto-fetch)
// @namespace    https://github.com/local/panopto-fetch
// @description  Pick a view on a Panopto video/folder and copy a manifest string for the panopto-fetch CLI.
// @version      1.3.0
// @match        https://*.panopto.com/Panopto/Pages/Sessions/List.aspx*
// @match        https://*.panopto.eu/Panopto/Pages/Sessions/List.aspx*
// @match        https://*.hosted.panopto.com/Panopto/Pages/Sessions/List.aspx*
// @match        https://*.panopto.com/Panopto/Pages/Viewer.aspx*
// @match        https://*.panopto.eu/Panopto/Pages/Viewer.aspx*
// @match        https://*.hosted.panopto.com/Panopto/Pages/Viewer.aspx*
// @match        https://*.panopto.com/Panopto/Pages/Embed.aspx*
// @match        https://*.panopto.eu/Panopto/Pages/Embed.aspx*
// @match        https://*.hosted.panopto.com/Panopto/Pages/Embed.aspx*
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* globals Hls */

(function () {
  "use strict";

  const ORIGIN = location.origin;
  const LIST = location.pathname.includes("/List.aspx");
  const CONCURRENCY = 6;

  GM_addStyle(`
    #pf-btn{display:inline-flex;align-items:center;gap:6px;margin:0 8px;padding:7px 12px;
      font:600 13px/1 system-ui,sans-serif;color:#fff;background:#0b6;border:0;border-radius:6px;
      cursor:pointer;position:relative;z-index:9999}
    #pf-btn:hover{background:#0a5}
    #pf-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483646;
      display:flex;align-items:center;justify-content:center}
    #pf-modal{background:#1d2228;color:#eee;width:min(680px,92vw);max-height:86vh;overflow:auto;
      border-radius:10px;padding:22px 26px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 12px 40px #000a}
    #pf-modal h2{margin:0 0 4px;font-size:19px}
    #pf-modal p.sub{margin:0 0 16px;color:#9aa4ad;font-size:13px}
    #pf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin:4px 0 8px}
    #pf-grid .view{display:flex;flex-direction:column;gap:0;padding:0;background:#2a313a;color:#eee;
      border:2px solid #3a434e;border-radius:8px;cursor:pointer;overflow:hidden;text-align:left}
    #pf-grid .view:hover{border-color:#0b6}
    #pf-grid .thumb{position:relative;width:100%;aspect-ratio:16/9;background:#11151a;display:flex;
      align-items:center;justify-content:center;color:#5b6670;font-size:12px}
    #pf-grid .thumb video,#pf-grid .thumb img,#pf-grid .thumb canvas{width:100%;height:100%;object-fit:contain;background:#000}
    #pf-grid .cap{padding:8px 10px}
    #pf-grid .cap b{font-size:14px}
    #pf-grid .cap small{display:block;color:#9aa4ad;font-size:11px;margin-top:2px}
    #pf-status{white-space:pre-wrap;color:#cdd6df;font-size:13px;margin:8px 0 14px}
    #pf-out{width:100%;height:90px;background:#11151a;color:#7fd;border:1px solid #3a434e;
      border-radius:7px;padding:10px;font:12px/1.4 ui-monospace,monospace;resize:vertical}
    #pf-modal .row{display:flex;gap:10px;margin-top:12px}
    #pf-modal button.act{padding:9px 16px;border:0;border-radius:6px;cursor:pointer;font-weight:600}
    #pf-copy{background:#0b6;color:#fff}#pf-close{background:#3a434e;color:#eee}
    #pf-cmd{margin-top:10px;color:#9aa4ad;font:12px/1.4 ui-monospace,monospace;
      background:#11151a;border-radius:6px;padding:8px 10px}
  `);

  // ----------------------------------------------------------------- UI shell
  function modal() {
    const ov = document.createElement("div");
    ov.id = "pf-overlay";
    ov.innerHTML = `<div id="pf-modal"></div>`;
    ov.addEventListener("click", e => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    return ov.querySelector("#pf-modal");
  }

  function makeButton() {
    const btn = document.createElement("button");
    btn.id = "pf-btn";
    btn.type = "button";
    btn.textContent = "⬇ Export views";
    btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); start(); });
    return btn;
  }

  function floatButton(btn) {
    Object.assign(btn.style, { position: "fixed", top: "12px", right: "12px", zIndex: "2147483000" });
  }

  // Idempotent: re-creates the button if Panopto's SPA wiped it. On the folder
  // page the toolbar is re-rendered on load, so we float a fixed button there;
  // on the viewer the toolbar is stable so we dock into it.
  function ensureButton() {
    if (document.querySelector("#pf-btn")) return;
    const btn = makeButton();
    const host = LIST ? null
      : (document.querySelector("#eventTabControl") || document.querySelector("#navigationControls"));
    if (host) host.appendChild(btn);
    else { floatButton(btn); document.body.appendChild(btn); }
  }

  GM_registerMenuCommand("Export Panopto views", start);

  // --------------------------------------------------------- Panopto requests
  async function deliveryInfo(id) {
    const r = await fetch(ORIGIN + "/Panopto/Pages/Viewer/DeliveryInfo.aspx", {
      method: "POST", credentials: "include",
      headers: { accept: "application/json, text/javascript, */*; q=0.01",
                 "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "deliveryId=" + encodeURIComponent(id) + "&isEmbed=true&responseType=json",
    });
    const j = await r.json();
    if (j.ErrorCode) throw new Error(j.ErrorMessage || ("DeliveryInfo error " + j.ErrorCode));
    return j.Delivery || {};
  }

  // Views available for a delivery: the combined podcast + each source stream.
  function viewsOf(delivery) {
    const out = [];
    const podcast = delivery.PodcastStreams && delivery.PodcastStreams[0];
    if (podcast && podcast.StreamUrl)
      out.push({ key: "podcast", name: "Podcast (combined)", url: podcast.StreamUrl });
    const seen = {};
    (delivery.Streams || []).forEach((s, i) => {
      if (!s.StreamUrl) return;
      let nm = (s.Name || s.Tag || ("Stream " + (i + 1))).toString();
      seen[nm] = (seen[nm] || 0) + 1;                 // disambiguate duplicate names
      if (seen[nm] > 1) nm += " #" + seen[nm];
      out.push({ key: "stream:" + i, tag: s.Tag, index: i, name: nm, url: s.StreamUrl });
    });
    return out;
  }

  // Resolve the URL for the chosen view inside a specific delivery. Stream *index*
  // is the reliable key: tags repeat ("object"×3), but the per-video stream layout
  // is consistent across a folder, so Streams[index] is "the same camera".
  function pickUrl(delivery, view) {
    if (view.key === "podcast")
      return delivery.PodcastStreams && delivery.PodcastStreams[0] && delivery.PodcastStreams[0].StreamUrl;
    const streams = delivery.Streams || [];
    if (streams[view.index] && streams[view.index].StreamUrl) return streams[view.index].StreamUrl;
    if (view.tag) { const m = streams.find(s => s.Tag === view.tag); if (m) return m.StreamUrl; }
    const p = delivery.PodcastStreams && delivery.PodcastStreams[0]; // last-resort fallback
    return p && p.StreamUrl;
  }

  // ------------------------------------------------------- folder enumeration
  function folderId() {
    const h = new URLSearchParams(location.hash.slice(1));
    let id = h.get("folderID");
    if (id) return id.replace(/^"|"$/g, "");
    return new URLSearchParams(location.search).get("folderID");
  }

  async function listFolderViaApi(fid) {
    const r = await fetch(ORIGIN + "/Panopto/Services/Data.svc/GetSessions", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
      body: JSON.stringify({ queryParameters: {
        query: null, sortColumn: 1, sortAscending: true, maxResults: 1000, page: 0,
        startDate: null, endDate: null, folderID: fid, bookmarked: false,
        getFolderData: true, isSharedWithMe: false, isSubscriptionsPage: false,
        includeArchived: true, includeArchivedStateCount: true } }),
    });
    const j = await r.json();
    const results = (j.d && j.d.Results) || [];
    return results.map(s => {
      // Prefer the delivery id parsed from the viewer URL (what the player uses);
      // SessionID is only a fallback and isn't always the deliverable id.
      const url = s.IosVideoUrl || s.ViewerUrl || s.Mp4Url || "";
      let id = null;
      if (url) { const m = url.match(/[?&](?:id|deliveryId)=([0-9a-f-]{36})/i); if (m) id = m[1]; }
      if (!id) id = s.SessionID || s.DeliveryID || null;
      return { id, title: (s.SessionName || s.Name || "").trim() };
    }).filter(v => v.id);
  }

  function listFolderViaDom() {
    const sel = "#listViewContainer tbody tr a.detail-title, #detailsTable tbody tr a.detail-title,"
      + "#thumbnailGrid > li a.detail-title, a.detail-title";
    const seen = new Map();
    document.querySelectorAll(sel).forEach(a => {
      let id; try { id = new URL(a.href, location.href).searchParams.get("id"); } catch { return; }
      if (!id || seen.has(id)) return;
      let t = a.textContent.trim() || a.getAttribute("title") || a.getAttribute("aria-label") || "";
      if (!t) { const row = a.closest("tr,li,[role='row']"); if (row) t = row.textContent.trim().split("\n")[0]; }
      seen.set(id, { id, title: t.trim() });
    });
    return [...seen.values()];
  }

  async function enumerate() {
    if (!LIST) {
      const id = new URLSearchParams(location.search).get("id");
      if (!id) throw new Error("No video id in URL");
      return [{ id, title: (document.title || id).replace(/\s*:\s*Panopto\s*$/i, "").trim() }];
    }
    const fid = folderId();
    let vids = [];
    if (fid) { try { vids = await listFolderViaApi(fid); } catch (e) { console.warn("[pf] API list failed", e); } }
    if (!vids.length) vids = listFolderViaDom();
    if (!vids.length) throw new Error("No videos found in this folder");
    return vids;
  }

  // ------------------------------------------------------ concurrency helper
  async function mapLimit(arr, n, fn) {
    const out = new Array(arr.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
      while (i < arr.length) { const k = i++; try { out[k] = await fn(arr[k], k); } catch (e) { out[k] = { __err: e }; } }
    }));
    return out;
  }

  // ---------------------------------------------------------------- workflow
  async function start() {
    const m = modal();
    m.innerHTML = `<h2>Panopto export</h2><p class="sub">Reading folder…</p><div id="pf-status"></div>`;
    const status = m.querySelector("#pf-status");
    const say = t => { status.textContent = t; };

    let videos;
    try { videos = await enumerate(); }
    catch (e) { m.querySelector(".sub").textContent = "Error: " + e.message; return; }

    say(`Found ${videos.length} video(s). Probing available views…`);
    // Probe sessions until one resolves — the first listed item may be deleted,
    // still processing, or otherwise not deliverable.
    let firstDelivery = null, lastErr = "";
    for (let k = 0; k < videos.length; k++) {
      say(`Found ${videos.length} video(s). Probing available views… (${k + 1}/${videos.length})`);
      try {
        const d = await deliveryInfo(videos[k].id);
        if (viewsOf(d).length) { firstDelivery = d; break; }
      } catch (e) { lastErr = (e && e.message) || String(e); }
    }
    if (!firstDelivery) {
      say("Could not read a usable session in this folder. Last error: " + stripHtml(lastErr));
      return;
    }
    const views = viewsOf(firstDelivery);
    if (!views.length) { say("No downloadable streams found for the first video."); return; }

    // Let the user pick a view — show a preview frame of each so the (useless)
    // Panopto stream names ("object", "dv", …) don't matter.
    m.querySelector(".sub").textContent =
      `${videos.length} video(s) in this ${LIST ? "folder" : "page"}. Click the view to download for all of them:`;
    const grid = document.createElement("div");
    grid.id = "pf-grid";
    views.forEach((v, i) => {
      const card = document.createElement("button");
      card.className = "view";
      card.innerHTML = `<div class="thumb">loading preview…</div>
        <div class="cap"><b>${escapeHtml(v.name)}</b><small>${classify(v.url)}</small></div>`;
      card.addEventListener("click", () => resolveAll(m, videos, v));
      grid.appendChild(card);
      preview(v, card.querySelector(".thumb"), card.querySelector(".cap small"));
    });
    status.replaceWith(grid);
    grid.insertAdjacentHTML("afterend", `<div id="pf-status"></div>`);
  }

  // Render a representative frame of a stream into `box` and append its resolution
  // to `capLine`. The video element MUST live in the DOM (so it's composited and
  // actually decodes / fires requestVideoFrameCallback) — a detached element yields
  // black frames on HLS. We play muted, capture the first non-black presented frame
  // to a <canvas> snapshot, then tear the player down.
  function preview(view, box, capLine) {
    const vid = document.createElement("video");
    vid.muted = true; vid.playsInline = true; vid.autoplay = true; vid.preload = "auto";
    let hls = null, done = false, blackTries = 0;
    box.textContent = ""; box.appendChild(vid);   // in the DOM => it composites & decodes

    const cleanup = () => { try { vid.pause(); } catch {} try { if (hls) hls.destroy(); } catch {} hls = null; };
    const fail = (why) => { if (!done) { done = true; cleanup(); box.textContent = why || "no preview"; } };

    // Mostly-black? (MSE/blob frames are same-origin and readable; a tainted
    // cross-origin mp4 throws → we just accept that frame.)
    const isBlack = (cv, ctx) => {
      try {
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let lit = 0, n = 0;
        for (let i = 0; i < d.length; i += 4 * 97) { n++; if (d[i] + d[i + 1] + d[i + 2] > 36) lit++; }
        return n > 0 && lit / n < 0.02;
      } catch { return false; }
    };

    const grab = () => {
      if (done) return;
      const w = vid.videoWidth, h = vid.videoHeight;
      if (!w || !h) { nextFrame(); return; }
      const cv = document.createElement("canvas");
      cv.width = Math.min(w, 480); cv.height = Math.round(cv.width * h / w);
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(vid, 0, 0, cv.width, cv.height);
      if (isBlack(cv, ctx) && blackTries++ < 6) {     // jump ahead, try a later frame
        try { vid.currentTime = (vid.currentTime || 0) + Math.max(20, (vid.duration || 600) * 0.12); } catch {}
        nextFrame(); return;
      }
      done = true;
      capLine.textContent += ` · ${w}×${h}`;
      box.textContent = ""; box.appendChild(cv);
      cleanup();
    };

    const nextFrame = () => {
      if ("requestVideoFrameCallback" in vid) vid.requestVideoFrameCallback(() => grab());
      else setTimeout(grab, 400);
    };

    vid.addEventListener("loadedmetadata", () => {
      const d = isFinite(vid.duration) && vid.duration ? vid.duration : 0;
      try { vid.currentTime = Math.min(120, d ? d * 0.2 : 10); } catch {}
      vid.play().catch(() => {});
      nextFrame();
    }, { once: true });
    vid.addEventListener("error", () => fail("preview blocked"));
    setTimeout(() => fail("no preview"), 15000);

    const isHls = /\.m3u8(\?|$)/i.test(view.url);
    if (isHls && typeof Hls !== "undefined" && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 6, maxMaxBufferLength: 12 });
      hls.on(Hls.Events.ERROR, (_e, data) => { if (data && data.fatal) fail("preview blocked"); });
      hls.loadSource(view.url);
      hls.attachMedia(vid);
    } else if (isHls && vid.canPlayType("application/vnd.apple.mpegurl")) {
      vid.src = view.url; // Safari native HLS
    } else if (!isHls) {
      vid.src = view.url; // MP4/podcast (no crossOrigin: we only display, never read pixels)
    } else {
      fail("can't preview");
    }
  }

  function stripHtml(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function classify(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return "HLS stream";
    if (/\.mp4(\?|$)/i.test(url)) return "MP4";
    if (/\.panobf/i.test(url)) return "Panopto fragmented";
    return "stream";
  }

  async function resolveAll(m, videos, view) {
    const status = m.querySelector("#pf-status");
    m.querySelectorAll(".view").forEach(b => b.disabled = true);
    const say = t => { status.textContent = t; };
    say(`Resolving "${view.name}" for ${videos.length} video(s)…`);

    let done = 0;
    const items = await mapLimit(videos, CONCURRENCY, async (v) => {
      const d = await deliveryInfo(v.id);
      const url = pickUrl(d, view);
      done++; say(`Resolving "${view.name}"… ${done}/${videos.length}`);
      if (!url) throw new Error("no url");
      return { title: v.title || v.id, view: view.name.replace(/\s*\(.*\)$/, "").trim() || "video", url };
    });

    const ok = items.filter(it => it && !it.__err)
      .map((it, i) => ({ index: i + 1, title: it.title, view: it.view, url: it.url }));
    const failed = videos.length - ok.length;

    const manifest = { origin: ORIGIN, folderId: folderId(), folderTitle:
      (document.title || "").replace(/\s*:\s*Panopto\s*$/i, "").trim(),
      view: view.name, items: ok };
    const b64 = b64utf8(JSON.stringify(manifest));

    GM_setClipboard(b64, "text");
    m.innerHTML = `<h2>Manifest ready ✓</h2>
      <p class="sub">${ok.length} video(s) resolved${failed ? `, ${failed} failed` : ""}. Copied to clipboard.</p>
      <textarea id="pf-out" readonly></textarea>
      <div id="pf-cmd">Paste into the CLI:\n  panopto-fetch '&lt;the string above&gt;' -o ~/panopto</div>
      <div class="row">
        <button class="act" id="pf-copy">Copy again</button>
        <button class="act" id="pf-close">Close</button>
      </div>`;
    const ta = m.querySelector("#pf-out"); ta.value = b64;
    m.querySelector("#pf-copy").onclick = () => { GM_setClipboard(b64, "text"); ta.select(); };
    m.querySelector("#pf-close").onclick = () => m.closest("#pf-overlay").remove();
  }

  function b64utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  // ---------------------------------------------------------------- bootstrap
  // Re-assert the button forever: Panopto's SPA re-renders toolbars / navigates by
  // hash without a reload, which would otherwise drop a one-shot injection.
  ensureButton();
  setInterval(ensureButton, 1500);
})();
