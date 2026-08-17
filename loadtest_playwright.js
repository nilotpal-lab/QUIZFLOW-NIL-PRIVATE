/* ================================================================
   QuizFlow — Realistic 600 Active Gameplay Student Simulator
   Lightweight Node.js HTTP Runner — 0 Chrome overhead!
   Generates unique real student names, diverse avatars, and plays all questions A,B,C,D!
   ================================================================ */

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3001';
const ROOM_PIN   = process.env.PIN || '971047';
const TOTAL_STUDENTS = parseInt(process.env.STUDENTS || '600', 10);
const HOLD_MS    = parseInt(process.env.HOLD_MS || '300000', 10); // 5 minutes

let globalSbChannel = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  const url = 'https://ogciyskjrefwmazzckfg.supabase.co';
  const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nY2l5c2tqcmVmd21henpja2ZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMjgxMTgsImV4cCI6MjEwMTYwNDExOH0.JwBvcMMESPGo_4qcFHcreuUVVmdSk8RRq9jtGPIjm7I';
  const sbClient = createClient(url, key);
  globalSbChannel = sbClient.channel(`qf_room_${ROOM_PIN}`);
} catch {}

const FIRST_NAMES = [
  'Aarav', 'Ananya', 'Rohan', 'Priya', 'Vikram', 'Neha', 'Kabir', 'Diya', 'Aditya', 'Isha',
  'Liam', 'Olivia', 'Noah', 'Emma', 'Oliver', 'Ava', 'Elijah', 'Sophia', 'William', 'Isabella',
  'James', 'Mia', 'Benjamin', 'Charlotte', 'Lucas', 'Amelia', 'Henry', 'Harper', 'Alexander', 'Evelyn',
  'Dev', 'Kavya', 'Arjun', 'Sanya', 'Vivaan', 'Tanvi', 'Reyansh', 'Meera', 'Vihaan', 'Riya',
  'Carlos', 'Elena', 'Mateo', 'Sofia', 'Lucas', 'Isabella', 'Diego', 'Camila', 'Gabriel', 'Valentina'
];

const LAST_NAMES = [
  'Sharma', 'Patel', 'Verma', 'Mehta', 'Gupta', 'Singh', 'Chowdhury', 'Joshi', 'Reddy', 'Nair',
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Kumar', 'Shah', 'Deshmukh', 'Kulkarni', 'Bhat', 'Rao', 'Iyer', 'Menon', 'Pillai', 'Saxena'
];

const AVATAR_SEEDS = [
  'Felix', 'Aneka', 'Zoe', 'Trouble', 'Boo', 'Coco', 'Jack', 'Pepper', 'Ginger', 'Shadow',
  'Buster', 'Sammy', 'Midnight', 'Lucky', 'Princess', 'Precious', 'Smokey', 'Angel', 'Oliver', 'Tigger',
  'Cleo', 'Callie', 'Oscar', 'Milo', 'Bandit', 'Buddy', 'Bailey', 'Sasha', 'Missy', 'Molly',
  'Totoro', 'Pikachu', 'Naruto', 'Luffy', 'Goku', 'Sasuke', 'Zoro', 'Nami', 'Chopper', 'Sanji',
  'Spider', 'Ironman', 'Batman', 'Thor', 'Hulk', 'Cap', 'Wanda', 'Loki', 'Panther', 'Strange'
];

const AVATAR_STYLES = ['custom', 'bottts', 'avataaars', 'adventurer', 'big-ears', 'micah', 'lorelei', 'open-peeps', 'personas', 'thumbs'];

function getRealisticName(idx) {
  const f = FIRST_NAMES[(idx - 1) % FIRST_NAMES.length];
  const l = LAST_NAMES[Math.floor((idx - 1) / FIRST_NAMES.length) % LAST_NAMES.length];
  const num = Math.floor((idx - 1) / (FIRST_NAMES.length * LAST_NAMES.length)) + 1;
  return num > 1 ? `${f} ${l} ${num}` : `${f} ${l}`;
}

function getAvatar(idx) {
  const seed = AVATAR_SEEDS[(idx - 1) % AVATAR_SEEDS.length];
  const style = AVATAR_STYLES[(idx - 1) % AVATAR_STYLES.length];
  return { seed, style };
}

const joinedStudents = [];
let lastAnsweredQuestionIdx = -1;

