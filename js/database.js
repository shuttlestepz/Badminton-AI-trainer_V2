/* ============================================================
   Shuttlestepz — database.js
   Firebase Firestore + Auth (Email/Password)
   Real-time listeners · Full data layer
   ============================================================
   COLLECTIONS LAYOUT
   ──────────────────
   users/{uid}
     ├── profile      : { displayName, email, role, schoolCode, plan, createdAt }
     ├── xp           : number
     ├── level        : number
     ├── totalSessions: number
     ├── bestStreak   : number
     └── settings     : { voiceOn, beepOn, preferredDiff, preferredGroup }

   sessions/{uid}/records/{autoId}
     ├── drill, mode, score, accuracy, hits, totalRounds
     ├── bestStreak, xpEarned, reactionTime, createdAt
     └── consistency, movement  (endurance only)

   leaderboard/{uid}
     ├── displayName, xp, level, role, updatedAt
   ============================================================ */

import { initializeApp }                from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc,
  addDoc, deleteDoc,
  collection, query, orderBy, limit,
  onSnapshot, serverTimestamp, increment,
  getDocs, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'

/* ── 1. FIREBASE CONFIG ─────────────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey            : 'AIzaSyDAznGVHeLIAR6pPSVewiw3hUpSPYtXgO4',
  authDomain        : 'shuttlestepz-bac23.firebaseapp.com',
  projectId         : 'shuttlestepz-bac23',
  storageBucket     : 'shuttlestepz-bac23.firebasestorage.app',
  messagingSenderId : '167174250097',
  appId             : '1:167174250097:web:d2b2cd1afa8818005fc5d0',
  measurementId     : 'G-Y0CJ1JVD45',
}

/* ── Creator emails (always get premium free) ───────────────── */
const CREATOR_EMAILS = [
  'techycoder1@gmail.com',   // ← your email — always premium
]

const app  = initializeApp(FIREBASE_CONFIG)
const auth = getAuth(app)
const db   = getFirestore(app)

/* ── 2. STATE ────────────────────────────────────────────────── */
let currentUser      = null
const _unsubscribers = {}

/* ═══════════════════════════════════════════════════════════════
   3. AUTH
═══════════════════════════════════════════════════════════════ */

export async function registerUser({ email, password, displayName, role = 'student', schoolCode = '' }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password)
  const uid  = cred.user.uid
  await updateProfile(cred.user, { displayName })
  await setDoc(doc(db, 'users', uid), {
    profile: {
      displayName,
      email,
      role,
      schoolCode : schoolCode.toUpperCase(),
      plan       : 'free',
      createdAt  : serverTimestamp(),
    },
    xp            : 0,
    level         : 1,
    totalSessions : 0,
    bestStreak    : 0,
    settings: {
      voiceOn        : true,
      beepOn         : true,
      preferredDiff  : 'medium',
      preferredGroup : 'all',
    },
  })
  await _syncLeaderboard(uid, { displayName, xp: 0, level: 1, role })
  return cred.user
}

export async function loginUser({ email, password }) {
  const cred = await signInWithEmailAndPassword(auth, email, password)
  return cred.user
}

export async function logoutUser() {
  _teardownAllListeners()
  await signOut(auth)
  currentUser = null
  window.dispatchEvent(new CustomEvent('ss-auth-change', { detail: { user: null } }))
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email)
}

export function onAuthReady(callback) {
  return onAuthStateChanged(auth, async (user) => {
    currentUser = user
    if (user) {
      const snap = await getDoc(doc(db, 'users', user.uid))
      if (!snap.exists()) {
        await setDoc(doc(db, 'users', user.uid), {
          profile: {
            displayName : user.displayName || user.email,
            email       : user.email,
            role        : 'student',
            schoolCode  : '',
            plan        : 'free',
            createdAt   : serverTimestamp(),
          },
          xp: 0, level: 1, totalSessions: 0, bestStreak: 0,
          settings: { voiceOn:true, beepOn:true, preferredDiff:'medium', preferredGroup:'all' },
        })
      }
    }
    window.dispatchEvent(new CustomEvent('ss-auth-change', { detail: { user } }))
    callback(user)
  })
}

