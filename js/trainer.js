/* ============================================================
   Shuttlestepz — trainer.js
   AI Footwork Trainer Logic (auth-aware)
   ============================================================ */

// Guard: only run on trainer page
if (!document.getElementById('video')) throw new Error('Not trainer page')

// ── DOM refs ──────────────────────────────────────────────────
const video      = document.getElementById('video')
const canvas     = document.getElementById('overlay')
const ctx        = canvas.getContext('2d')
const poseBadge  = document.getElementById('pose-badge')
const feedback   = document.getElementById('feedback')
const dirText    = document.getElementById('dir-text')
const tArc       = document.getElementById('t-arc')
const tNum       = document.getElementById('t-num')
const sRound     = document.getElementById('s-round')
const sScore     = document.getElementById('s-score')
const sStreak    = document.getElementById('s-streak')
const sAcc       = document.getElementById('s-acc')
const pdots      = document.getElementById('pdots')
const modelStatus= document.getElementById('model-status')
const speedBar   = document.getElementById('speed-bar')
const speedVal   = document.getElementById('speed-val')

const setupScreen  = document.getElementById('screen-setup')
const resultScreen = document.getElementById('screen-results')

// ── Sliders ────────────────────────────────────────────────────
const slRounds = document.getElementById('sl-rounds')
const slTime   = document.getElementById('sl-time')
const chkVoice = document.getElementById('chk-voice')
const chkBeep  = document.getElementById('chk-beep')

slRounds.oninput = () => document.getElementById('lbl-rounds').textContent = slRounds.value
slTime.oninput   = () => document.getElementById('lbl-time').textContent   = slTime.value + 's'

// ── Difficulty ────────────────────────────────────────────────
const DIFFICULTY = {
  easy  : { rounds: 8,  time: 6, label: '6s per direction · 8 rounds · beginner' },
  medium: { rounds: 10, time: 4, label: '4s per direction · 10 rounds · standard' },
  hard  : { rounds: 15, time: 3, label: '3s per direction · 15 rounds · competitive' },
  pro   : { rounds: 20, time: 2, label: '2s per direction · 20 rounds · elite' },
}

let selectedDiff = 'medium'

document.querySelectorAll('.dp').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return
    document.querySelectorAll('.dp').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
    selectedDiff = btn.dataset.diff
    const d = DIFFICULTY[selectedDiff]
    document.getElementById('diff-desc').textContent = d.label
    slRounds.value = d.rounds; slTime.value = d.time
    document.getElementById('lbl-rounds').textContent = d.rounds
    document.getElementById('lbl-time').textContent   = d.time + 's'
  })
})

// ── Zone groups ───────────────────────────────────────────────
const ZONE_GROUPS = {
  all   : ['FRONT','BACK','LEFT','RIGHT','LEFT CORNER','RIGHT CORNER','BACK LEFT','BACK RIGHT'],
  front : ['LEFT CORNER','RIGHT CORNER'],
  back  : ['BACK LEFT','BACK RIGHT'],
  centre: ['LEFT','RIGHT'],
}
const ZONES = ZONE_GROUPS.all
let activeZones   = ZONE_GROUPS.all
let selectedGroup = 'all'

document.querySelectorAll('.zg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.zg-btn').forEach(b => b.classList.remove('selected'))
    btn.classList.add('selected')
    selectedGroup = btn.dataset.group
  })
})

// ── Thresholds ────────────────────────────────────────────────
const THRESH_X    = 0.12
const THRESH_Y    = 0.10
const SMOOTH_ALPHA= 0.4

// ── State ──────────────────────────────────────────────────────
let detector    = null
let animFrameId = null
let poseRunning = false

let smoothHipX = null, smoothHipY = null
let smoothFeetX= null, smoothFeetY= null

function ema(prev, next) {
  return prev === null ? next : prev * (1 - SMOOTH_ALPHA) + next * SMOOTH_ALPHA
}

let session = {
  totalRounds:10, timePerDir:4, voiceOn:true, beepOn:true,
  round:0, score:0, streak:0, bestStreak:0, hits:0,
  results:[], dirStats:{}, roundTimings:[], difficulty:'medium',
  active:false, currentDir:null, roundStart:0,
  waitingForReturn:false, timerInterval:null, timerEnd:0,
}

