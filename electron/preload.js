'use strict';
// Preload — expose minimal bridge, no business logic here
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('bfgDesktop', {
  isDesktop: true,
  backend: process.env.BFG_BACKEND || 'http://localhost:8080',
  version: require('../package.json').version,
});