export function getCurrentUser() { return currentUser }

/* ═══════════════════════════════════════════════════════════════
   4. USER PROFILE
═══════════════════════════════════════════════════════════════ */

export async function getUserProfile(uid = null) {
  // Accept explicit uid OR fall back to currentUser
  const id = uid || currentUser?.uid
  if (!id) throw new Error('No authenticated user and no uid provided.')
  const snap = await getDoc(doc(db, 'users', id))
  if (!snap.exists()) throw new Error(`User ${id} not found`)
  return { uid: id, ...snap.data() }
}

export async function updateUserProfile(updates) {
  const uid  = _requireUID()
  const safe = {}
  if (updates.displayName) safe['profile.displayName'] = updates.displayName
  if (updates.role)        safe['profile.role']        = updates.role
  if (updates.schoolCode)  safe['profile.schoolCode']  = updates.schoolCode.toUpperCase()
  if (updates.plan)        safe['profile.plan']        = updates.plan
  await updateDoc(doc(db, 'users', uid), safe)
  if (updates.displayName) {
    await updateProfile(auth.currentUser, { displayName: updates.displayName })
    await _syncLeaderboard(uid, { displayName: updates.displayName })
  }
}

export function listenUserProfile(callback) {
  const uid = _requireUID()
  _teardown('userProfile')
  const unsub = onSnapshot(doc(db, 'users', uid), (snap) => {
    if (snap.exists()) callback({ uid, ...snap.data() })
  })
  _unsubscribers['userProfile'] = unsub
  return unsub
}

/* ═══════════════════════════════════════════════════════════════
   5. XP & LEVEL
═══════════════════════════════════════════════════════════════ */

const XP_THRESHOLDS = [0, 500, 1200, 2200, 3500, 5200, 7200, 9800, 13000, 17000, 22000]

function _calcLevel(xp) {
  let lv = 1
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) lv = i + 1; else break
  }
  return Math.min(lv, XP_THRESHOLDS.length)
}

export async function awardXP(amount) {
  const uid      = _requireUID()
  const snap     = await getDoc(doc(db, 'users', uid))
  const data     = snap.data()
  const oldXP    = data.xp    || 0
  const oldLevel = data.level || 1
  const newXP    = oldXP + amount
  const newLevel = _calcLevel(newXP)
  await updateDoc(doc(db, 'users', uid), { xp: newXP, level: newLevel })
  await _syncLeaderboard(uid, { xp: newXP, level: newLevel })
  return { newXP, newLevel, leveledUp: newLevel > oldLevel }
}

export async function getXPProgress(uid = null) {
  const id   = uid || _requireUID()
  const snap = await getDoc(doc(db, 'users', id))
  const { xp = 0, level = 1 } = snap.data()
  const cur  = XP_THRESHOLDS[level - 1] || 0
  const nxt  = XP_THRESHOLDS[level]     || XP_THRESHOLDS[XP_THRESHOLDS.length - 1]
  return {
    xp,
    level,
    toNextLevel : nxt - xp,
    pct         : Math.min(Math.max((xp - cur) / (nxt - cur), 0), 1) * 100,
  }
}

/* ═══════════════════════════════════════════════════════════════
   6. SESSIONS
═══════════════════════════════════════════════════════════════ */

export async function saveSession(sessionData) {
  const uid = _requireUID()
  const ref = await addDoc(collection(db, 'sessions', uid, 'records'), {
    drill        : sessionData.drill        || 'footwork',
    mode         : sessionData.mode         || 'footwork',
    score        : sessionData.score        || 0,
    accuracy     : sessionData.accuracy     || 0,
    hits         : sessionData.hits         || 0,
    totalRounds  : sessionData.totalRounds  || 0,
    bestStreak   : sessionData.bestStreak   || 0,
    xpEarned     : sessionData.xpEarned     || 0,
    reactionTime : sessionData.reactionTime || null,
    consistency  : sessionData.consistency  || null,
    movement     : sessionData.movement     || null,
    createdAt    : serverTimestamp(),
  })
  const userRef  = doc(db, 'users', uid)
  const userSnap = await getDoc(userRef)
  const userData = userSnap.data()
  const newBest  = Math.max(userData.bestStreak || 0, sessionData.bestStreak || 0)
  await updateDoc(userRef, { totalSessions: increment(1), bestStreak: newBest })
  return ref.id
}

