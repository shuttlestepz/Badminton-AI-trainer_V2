/* ============================================================
   Shuttlestepz — sw.js  (Service Worker)
   Handles push notifications + streak reminders
   ============================================================ */

const CACHE = 'ssz-v1'

self.addEventListener('install', e => {
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim())
})

/* ── Push event — show notification ── */
self.addEventListener('push', e => {
  let data = { title: '🏸 Shuttlestepz', body: "Don't break your streak — train today!", url: '/Badminton-AI-trainer_V2/trainer.html' }
  try { if (e.data) data = { ...data, ...e.data.json() } } catch(err) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body : data.body,
      icon : '/Badminton-AI-trainer_V2/favicon.png',
      badge: '/Badminton-AI-trainer_V2/favicon.png',
      tag  : 'ssz-streak',
      renotify: true,
      data : { url: data.url },
      actions: [
        { action: 'train', title: '▶ Train Now' },
        { action: 'dismiss', title: 'Later' },
      ]
    })
  )
})

/* ── Notification click — open trainer ── */
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = e.notification.data?.url || '/Badminton-AI-trainer_V2/trainer.html'

  if (e.action === 'dismiss') return

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes('shuttlestepz') && 'focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    })
  )
})

/* ── Background sync — local streak reminder ── */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'ssz-streak-check') {
    e.waitUntil(checkAndNotify())
  }
})

async function checkAndNotify() {
  const lastTrain = await getLastTrainTime()
  if (!lastTrain) return
  const hoursSince = (Date.now() - lastTrain) / 36e5
  if (hoursSince >= 20) {
    await self.registration.showNotification('🏸 Shuttlestepz — Streak at risk!', {
      body : `It's been ${Math.round(hoursSince)} hours. Train now to keep your streak alive! 🔥`,
      icon : '/Badminton-AI-trainer_V2/favicon.png',
      badge: '/Badminton-AI-trainer_V2/favicon.png',
      tag  : 'ssz-streak',
      renotify: true,
      data : { url: '/Badminton-AI-trainer_V2/trainer.html' },
    })
  }
}

/* ── Store last train time from main thread ── */
self.addEventListener('message', e => {
  if (e.data?.type === 'SSZ_LAST_TRAIN') {
    setLastTrainTime(e.data.timestamp)
  }
})

// Simple IDB helpers for last train time
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('ssz-sw', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('meta')
    req.onsuccess = () => res(req.result)
    req.onerror   = () => rej(req.error)
  })
}
async function setLastTrainTime(ts) {
  const db  = await openDB()
  const tx  = db.transaction('meta', 'readwrite')
  tx.objectStore('meta').put(ts, 'lastTrain')
}
async function getLastTrainTime() {
  const db  = await openDB()
  const tx  = db.transaction('meta', 'readonly')
  return new Promise((res, rej) => {
    const req = tx.objectStore('meta').get('lastTrain')
    req.onsuccess = () => res(req.result || null)
    req.onerror   = () => rej(req.error)
  })
}
