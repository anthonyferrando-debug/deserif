// Stand-in for the chrome.* APIs so popup.html can be opened as a plain page
// for layout checks and screenshots. ?fb shows the Facebook-tab state.
(() => {
  const fb = location.search.includes('fb');
  const tabUrl = fb ? 'https://www.facebook.com/' : 'https://launch.someaistartup.com/';
  const fonts = fb ? [] : [
    { name: 'Playfair Display', count: 14, ai: true },
    { name: 'Georgia', count: 3, ai: false },
    { name: 'Instrument Serif', count: 2, ai: true }
  ];
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '1.1.0' }),
      lastError: null,
      sendMessage: (msg, cb) => { if (cb) setTimeout(() => cb(msg && msg.type === 'slop:test' ? { ok: true, model: 'claude-opus-5' } : {}), 150); }
    },
    storage: {
      sync: { get: (d, cb) => cb({}), set: async () => {} },
      local: { get: (d, cb) => cb({ slopKey: 'sk-ant-api03-mock-key', slopStats: { checked: 412, blocked: 37 } }), set: async () => {} }
    },
    tabs: {
      query: async () => [{ id: 1, url: tabUrl }],
      sendMessage: (id, msg, opts, cb) => {
        if (msg && msg.type && msg.type.startsWith('slop:')) {
          return cb(fb ? { active: true, paused: false, reason: '', blocked: 3, shown: 1, pending: 0, checked: 14 } : null);
        }
        cb({ host: new URL(tabUrl).hostname, active: true, enabled: true, ready: true, families: fonts });
      }
    }
  };
})();
