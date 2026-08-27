window.chrome = {
  runtime: { getManifest: () => ({ version: '1.2.0' }), lastError: null },
  storage: { sync: { get: (d, cb) => cb({}), set: async () => {} } },
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.facebook.com/' }],
    sendMessage: (id, msg, opts, cb) => cb(msg.type.indexOf('slop:') === 0
      ? { active: true, units: 3, blocked: 4, shown: 1 }
      : { host: 'www.facebook.com', active: true, enabled: true, ready: true, families: [] })
  }
};