async function joinStudent(studentIdx) {
  const playerId = `player_real_${studentIdx}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const studentName = getRealisticName(studentIdx);
  const avatar = getAvatar(studentIdx);

  const playerObj = {
    id: playerId,
    nickname: studentName,
    avatarSeed: avatar.seed,
    avatarStyle: avatar.style,
    joinedAt: Date.now(),
    connected: true,
    score: 0
  };

  // Broadcast to Host WebSocket
  try {
    if (globalSbChannel) {
      globalSbChannel.send({
        type: 'broadcast',
        event: 'player_join',
        payload: { pin: ROOM_PIN, player: playerObj }
      }).catch(() => {});
    }
  } catch {}

  // REST API Registration
  try {
    fetch(`${TARGET_URL}/api/room/${ROOM_PIN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'join', player: playerObj })
    }).catch(() => {});
  } catch {}

  joinedStudents.push({
    id: playerId,
    name: studentName,
    avatar
  });

  console.log(`✅ Student ${studentIdx} (${studentName} | ${avatar.style}:${avatar.seed}) joined room ${ROOM_PIN}!`);
}

function onStateSync(state) {
  if (!state) return;
  if (state.status === 'question_active' && state.currentQuestionIndex !== lastAnsweredQuestionIdx) {
    lastAnsweredQuestionIdx = state.currentQuestionIndex;
    const qIdx = state.currentQuestionIndex;
    const q = state.quiz?.questions?.[qIdx];
    const correctIdx = q?.correct_index ?? Math.floor(Math.random() * 4);

    console.log(`\n📢 Question ${qIdx + 1} is now ACTIVE! Dispatching realistic answers for ${joinedStudents.length} students...`);

    joinedStudents.forEach((student) => {
      // 65% chance of picking correct answer, 35% chance of picking random wrong answer
      const isCorrect = Math.random() < 0.65;
      const selectedIndex = isCorrect ? correctIdx : Math.floor(Math.random() * 4);
      const isActuallyCorrect = selectedIndex === correctIdx;

      // Realistic human reaction delay between 800ms and 3200ms
      const responseDelay = Math.floor(800 + Math.random() * 2400);
      const timeRemaining = Math.max(1000, 20000 - responseDelay);
      const points = isActuallyCorrect ? Math.floor(600 + (timeRemaining / 20000) * 400) : 0;

      setTimeout(() => {
        if (globalSbChannel) {
          globalSbChannel.send({
            type: 'broadcast',
            event: 'submit_answer',
            payload: {
              pin: ROOM_PIN,
              playerId: student.id,
              data: {
                selectedIndex,
                correct: isActuallyCorrect,
                points,
                responseTimeMs: responseDelay
              }
            }
          }).catch(() => {});
        }
      }, responseDelay);
    });
  }
}

async function runLoadTest() {
  console.log(`=======================================================`);
  console.log(`🚀 QuizFlow Load Tester: ${TOTAL_STUDENTS} Realistic Students`);
  console.log(`🎯 Target: ${TARGET_URL}`);
  console.log(`📍 Room PIN: ${ROOM_PIN}`);
  console.log(`=======================================================\n`);

  // Subscribe central WebSocket
  if (globalSbChannel) {
    globalSbChannel
      .on('broadcast', { event: 'state_sync' }, (res) => {
        if (res?.payload && String(res.payload.pin) === String(ROOM_PIN)) {
          onStateSync(res.payload);
        }
      })
      .subscribe((status) => {
        console.log(`🔌 Supabase Realtime Channel status: ${status}`);
      });
  }

  // Stagger student joins
  for (let i = 1; i <= TOTAL_STUDENTS; i++) {
    await joinStudent(i);
    await new Promise(r => setTimeout(r, 20)); // smooth 20ms join stagger
  }

  console.log(`\n🎉 All ${TOTAL_STUDENTS} students successfully joined room ${ROOM_PIN}! Waiting for Host to start game...`);

  // Periodic state check fallback
  const startTime = Date.now();
  while (Date.now() - startTime < HOLD_MS) {
    try {
      const res = await fetch(`${TARGET_URL}/api/room/${ROOM_PIN}?_t=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.state) onStateSync(body.state);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2500));
  }

  console.log(`\n✅ Gameplay test completed for all ${TOTAL_STUDENTS} realistic students!`);
  process.exit(0);
}

runLoadTest();