export async function getSessions({ uid = null, limitN = 20 } = {}) {
  const id   = uid || currentUser?.uid
  if (!id) throw new Error('No authenticated user and no uid provided.')
  const q    = query(
    collection(db, 'sessions', id, 'records'),
    orderBy('createdAt', 'desc'),
    limit(limitN)
  )
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export function listenSessions(callback, limitN = 20) {
  const uid = _requireUID()
  _teardown('sessions')
  const q = query(
    collection(db, 'sessions', uid, 'records'),
    orderBy('createdAt', 'desc'),
    limit(limitN)
  )
  const unsub = onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  })
  _unsubscribers['sessions'] = unsub
  return unsub
}

export async function getSessionStats(uid = null) {
  const id       = uid || _requireUID()
  const snap     = await getDoc(doc(db, 'users', id))
  const data     = snap.data()
  const sessions = await getSessions({ uid: id, limitN: 200 })
  const totalXP  = sessions.reduce((s, r) => s + (r.xpEarned || 0), 0)
  const avgScore = sessions.length
    ? Math.round(sessions.reduce((s, r) => s + r.score, 0)    / sessions.length) : 0
  const avgAcc   = sessions.length
    ? Math.round(sessions.reduce((s, r) => s + r.accuracy, 0) / sessions.length) : 0
  return {
    totalSessions : data.totalSessions || 0,
    totalXP,
    bestStreak    : data.bestStreak    || 0,
    avgScore,
    avgAccuracy   : avgAcc,
  }
}

export async function deleteSession(sessionId) {
  const uid = _requireUID()
  await deleteDoc(doc(db, 'sessions', uid, 'records', sessionId))
}

/* ═══════════════════════════════════════════════════════════════
   7. LEADERBOARD
═══════════════════════════════════════════════════════════════ */

export function listenLeaderboard(callback, topN = 50) {
  _teardown('leaderboard')
  const q = query(
    collection(db, 'leaderboard'),
    orderBy('xp', 'desc'),
    limit(topN)
  )
  const unsub = onSnapshot(q, (snap) => {
    const entries = snap.docs.map((d, i) => ({
      uid         : d.id,
      rank        : i + 1,
      displayName : d.data().displayName,
      xp          : d.data().xp,
      level       : d.data().level,
      role        : d.data().role,
    }))
    callback(entries)
  })
  _unsubscribers['leaderboard'] = unsub
  return unsub
}

export async function getUserRank(uid = null) {
  const id   = uid || _requireUID()
  const snap = await getDoc(doc(db, 'leaderboard', id))
  if (!snap.exists()) return null
  const myXP = snap.data().xp || 0
  const q    = query(collection(db, 'leaderboard'), where('xp', '>', myXP))
  const above= await getDocs(q)
  return above.size + 1
}

/* ═══════════════════════════════════════════════════════════════
   8. SETTINGS
═══════════════════════════════════════════════════════════════ */

export async function getSettings(uid = null) {
  const id   = uid || _requireUID()
  const snap = await getDoc(doc(db, 'users', id))
  return snap.data()?.settings || {}
}

export async function saveSettings(settings) {
  const uid     = _requireUID()
  const patch   = {}
  const allowed = ['voiceOn', 'beepOn', 'preferredDiff', 'preferredGroup']
  allowed.forEach(k => { if (settings[k] !== undefined) patch[`settings.${k}`] = settings[k] })
  await updateDoc(doc(db, 'users', uid), patch)
}

export function listenSettings(callback) {
  const uid = _requireUID()
  _teardown('settings')
  const unsub = onSnapshot(doc(db, 'users', uid), (snap) => {
    if (snap.exists()) callback(snap.data()?.settings || {})
  })
  _unsubscribers['settings'] = unsub
  return unsub
}

/* ═══════════════════════════════════════════════════════════════
   9. SCHOOL / COACH
═══════════════════════════════════════════════════════════════ */

