// ==UserScript==
// @name         playlog transcripts
// @namespace    https://dakshhpanchal.github.io/playlog/
// @version      1.1.0
// @description  Lets playlog copy YouTube transcripts. Runs only on the playlog site and only talks to youtube.com.
// @match        https://dakshhpanchal.github.io/playlog/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      www.youtube.com
// @connect      youtube.com
// @run-at       document-start
// @downloadURL  https://dakshhpanchal.github.io/playlog/playlog-transcripts.user.js
// @updateURL    https://dakshhpanchal.github.io/playlog/playlog-transcripts.user.js
// ==/UserScript==

/* How it works: playlog posts {type:'playlog-transcript-request', id, videoId}.
   This script loads the video's YouTube page in your browser, reads the same
   transcript YouTube shows under "Show transcript", and posts the text back. */
(function () {
  'use strict';
  const VERSION = '1.1.0';
  const gmRequest = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : GM.xmlHttpRequest;

  function request(opts) {
    return new Promise((resolve, reject) => {
      gmRequest(Object.assign({}, opts, {
        timeout: 30000,
        onload: r => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('YouTube answered ' + r.status))),
        onerror: () => reject(new Error('YouTube could not be reached')),
        ontimeout: () => reject(new Error('YouTube took too long to answer')),
      }));
    });
  }

  const pick = (html, re) => { const m = html.match(re); return m ? m[1] : ''; };
  const decode = s => s.replace(/\\u0026/g, '&').replace(/\\\//g, '/');

  function walk(node, fn) {
    if (!node || typeof node !== 'object') return;
    fn(node);
    for (const k in node) walk(node[k], fn);
  }
  const runsText = t => !t ? '' : t.simpleText != null ? t.simpleText : (t.runs || []).map(r => r.text).join('');
  const clock = ms => {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), p = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
  };

  // Groups caption lines into paragraphs of about a minute, each starting with a timestamp.
  function format(segs) {
    const out = []; let cur = null;
    for (const s of segs) {
      if (s.heading) { cur = null; out.push(`\n[${s.heading}]`); continue; }
      const t = s.text.replace(/\s+/g, ' ').trim();
      if (!t || /^\[(music|applause|laughter)\]$/i.test(t)) continue;
      if (!cur || s.start - cur.start >= 60000) { cur = { start: s.start, words: [] }; out.push(cur); }
      cur.words.push(t);
    }
    return out.map(p => typeof p === 'string' ? p : `[${clock(p.start)}] ${p.words.join(' ')}`).join('\n').trim();
  }

  const htmlDecode = s => new DOMParser().parseFromString('<!doctype html><body>' + s, 'text/html').body.textContent;

  // Picks English captions if there are any, preferring ones written by a person.
  function chooseTrack(tracks) {
    const en = t => /^en/.test(t.languageCode);
    return tracks.find(t => en(t) && t.kind !== 'asr') || tracks.find(en) || tracks.find(t => t.kind !== 'asr') || tracks[0];
  }

  // Parses YouTube's caption XML: <text start="s" dur="s"> (srv1) or <p t="ms"> (srv3).
  function parseCaptionXml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml'), segs = [];
    for (const n of doc.querySelectorAll('text')) segs.push({ start: Math.round(parseFloat(n.getAttribute('start') || '0') * 1000), text: htmlDecode(n.textContent) });
    if (!segs.length) for (const n of doc.querySelectorAll('p')) segs.push({ start: +n.getAttribute('t') || 0, text: htmlDecode(n.textContent) });
    return segs;
  }

  // Main method: ask for the caption list the way YouTube's Android app does. Its caption
  // links work without the extra token the website's player adds.
  async function viaAndroidPlayer(videoId, html) {
    const key = pick(html, /"INNERTUBE_API_KEY":"([^"]+)"/) || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const txt = await request({
      method: 'POST', anonymous: true,
      url: `https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en' } }, videoId }),
    });
    const j = JSON.parse(txt);
    const tracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) {
      const st = j?.playabilityStatus?.status;
      if (st && st !== 'OK') throw new Error(`YouTube said ${String(j.playabilityStatus.reason || st).toLowerCase()}`);
      return null;
    }
    const t = chooseTrack(tracks);
    const xml = await request({ method: 'GET', anonymous: true, url: t.baseUrl.replace(/&fmt=[^&]*/, '') });
    const segs = parseCaptionXml(xml);
    return segs.length ? { text: format(segs), lang: runsText(t.name) } : null;
  }

  async function viaTranscriptPanel(html) {
    const params = pick(html, /"getTranscriptEndpoint":\{"params":"([^"]+)"/);
    if (!params) return null;
    const key = pick(html, /"INNERTUBE_API_KEY":"([^"]+)"/);
    const version = pick(html, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || '2.20250101.00.00';
    const visitor = pick(html, /"VISITOR_DATA":"([^"]+)"/);
    const body = { context: { client: { clientName: 'WEB', clientVersion: version, hl: 'en', visitorData: visitor || undefined } }, params };
    const txt = await request({
      method: 'POST',
      url: `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false${key ? '&key=' + key : ''}`,
      headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': version, ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}) },
      data: JSON.stringify(body),
    });
    const j = JSON.parse(txt), segs = []; let lang = '';
    walk(j, n => {
      if (n.transcriptSegmentRenderer) {
        const r = n.transcriptSegmentRenderer;
        segs.push({ start: +r.startMs || 0, text: runsText(r.snippet) });
      } else if (n.transcriptSectionHeaderRenderer) {
        const h = runsText(n.transcriptSectionHeaderRenderer.snippet) || runsText(n.transcriptSectionHeaderRenderer.sectionHeader?.sectionHeaderViewModel?.headline);
        if (h) segs.push({ heading: h });
      } else if (n.selected === true && n.title && !lang && n.continuation) {
        lang = typeof n.title === 'string' ? n.title : runsText(n.title);
      }
    });
    return segs.some(s => s.text) ? { text: format(segs), lang } : null;
  }

  async function viaCaptionTrack(html) {
    const raw = pick(html, /"captionTracks":(\[.*?\])\s*,\s*"audioTracks"/);
    if (!raw) return null;
    let tracks; try { tracks = JSON.parse(raw); } catch { return null; }
    const t = tracks.find(x => /^en/.test(x.languageCode) && x.kind !== 'asr') || tracks.find(x => /^en/.test(x.languageCode)) || tracks[0];
    if (!t || !t.baseUrl) return null;
    const txt = await request({ method: 'GET', url: decode(t.baseUrl) + '&fmt=json3' });
    if (!txt) return null;
    const j = JSON.parse(txt);
    const segs = (j.events || []).filter(e => e.segs).map(e => ({ start: e.tStartMs || 0, text: e.segs.map(s => s.utf8).join('') }));
    return segs.length ? { text: format(segs), lang: runsText(t.name) } : null;
  }

  async function transcript(videoId) {
    if (!/^[\w-]{11}$/.test(videoId)) throw new Error('not a YouTube video');
    const html = await request({ method: 'GET', url: `https://www.youtube.com/watch?v=${videoId}&hl=en`, headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
    let r = null, err = null;
    for (const method of [() => viaAndroidPlayer(videoId, html), () => viaTranscriptPanel(html), () => viaCaptionTrack(html)]) {
      try { r = await method(); } catch (e) { console.warn('[playlog transcripts]', e); err = err || e; }
      if (r) break;
    }
    if (r) return r;
    if (/"playabilityStatus":\{"status":"(LOGIN_REQUIRED|ERROR|UNPLAYABLE)"/.test(html)) throw new Error('the video is private, removed or age-restricted');
    throw err || new Error('this video has no captions');
  }

  window.addEventListener('message', async e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'playlog-transcripts-ping') window.postMessage({ type: 'playlog-transcripts-ready', version: VERSION }, '*');
    if (m.type !== 'playlog-transcript-request') return;
    try {
      const r = await transcript(String(m.videoId));
      window.postMessage({ type: 'playlog-transcript-result', id: m.id, ok: true, text: r.text, lang: r.lang }, '*');
    } catch (err) {
      window.postMessage({ type: 'playlog-transcript-result', id: m.id, ok: false, error: err.message || String(err) }, '*');
    }
  });
  window.postMessage({ type: 'playlog-transcripts-ready', version: VERSION }, '*');
})();