let centerX=null, centerY=null, frameW=640, frameH=480
let hipX=null, hipY=null, feetX=null, feetY=null
let calibrated=false, calibFrames=0, calibSumX=0, calibSumY=0
const CALIB_FRAMES = 25

// ── Audio ──────────────────────────────────────────────────────
let audioCtx = null
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return audioCtx
}
function beep(freq=880, dur=0.12, vol=0.4, type='sine') {
  try {
    const ac=getAudio(), osc=ac.createOscillator(), g=ac.createGain()
    osc.connect(g); g.connect(ac.destination)
    osc.type=type; osc.frequency.value=freq
    g.gain.setValueAtTime(vol, ac.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime+dur)
    osc.start(); osc.stop(ac.currentTime+dur)
  } catch(e){}
}
function successSound(){ beep(660,.07,.3); setTimeout(()=>beep(880,.12,.35),70); setTimeout(()=>beep(1100,.09,.2),160) }
function failSound(){    beep(220,.18,.35,'sawtooth'); setTimeout(()=>beep(180,.15,.2,'sawtooth'),120) }
function calibSound(){   beep(440,.1,.2); setTimeout(()=>beep(660,.15,.25),100) }

// ── Speech ─────────────────────────────────────────────────────
let voices=[]
window.speechSynthesis.onvoiceschanged = () => { const v=window.speechSynthesis.getVoices(); if(v.length) voices=v }
setTimeout(() => { const v=window.speechSynthesis.getVoices(); if(v.length) voices=v }, 200)

function speak(text) {
  if (!session.voiceOn) return
  window.speechSynthesis.cancel()
  setTimeout(() => {
    const u = new SpeechSynthesisUtterance(text)
    u.rate=1.1; u.pitch=1.0; u.volume=1.0
    const en = voices.find(v=>v.lang.startsWith('en')&&!v.name.includes('Google'))
            || voices.find(v=>v.lang.startsWith('en')) || voices[0]
    if (en) u.voice = en
    window.speechSynthesis.speak(u)
  }, 60)
}

// ── Camera ─────────────────────────────────────────────────────
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({video:{width:640,height:480,facingMode:'user'}})
  video.srcObject = stream
  return new Promise(resolve => {
    video.onloadedmetadata = () => {
      video.play()
      frameW = video.videoWidth||640; frameH = video.videoHeight||480
      canvas.width=frameW; canvas.height=frameH
      resolve()
    }
  })
}

// ── Model ──────────────────────────────────────────────────────
async function loadModel() {
  modelStatus.className = 'err'
  modelStatus.textContent = 'Loading MoveNet…'
  try {
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { runtime:'tfjs', modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
    )
    poseBadge.textContent = 'CALIBRATING'
    poseBadge.classList.add('tracking')
    modelStatus.className = 'ok'
    modelStatus.textContent = 'AI ready ✓ — stand in frame to calibrate'
  } catch(err) {
    modelStatus.className = 'err'
    modelStatus.textContent = '❌ Model failed — check connection'
    throw err
  }
}

// ── Pose loop ──────────────────────────────────────────────────
async function detectPose() {
  if (!poseRunning) return
  try {
    const poses = await detector.estimatePoses(video)
    ctx.clearRect(0,0,canvas.width,canvas.height)
    ctx.save()

    if (poses.length > 0) {
      const kp=poses[0].keypoints
      const lHip=kp[11], rHip=kp[12], lAnkle=kp[15], rAnkle=kp[16]

      if (lHip.score>.3 && rHip.score>.3) {
        const rHX=(lHip.x+rHip.x)/2, rHY=(lHip.y+rHip.y)/2
        smoothHipX=ema(smoothHipX,rHX); smoothHipY=ema(smoothHipY,rHY)
        hipX=smoothHipX; hipY=smoothHipY

        if (lAnkle.score>.25 && rAnkle.score>.25) {
          const rFX=(lAnkle.x+rAnkle.x)/2, rFY=(lAnkle.y+rAnkle.y)/2
          smoothFeetX=ema(smoothFeetX,rFX); smoothFeetY=ema(smoothFeetY,rFY)
        } else if (lAnkle.score>.25) {
          smoothFeetX=ema(smoothFeetX,lAnkle.x); smoothFeetY=ema(smoothFeetY,lAnkle.y)
        } else if (rAnkle.score>.25) {
          smoothFeetX=ema(smoothFeetX,rAnkle.x); smoothFeetY=ema(smoothFeetY,rAnkle.y)
        } else {
          smoothFeetX=hipX; smoothFeetY=hipY
        }
        feetX=smoothFeetX; feetY=smoothFeetY

        if (!calibrated) {
          calibSumX+=hipX; calibSumY+=hipY; calibFrames++
          if (calibFrames >= CALIB_FRAMES) {
            centerX=calibSumX/calibFrames; centerY=calibSumY/calibFrames
            calibrated=true
            poseBadge.textContent='TRACKING'; poseBadge.classList.remove('lost')
            feedback.textContent='Calibrated — starting…'
            calibSound()
          } else {
            const pct=Math.round(calibFrames/CALIB_FRAMES*100)
            poseBadge.textContent=`CAL ${pct}%`
            feedback.textContent='Hold still at centre… calibrating'
          }
        } else {
          poseBadge.textContent='TRACKING'
          poseBadge.classList.remove('lost'); poseBadge.classList.add('tracking')
          if (session.active) checkZone(hipX,hipY,feetX,feetY)
        }

        drawSkeleton(kp)
        drawTrackingPoints()
        if (session.active && session.currentDir && calibrated) drawTargetZone(session.currentDir)
      } else { lostPose() }
    } else { lostPose() }
    ctx.restore()
  } catch(e){ ctx.restore() }
  animFrameId = requestAnimationFrame(detectPose)
}

