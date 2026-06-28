/* ============================================================
   Shuttlestepz — notifications.js
   Browser push notification registration + streak checks
   ============================================================ */

const SW_PATH  = '/Badminton-AI-trainer_V2/sw.js'
const SW_SCOPE = '/Badminton-AI-trainer_V2/'

/* ── Register service worker ── */
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null
  try {
    const reg = await navigator.serviceWorker.register(SW_PATH, { scope: SW_SCOPE })
    console.log('[SW] registered', reg.scope)
    return reg
  } catch(e) {
    console.warn('[SW] registration failed', e)
    return null
  }
}

/* ── Request permission + subscribe ── */
export async function enablePushNotifications(DB) {
  if (!('Notification' in window)) return { ok: false, msg: 'Notifications not supported on this device.' }
  if (!('serviceWorker' in navigator)) return { ok: false, msg: 'Service Worker not supported.' }

  // Ask permission
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return { ok: false, msg: 'Permission denied.' }

  try {
    const reg = await navigator.serviceWorker.ready

    // Use a static VAPID-less local subscription for now
    // (real push requires a VAPID server — this gives local periodic reminders)
    const existing = await reg.pushManager.getSubscription()
    if (existing) {
      await DB.savePushSubscription(existing)
      return { ok: true, msg: 'Notifications already enabled!' }
    }

    // Try subscribing (works fully with a VAPID backend)
    // For now falls back to periodic sync / local notifications
    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // applicationServerKey: urlBase64ToUint8Array('YOUR_VAPID_PUBLIC_KEY')
        // ↑ Uncomment and add your VAPID key when you set up a push server
      })
      await DB.savePushSubscription(sub)
    } catch(subErr) {
      // No VAPID key yet — that's fine, periodic sync still works
      console.log('[SW] Push subscribe skipped (no VAPID key), using periodic sync')
    }

    // Register periodic background sync (Chrome Android)
    if ('periodicSync' in reg) {
      try {
        await reg.periodicSync.register('ssz-streak-check', { minInterval: 20 * 60 * 60 * 1000 })
        console.log('[SW] Periodic sync registered')
      } catch(e) {
        console.log('[SW] Periodic sync not supported')
      }
    }

    return { ok: true, msg: 'Streak notifications enabled! 🔥' }
  } catch(e) {
    console.error('[notifications] enable error', e)
    return { ok: false, msg: 'Could not enable notifications.' }
  }
}

/* ── Disable notifications ── */
export async function disablePushNotifications(DB) {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) await sub.unsubscribe()
    await DB.removePushSubscription()
    return { ok: true }
  } catch(e) {
    return { ok: false }
  }
}

/* ── Check current permission state ── */
export function getNotificationStatus() {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission // 'default' | 'granted' | 'denied'
}

/* ── Tell SW the last training time (for streak check) ── */
export async function reportTrainingDone() {
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.ready
    reg.active?.postMessage({ type: 'SSZ_LAST_TRAIN', timestamp: Date.now() })
  } catch(e) {}
}

/* ── Schedule a local notification if streak at risk ── */
export async function scheduleStreakReminder() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  if (!('serviceWorker' in navigator)) return

  // Show a notification 20 hours after training if the page is still open
  // SW handles background case; this handles foreground tab left open
  setTimeout(async () => {
    const reg = await navigator.serviceWorker.ready
    reg.showNotification('🏸 Streak at risk!', {
      body   : "You haven't trained in 20 hours. Don't break your streak! 🔥",
      icon   : '/Badminton-AI-trainer_V2/favicon.png',
      tag    : 'ssz-streak',
      data   : { url: '/Badminton-AI-trainer_V2/trainer.html' },
      actions: [{ action: 'train', title: '▶ Train Now' }],
    })
  }, 20 * 60 * 60 * 1000) // 20 hours
}

/* ── Utility ── */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw     = atob(base64)
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)))
}
