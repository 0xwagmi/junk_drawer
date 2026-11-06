// Runs in the page's own JS realm (world: MAIN), so it can see window.__vue_app__
// and reuse the page's own x-token from localStorage.
(() => {
  if (window.__chikiiExtInstalled) return;
  window.__chikiiExtInstalled = true;

  function writeVarint(arr, val) {
    val = BigInt(val);
    while (true) {
      let b = Number(val & 0x7fn);
      val >>= 7n;
      if (val !== 0n) arr.push(b | 0x80);
      else { arr.push(b); break; }
    }
  }
  function writeString(arr, fieldNum, str) {
    writeVarint(arr, (fieldNum << 3) | 2);
    const bytes = new TextEncoder().encode(str);
    writeVarint(arr, bytes.length);
    for (const b of bytes) arr.push(b);
  }
  function writeVarintField(arr, fieldNum, val) {
    writeVarint(arr, (fieldNum << 3) | 0);
    writeVarint(arr, val);
  }
  function writeBytesField(arr, fieldNum, bytesArr) {
    writeVarint(arr, (fieldNum << 3) | 2);
    writeVarint(arr, bytesArr.length);
    for (const b of bytesArr) arr.push(b);
  }
  function readVarint(b, i) {
    let result = 0, shift = 0;
    while (true) {
      const byte = b[i++];
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    return [result, i];
  }
  function parseFields(b) {
    const fields = {};
    let i = 0;
    const n = b.length;
    while (i < n) {
      let tag;
      [tag, i] = readVarint(b, i);
      const fnum = tag >> 3, wtype = tag & 7;
      let val;
      if (wtype === 0) [val, i] = readVarint(b, i);
      else if (wtype === 2) {
        let ln;
        [ln, i] = readVarint(b, i);
        val = b.slice(i, i + ln);
        i += ln;
      } else if (wtype === 5) { val = b.slice(i, i + 4); i += 4; }
      else if (wtype === 1) { val = b.slice(i, i + 8); i += 8; }
      else break;
      (fields[fnum] ||= []).push(val);
    }
    return fields;
  }

  const WEB_CLIENT = 'web;web;;1.0.0;1.0.0.0';
  const MOBILE_CLIENT = 'android;33;waydroid:WayDroid x86_64 Device;4.12.1;4843;';

  async function callRpc(clientStr, service, func, reqBytes) {
    const token = JSON.parse(localStorage.getItem('LOGINKEY') || 'null');
    const envelope = [];
    writeString(envelope, 1, service);
    writeString(envelope, 2, func);
    writeBytesField(envelope, 3, reqBytes);
    const clientKv = [];
    writeString(clientKv, 1, 'client');
    writeString(clientKv, 2, clientStr);
    writeBytesField(envelope, 4, clientKv);
    const res = await fetch('https://api-prod.chikiigame.com/proxyyun', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/protobuf',
        'x-token': token || '',
        client: clientStr,
        language: 'en',
      },
      body: new Uint8Array(envelope),
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return parseFields(buf);
  }

  async function getNewGameLibraryPage(clientStr, tagId, page) {
    const req = [];
    writeVarintField(req, 1, tagId);
    writeVarintField(req, 2, page);
    const env = await callRpc(clientStr, 'chikii.web.WebExtObj', 'GetNewGameLibrary', req);
    if (!env[2]) return { communitys: [], more: false, tags: [] };
    const top = parseFields(env[2][0]);
    const tags = (top[1] || []).map((t) => {
      const f = parseFields(t);
      return { id: f[1] ? f[1][0] : null, name: f[2] ? new TextDecoder().decode(f[2][0]) : null };
    });
    const communitys = (top[2] || []).map((c) => {
      const f = parseFields(c);
      const name = f[2] ? new TextDecoder().decode(f[2][0]) : null;
      const communityId = f[6] ? f[6][0] : null;
      return { name, communityId };
    });
    const more = top[3] ? !!top[3][0] : false;
    return { communitys, more, tags };
  }

  async function crawlAllTags(clientStr, label, progressCb) {
    const seen = new Map();
    const first = await getNewGameLibraryPage(clientStr, 0, 1);
    for (const c of first.communitys) if (c.communityId != null) seen.set(c.communityId, c.name);
    const tags = first.tags;
    progressCb && progressCb({ done: seen.size, phase: `${label}: tag 0/${tags.length}` });

    for (let ti = 0; ti < tags.length; ti++) {
      const tag = tags[ti];
      if (tag.id == null) continue;
      let page = 1;
      for (let p = 0; p < 7; p++) {
        let result;
        try {
          result = await getNewGameLibraryPage(clientStr, tag.id, page);
        } catch (e) {
          break;
        }
        for (const c of result.communitys) if (c.communityId != null) seen.set(c.communityId, c.name);
        progressCb && progressCb({ done: seen.size, phase: `${label}: tag ${ti + 1}/${tags.length} (${tag.name}) page ${page}` });
        if (!result.more || result.communitys.length === 0) break;
        page++;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return seen;
  }

  async function crawlCatalog(progressCb) {
    const webSeen = await crawlAllTags(WEB_CLIENT, 'web', progressCb);
    const mobileSeen = await crawlAllTags(MOBILE_CLIENT, 'mobile', progressCb);

    const catalog = [];
    for (const [communityId, name] of webSeen) {
      catalog.push({ communityId, name, missing: false });
    }
    for (const [communityId, name] of mobileSeen) {
      if (!webSeen.has(communityId)) catalog.push({ communityId, name, missing: true });
    }
    return catalog;
  }

  function findGameLibraryInstance() {
    const appEl = document.getElementById('app');
    if (!appEl || !appEl.__vue_app__) return null;
    const rootInst = appEl.__vue_app__._container._vnode.component;
    let found = null;
    function walk(instance, depth) {
      if (!instance || depth > 40 || found) return;
      const name = instance.type && (instance.type.__name || instance.type.name);
      if (name === 'GameLibrary') { found = instance; return; }
      function walkVnode(vnode) {
        if (!vnode || found) return;
        if (vnode.component) walk(vnode.component, depth + 1);
        if (Array.isArray(vnode.children)) {
          for (const c of vnode.children) {
            if (c && typeof c === 'object') {
              if (c.component) walk(c.component, depth + 1);
              walkVnode(c);
            }
          }
        } else if (vnode.children && typeof vnode.children === 'object' && vnode.children.component) {
          walk(vnode.children.component, depth + 1);
        }
      }
      walkVnode(instance.subTree);
    }
    walk(rootInst, 0);
    return found;
  }

  async function openGame(communityId) {
    const inst = findGameLibraryInstance();
    if (!inst) return { ok: false, error: 'GameLibrary component not found - navigate to #/GameLibrary first' };
    // If a modal is already open, closing it first before opening the next one
    // avoids the site's own conditional branch that misbehaves when
    // selectGame() is called while a modal is already showing.
    if (inst.setupState.communityId != null && typeof inst.setupState.selectGameModelClose === 'function') {
      inst.setupState.selectGameModelClose();
      await new Promise((r) => setTimeout(r, 150));
    }
    inst.setupState.selectGame({ communityId });
    return { ok: true };
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__chikiiExt !== true) return;
    const { id, action, communityId } = ev.data;
    let result;
    try {
      if (action === 'open') {
        result = await openGame(communityId);
      } else if (action === 'crawl') {
        const catalog = await crawlCatalog((progress) => {
          window.postMessage({ __chikiiExtProgress: true, id, progress }, '*');
        });
        result = { ok: true, catalog };
      } else {
        result = { ok: false, error: 'unknown action' };
      }
    } catch (e) {
      result = { ok: false, error: String(e) };
    }
    window.postMessage({ __chikiiExtResponse: true, id, result }, '*');
  });
})();
