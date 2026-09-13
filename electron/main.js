'use strict';
/**
 * BFG CMMS — Electron Windows wrapper (Requirement #2)
 * Connects to the shared backend (no local DB/business logic).
 * Build: npm run build:win
 */
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

const BACKEND = process.env.BFG_BACKEND || 'http://localhost:8080';

function createWindow(){
  const win = new BrowserWindow({
    width: 1360, height: 860,
    minWidth: 1024, minHeight: 680,
    backgroundColor: '#0B2239',
    icon: path.join(__dirname, '../public/logo.jpg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // allow self-signed in factory LAN
    },
    autoHideMenuBar: true,
  });
  // Load backend in window (single source of truth)
  win.loadURL(BACKEND);
  // Open external links in OS browser
  win.webContents.setWindowOpenHandler(({url})=>{
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Menu
  const menu = Menu.buildFromTemplate([
    { role: 'reload', label: 'بروزرسانی' },
    { role: 'toggleDevTools', label: 'ابزار توسعه' },
    { type: 'separator' },
    { label: 'باز کردن در مرورگر', click: ()=> shell.openExternal(BACKEND) },
    { role: 'quit', label: 'خروج' },
  ]);
  Menu.setApplicationMenu(menu);
  win.on('ready-to-show', ()=> win.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', ()=>{
  if(process.platform !== 'darwin') app.quit();
});
app.on('activate', ()=>{
  if(BrowserWindow.getAllWindows().length===0) createWindow();
});
