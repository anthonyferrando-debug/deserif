window.chrome = {
  runtime: { getManifest: () => ({ version: '1.0.0' }), lastError: null },
  storage: { sync: { get: (d, cb) => cb({}), set: async () => {} } },
  tabs: {
    query: async () => [{ id: 1, url: 'https://launch.someaistartup.com/' }],
    sendMessage: (id, msg, opts, cb) => cb({
      host: 'launch.someaistartup.com', active: true, enabled: true, ready: true,
      families: [
        { name: 'Playfair Display', count: 14, ai: true },
        { name: 'Georgia', count: 3, ai: false },
        { name: 'Instrument Serif', count: 2, ai: true }
      ]
    })
  }
};