function drawTrackingPoints() {
  if (feetX && feetX !== hipX) {
    ctx.beginPath(); ctx.arc(feetX,feetY,13,0,Math.PI*2)
    ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=2; ctx.stroke()
    ctx.beginPath(); ctx.arc(feetX,feetY,4,0,Math.PI*2)
    ctx.fillStyle='#ffffff'; ctx.fill()
  }
  if (hipX) {
    ctx.beginPath(); ctx.arc(hipX,hipY,10,0,Math.PI*2)
    ctx.fillStyle='rgba(56,210,90,0.2)'; ctx.fill()
    ctx.beginPath(); ctx.arc(hipX,hipY,4,0,Math.PI*2)
    ctx.fillStyle='#38d25a'; ctx.fill()
  }
}

function lostPose() {
  hipX=null;hipY=null;feetX=null;feetY=null
  poseBadge.textContent='NO PERSON'
  poseBadge.classList.remove('tracking'); poseBadge.classList.add('lost')
}

// ── Skeleton ───────────────────────────────────────────────────
const SKEL_PAIRS=[[5,6],[5,7],[7,9],[6,8],[8,10],[11,12],[5,11],[6,12],[11,13],[13,15],[12,14],[14,16]]
const JCOLORS={0:'#00e5ff',1:'#00e5ff',2:'#00e5ff',3:'#00e5ff',4:'#00e5ff',5:'#ffe033',6:'#ffe033',7:'#ffe033',8:'#ffe033',9:'#ffe033',10:'#ffe033',11:'#38d25a',12:'#38d25a',13:'#f09040',14:'#f09040',15:'#f09040',16:'#f09040'}
const JRADII={0:4,1:3,2:3,3:3,4:3,5:6,6:6,7:5,8:5,9:5,10:5,11:9,12:9,13:7,14:7,15:7,16:7}

function drawSkeleton(kp) {
  const T=0.25
  ctx.lineWidth=2.5
  for (const [a,b] of SKEL_PAIRS) {
    const pa=kp[a],pb=kp[b]
    if (pa.score>T && pb.score>T) {
      const g=ctx.createLinearGradient(pa.x,pa.y,pb.x,pb.y)
      g.addColorStop(0,(JCOLORS[a]||'#fff')+'aa'); g.addColorStop(1,(JCOLORS[b]||'#fff')+'aa')
      ctx.strokeStyle=g; ctx.beginPath(); ctx.moveTo(pa.x,pa.y); ctx.lineTo(pb.x,pb.y); ctx.stroke()
    }
  }
  for (let i=0;i<kp.length;i++) {
    const p=kp[i]; if(p.score<T) continue
    const c=JCOLORS[i]||'#fff', r=JRADII[i]||5
    ctx.beginPath(); ctx.arc(p.x,p.y,r+3,0,Math.PI*2); ctx.fillStyle=c+'33'; ctx.fill()
    ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fillStyle=c; ctx.fill()
    if (p.score>.6 && r>=5) {
      ctx.beginPath(); ctx.arc(p.x,p.y,2,0,Math.PI*2); ctx.fillStyle='rgba(255,255,255,0.85)'; ctx.fill()
    }
  }
}

