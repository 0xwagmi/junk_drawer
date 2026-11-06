// Runs in the isolated content-script world. Relays messages between the
// extension popup (chrome.runtime) and content_main.js, which runs in the
// page's own JS realm (world: MAIN) so it can see window.__vue_app__.

function callPage(action, communityId, onProgress) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    function handler(ev) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.__chikiiExtProgress && ev.data.id === id) {
        onProgress && onProgress(ev.data.progress);
        return;
      }
      if (ev.data.__chikiiExtResponse && ev.data.id === id) {
        window.removeEventListener('message', handler);
        resolve(ev.data.result);
      }
    }
    window.addEventListener('message', handler);
    window.postMessage({ __chikiiExt: true, id, action, communityId }, '*');
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'open') {
    callPage('open', msg.communityId).then(sendResponse);
    return true;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chikii-crawl') return;
  port.onMessage.addListener((msg) => {
    if (msg.action !== 'crawl') return;
    callPage('crawl', null, (progress) => {
      port.postMessage({ type: 'progress', progress });
    }).then((result) => {
      port.postMessage({ type: 'done', result });
    });
  });
});