export async function getStudentsBySchoolCode(schoolCode) {
  const q    = query(
    collection(db, 'users'),
    where('profile.schoolCode', '==', schoolCode.toUpperCase()),
    where('profile.role', '==', 'student')
  )
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }))
}

export function listenStudentsBySchoolCode(schoolCode, callback) {
  _teardown('students')
  const q = query(
    collection(db, 'users'),
    where('profile.schoolCode', '==', schoolCode.toUpperCase()),
    where('profile.role', '==', 'student')
  )
  const unsub = onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ uid: d.id, ...d.data() })))
  })
  _unsubscribers['students'] = unsub
  return unsub
}

/* ═══════════════════════════════════════════════════════════════
   10. RESET
═══════════════════════════════════════════════════════════════ */

export async function resetUserData() {
  const uid   = _requireUID()
  const batch = writeBatch(db)
  batch.update(doc(db, 'users', uid), { xp:0, level:1, totalSessions:0, bestStreak:0 })
  batch.update(doc(db, 'leaderboard', uid), { xp:0, level:1, updatedAt:serverTimestamp() })
  await batch.commit()
  const sessions = await getSessions({ limitN: 500 })
  if (sessions.length > 0) {
    const del = writeBatch(db)
    sessions.forEach(s => del.delete(doc(db, 'sessions', uid, 'records', s.id)))
    await del.commit()
  }
}

/* ═══════════════════════════════════════════════════════════════
   11. LISTENER CLEANUP
═══════════════════════════════════════════════════════════════ */

export function unsubscribeAll() { _teardownAllListeners() }
export function unsubscribe(key) { _teardown(key) }

function _requireUID() {
  // 1. Firebase auth state (most reliable)
  if (currentUser?.uid) return currentUser.uid
  // 2. Session cache fallback (works before onAuthStateChanged fires)
  try {
    const cached = JSON.parse(sessionStorage.getItem('ssz_v2_user'))
    if (cached?.uid) return cached.uid
  } catch(e) {}
  throw new Error('No authenticated user.')
}
function _teardown(key) {
  if (_unsubscribers[key]) { _unsubscribers[key](); delete _unsubscribers[key] }
}
function _teardownAllListeners() {
  Object.keys(_unsubscribers).forEach(_teardown)
}
async function _syncLeaderboard(uid, patch = {}) {
  const ref  = doc(db, 'leaderboard', uid)
  const snap = await getDoc(ref)
  if (snap.exists()) {
    await updateDoc(ref, { ...patch, updatedAt: serverTimestamp() })
  } else {
    const uSnap = await getDoc(doc(db, 'users', uid))
    const p     = uSnap.exists() ? uSnap.data() : {}
    await setDoc(ref, {
      displayName : patch.displayName || p.profile?.displayName || 'Player',
      xp          : patch.xp         || p.xp    || 0,
      level       : patch.level      || p.level || 1,
      role        : patch.role       || p.profile?.role || 'student',
      updatedAt   : serverTimestamp(),
    })
  }
}

window.addEventListener('beforeunload', _teardownAllListeners)

/* ═══════════════════════════════════════════════════════════════
   12. DEFAULT EXPORT
═══════════════════════════════════════════════════════════════ */
export async function saveAITips(tips) {
  const uid = _requireUID()
  await setDoc(doc(db, 'users', uid, 'meta', 'ai_tips'), tips)
}

export async function getAITips(uid = null) {
  const id = uid || _requireUID()
  const snap = await getDoc(doc(db, 'users', id, 'meta', 'ai_tips'))
  return snap.exists() ? snap.data() : null
}

export default {
  registerUser, loginUser, logoutUser, resetPassword, onAuthReady, getCurrentUser,
  getUserProfile, updateUserProfile, listenUserProfile,
  awardXP, getXPProgress,
  saveSession, getSessions, listenSessions, getSessionStats, deleteSession,
  listenLeaderboard, getUserRank,
  getSettings, saveSettings, listenSettings,
  getStudentsBySchoolCode, listenStudentsBySchoolCode,
  unsubscribeAll, unsubscribe, resetUserData,saveAITips, getAITips,
}