function drawTargetZone(dir) {
  if (!calibrated||!centerX) return
  const tw=frameW*THRESH_X*1.5, th=frameH*THRESH_Y*1.5
  const [tx,ty]=zoneTarget(dir,centerX,centerY,frameW,frameH)
  ctx.strokeStyle='rgba(56,210,90,0.8)'; ctx.lineWidth=2
  ctx.setLineDash([6,4]); ctx.strokeRect(tx-tw,ty-th,tw*2,th*2); ctx.setLineDash([])
  ctx.fillStyle='rgba(56,210,90,0.07)'; ctx.fillRect(tx-tw,ty-th,tw*2,th*2)
  // Corners
  const cs=8, corners=[[tx-tw,ty-th,1,1],[tx+tw,ty-th,-1,1],[tx-tw,ty+th,1,-1],[tx+tw,ty+th,-1,-1]]
  ctx.strokeStyle='rgba(56,210,90,0.9)'; ctx.lineWidth=2.5
  for (const [cx,cy,sx,sy] of corners) {
    ctx.beginPath(); ctx.moveTo(cx+sx*cs,cy); ctx.lineTo(cx,cy); ctx.lineTo(cx,cy+sy*cs); ctx.stroke()
  }
}

// ── Zone math ──────────────────────────────────────────────────
function zoneTarget(dir,cx,cy,fw,fh) {
  const ox=fw*.20, oy=fh*.18
  return ({
    'FRONT':[cx,cy+oy],'BACK':[cx,cy-oy],'LEFT':[cx+ox,cy],'RIGHT':[cx-ox,cy],
    'LEFT CORNER':[cx+ox,cy+oy],'RIGHT CORNER':[cx-ox,cy+oy],
    'BACK LEFT':[cx+ox,cy-oy],'BACK RIGHT':[cx-ox,cy-oy],
  })[dir] || [cx,cy]
}

function isInZone(dir,x,y) {
  if (!calibrated||!centerX) return false
  const [tx,ty]=zoneTarget(dir,centerX,centerY,frameW,frameH)
  return Math.abs(x-tx)<frameW*THRESH_X*1.6 && Math.abs(y-ty)<frameH*THRESH_Y*1.6
}

// ── Timer ring ─────────────────────────────────────────────────
const CIRC = 2*Math.PI*34

function setRing(frac,urgent=false) {
  tArc.style.strokeDashoffset = CIRC*(1-Math.max(0,Math.min(1,frac)))
  tArc.style.stroke = urgent ? 'var(--amber)' : 'var(--accent)'
}

function startRingTimer(ms) {
  clearInterval(session.timerInterval)
  session.timerEnd = Date.now()+ms
  session.timerInterval = setInterval(()=>{
    const rem=session.timerEnd-Date.now(), frac=rem/ms
    tNum.textContent=Math.max(0,Math.ceil(rem/1000))
    setRing(frac, frac<.3)
    if (rem<=0) clearInterval(session.timerInterval)
  },60)
}

// ── Dots ───────────────────────────────────────────────────────
function buildDots(n) {
  pdots.innerHTML=''
  for (let i=0;i<n;i++) {
    const d=document.createElement('div'); d.className='dot'; d.id=`dot-${i}`; pdots.appendChild(d)
  }
}
function setDot(i,cls) {
  const d=document.getElementById(`dot-${i}`)
  if(d){d.classList.remove('ok','bad');d.classList.add(cls)}
}

// ── Stats display ──────────────────────────────────────────────
function updateStats() {
  sRound.textContent=`${session.round}/${session.totalRounds}`
  sScore.textContent=session.score
  sStreak.textContent=session.streak
  sAcc.textContent=session.round===0?'—':Math.round(session.hits/session.round*100)+'%'
}

function updateSpeedDisplay(ms,maxMs) {
  if (!ms) { speedBar.style.width='0%'; speedVal.textContent='—'; return }
  const pct=Math.max(5,Math.round((1-ms/maxMs)*100))
  speedBar.style.width=pct+'%'
  speedBar.style.background=pct>=70?'var(--accent)':pct>=40?'var(--amber)':'var(--red)'
  speedVal.textContent=(ms/1000).toFixed(2)+'s'
}

function allZonePills() { ZONES.forEach(z=>{const e=document.getElementById(`zp-${z}`);if(e)e.className='zp'}) }
function highlightZone(dir,cls) {
  allZonePills()
  const e=document.getElementById(`zp-${dir}`)
  if(e) e.classList.add(cls||'active')
}

// ── Round flow ─────────────────────────────────────────────────
let hitDetected=false, currentZoneCheckInterval=null

function startRound() {
  if (session.round>=session.totalRounds) { endSession(); return }

  let dir
  do { dir=activeZones[Math.floor(Math.random()*activeZones.length)] }
  while (dir===session.currentDir && activeZones.length>1)

  session.currentDir=dir; session.active=true
  session.waitingForReturn=false; hitDetected=false
  session.roundStart=Date.now()

  dirText.textContent=dir; dirText.className='dir-text'
  highlightZone(dir); feedback.textContent='Move to zone!'
  startRingTimer(session.timePerDir*1000)
  speak(dir.toLowerCase())
  if (session.beepOn) setTimeout(()=>beep(660,.09),350)

  clearInterval(currentZoneCheckInterval)
  currentZoneCheckInterval=setInterval(()=>{
    if (!session.active) return
    if (Date.now()>=session.timerEnd) { clearInterval(currentZoneCheckInterval); scoreRound(false) }
  },80)
}

function checkZone(hx,hy,fx,fy) {
  if (!session.active||hitDetected||session.waitingForReturn) return
  const dir=session.currentDir
  const useFeet=['FRONT','BACK','LEFT CORNER','RIGHT CORNER','BACK LEFT','BACK RIGHT']
  const ux=useFeet.includes(dir)?fx:hx, uy=useFeet.includes(dir)?fy:hy
  if (!ux||!uy) return
  if (isInZone(dir,ux,uy)) {
    hitDetected=true
    clearInterval(currentZoneCheckInterval)
    scoreRound(true, Date.now()-session.roundStart)
  }
}

function scoreRound(hit, responseMs=null) {
  session.active=false
  clearInterval(currentZoneCheckInterval); clearInterval(session.timerInterval)
  const dir=session.currentDir, rIdx=session.round

  if (!session.dirStats[dir]) session.dirStats[dir]={total:0,hit:0,totalMs:0}
  session.dirStats[dir].total++

  if (hit) {
    session.hits++; session.streak++
    if (session.streak>session.bestStreak) session.bestStreak=session.streak
    let pts=10
    if (responseMs) { const fast=Math.max(0,session.timePerDir*1000-responseMs); pts+=Math.round(fast/200) }
    session.score+=pts; session.dirStats[dir].hit++
    if (responseMs) { session.roundTimings.push(responseMs); session.dirStats[dir].totalMs+=responseMs }
    session.results.push({dir,hit:true,responseMs,pts})
    dirText.classList.add('hit','pulse')
    highlightZone(dir,'ok')
    feedback.textContent=`✓ HIT! +${pts} pts`
    setDot(rIdx,'ok'); successSound()
    updateSpeedDisplay(responseMs, session.timePerDir*1000)
    if (session.voiceOn) setTimeout(()=>speak('nice'),180)
  } else {
    session.streak=0; session.results.push({dir,hit:false,responseMs:null,pts:0})
    dirText.classList.add('miss'); highlightZone(dir,'bad')
    feedback.textContent='✗ MISSED'
    setDot(rIdx,'bad'); failSound()
    updateSpeedDisplay(null, session.timePerDir*1000)
  }

  session.round++; updateStats()

  setTimeout(()=>{
    allZonePills()
    dirText.textContent=session.round>=session.totalRounds?'DONE!':'CENTRE'
    dirText.className='dir-text'; tNum.textContent='—'; setRing(1)
    if (session.round>=session.totalRounds) setTimeout(endSession,800)
    else setTimeout(startRound,1200)
  },900)
}

// ── Session ────────────────────────────────────────────────────
function beginSession() {
  session.totalRounds=parseInt(slRounds.value); session.timePerDir=parseInt(slTime.value)
  session.voiceOn=chkVoice.checked; session.beepOn=chkBeep.checked
  session.difficulty=selectedDiff
  activeZones=ZONE_GROUPS[selectedGroup]||ZONE_GROUPS.all
  session.round=0; session.score=0; session.streak=0; session.bestStreak=0; session.hits=0
  session.results=[]; session.dirStats={}; session.roundTimings=[]
  session.currentDir=null; session.active=false
  buildDots(session.totalRounds); updateStats()
  dirText.textContent='GET READY'; dirText.className='dir-text'
  setRing(1); updateSpeedDisplay(null, session.timePerDir*1000)
  feedback.textContent=calibrated?'Starting in 2s…':'Stand still to calibrate…'
  const w=setInterval(()=>{ if(calibrated){ clearInterval(w); feedback.textContent='GO!'; setTimeout(startRound,600) } },300)
}

function endSession() {
  session.active=false
  clearInterval(currentZoneCheckInterval); clearInterval(session.timerInterval)
  poseRunning=false
  if (animFrameId) cancelAnimationFrame(animFrameId)

  // Save to auth system
  try { AUTH.recordSession(session); AUTH.incrementSession() } catch(e){}

  showResults()
}

// ── Results ────────────────────────────────────────────────────
function showResults() {
  resultScreen.classList.add('active')
  const acc=session.totalRounds>0?Math.round(session.hits/session.totalRounds*100):0
  const avgMs=session.roundTimings.length?Math.round(session.roundTimings.reduce((a,b)=>a+b,0)/session.roundTimings.length):null
  const grade=acc>=90?'S RANK — ELITE':acc>=75?'A RANK — SHARP':acc>=60?'B RANK — SOLID':acc>=40?'C RANK — KEEP GOING':'D RANK — NEEDS WORK'

  document.getElementById('r-score').textContent=session.score
  document.getElementById('r-grade').textContent=grade
  document.getElementById('r-acc').textContent=acc+'%'
  document.getElementById('r-streak').textContent=session.bestStreak
  document.getElementById('r-speed').textContent=avgMs?(avgMs/1000).toFixed(2)+'s':'—'
  document.getElementById('r-rounds').textContent=session.totalRounds

  const bd=document.getElementById('r-bd')
  bd.innerHTML=''
  ZONES.forEach(dir=>{
    const st=session.dirStats[dir]; if(!st||!st.total) return
    const pct=Math.round(st.hit/st.total*100)
    const color=pct>=80?'var(--accent)':pct>=50?'var(--amber)':'var(--red)'
    bd.innerHTML+=`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="font-family:var(--font-mono);font-size:10px;color:var(--text2);min-width:88px;letter-spacing:1px">${dir}</div>
      <div style="flex:1;height:5px;background:var(--bg3);border-radius:3px;overflow:hidden">
        <div style="height:100%;border-radius:3px;width:${pct}%;background:${color};transition:width .9s ease"></div></div>
      <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:${color};min-width:34px;text-align:right">${pct}%</div>
    </div>`
  })
  speak(grade.split('—')[1]?.trim()||grade)
}

// ── Buttons ────────────────────────────────────────────────────
document.getElementById('btn-start-session').addEventListener('click', async () => {
  setupScreen.classList.remove('active')
  try { getAudio() } catch(e){}
  try {
    await startCamera()
    await loadModel()
    poseRunning=true
    detectPose()
    setTimeout(beginSession,500)
  } catch(err) {
    modelStatus.textContent='Error: '+(err.message||err)
    modelStatus.className='err'
    setupScreen.classList.add('active')
  }
})

document.getElementById('btn-stop').addEventListener('click', ()=>{
  session.active=false
  clearInterval(currentZoneCheckInterval); clearInterval(session.timerInterval)
  poseRunning=false
  if (animFrameId) cancelAnimationFrame(animFrameId)
  if (video.srcObject) video.srcObject.getTracks().forEach(t=>t.stop())
  try { AUTH.recordSession(session); AUTH.incrementSession() } catch(e){}
  showResults()
})

document.getElementById('btn-again').addEventListener('click', ()=>{
  resultScreen.classList.remove('active')
  // Reset pose tracking
  calibrated=false; calibFrames=0; calibSumX=0; calibSumY=0
  centerX=null; centerY=null; hipX=null; hipY=null
  smoothHipX=null; smoothHipY=null; smoothFeetX=null; smoothFeetY=null
  // Check limit
  if (!AUTH.canStartSession()) {
    document.getElementById('lock-overlay').classList.remove('hidden')
  } else {
    setupScreen.classList.add('active')
  }
})

document.addEventListener('keydown', e => {
  if (e.key==='Escape') document.getElementById('btn-stop').click()
})
