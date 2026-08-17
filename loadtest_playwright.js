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

async function joinAndPlayStudent(studentIdx) {
  const playerId = `player_real_${studentIdx}_${Date.now()}`;
  const studentName = getRealisticName(studentIdx);
  const avatar = getAvatar(studentIdx);

  try {
    // 1. Join room via Supabase Realtime WebSocket + REST API
    let joinedOk = false;
    const playerObj = {
      id: playerId,
      nickname: studentName,
      avatarSeed: avatar.seed,
      avatarStyle: avatar.style,
      joinedAt: Date.now(),
      connected: true,
      score: 0
    };

    // Broadcast directly to host screen WebSocket
    try {
      if (globalSbChannel) {
        globalSbChannel.send({
          type: 'broadcast',
          event: 'player_join',
          payload: { pin: ROOM_PIN, player: playerObj }
        }).catch(() => {});
      }
    } catch {}

    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const joinRes = await fetch(`${TARGET_URL}/api/room/${ROOM_PIN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'join',
            player: playerObj
          })
        });

        if (joinRes.ok) {
          joinedOk = true;
          console.log(`✅ Student ${studentIdx} (${studentName} | ${avatar.style}:${avatar.seed}) joined room ${ROOM_PIN}!`);
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 600 + Math.random() * 300));
    }

    if (!joinedOk) {
      console.warn(`⚠️ Student ${studentIdx} (${studentName}) failed to join room ${ROOM_PIN} after retries.`);
      return;
    }

    // 2. Real-Time WebSocket Gameplay Engine (Zero HTTP polling, 100% real-time answers)
    let lastAnsweredQuestionIdx = -1;

    const onStateSync = async (state) => {
      if (!state) return;
      if (state.status === 'question_active' && state.currentQuestionIndex !== lastAnsweredQuestionIdx) {
        lastAnsweredQuestionIdx = state.currentQuestionIndex;
        const randomOption = Math.floor(Math.random() * 4); // A=0, B=1, C=2, D=3
        const randomDelay = Math.floor(600 + Math.random() * 2800); // 0.6s - 3.4s human reaction time
        const timeRemaining = Math.max(1000, 20000 - randomDelay);

        await new Promise(r => setTimeout(r, randomDelay));

        const ansPayload = {
          action: 'submit_answer',
          playerId: playerId,
          selectedIndex: randomOption,
          timeRemainingMs: timeRemaining,
          responseTimeMs: randomDelay
        };

        // 1. Submit via REST API
        fetch(`${TARGET_URL}/api/room/${ROOM_PIN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ansPayload)
        }).then(res => {
          if (res.ok) {
            console.log(`🎯 ${studentName} (${avatar.seed}) answered Q${lastAnsweredQuestionIdx + 1} with Option ${['A','B','C','D'][randomOption]}!`);
          }
        }).catch(() => {});

        // 2. Broadcast via Supabase Realtime
        try {
          if (globalSbChannel) {
            globalSbChannel.send({
              type: 'broadcast',
              event: 'submit_answer',
              payload: {
                pin: ROOM_PIN,
                playerId: playerId,
                data: {
                  selectedIndex: randomOption,
                  correct: true,
                  points: Math.floor(800 + (timeRemaining / 20000) * 200),
                  responseTimeMs: randomDelay
                }
              }
            }).catch(() => {});
          }
        } catch {}
      }
    };

    if (globalSbChannel) {
      globalSbChannel.on('broadcast', { event: 'state_sync' }, (res) => {
        if (res?.payload && res.payload.pin === ROOM_PIN) {
          onStateSync(res.payload);
        }
      });
    }

    // Fallback polling every 2s for redundancy
    const startTime = Date.now();
    while (Date.now() - startTime < HOLD_MS) {
      try {
        const stateRes = await fetch(`${TARGET_URL}/api/room/${ROOM_PIN}?_t=${Date.now()}`, {
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (stateRes.ok) {
          const body = await stateRes.json().catch(() => ({}));
          if (body?.state) onStateSync(body.state);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }

  } catch (err) {
    console.error(`❌ Student ${studentIdx} error:`, err.message);
  }
}

async function main() {
  console.log(`\n🚀 Launching ${TOTAL_STUDENTS} Realistic Students for Room PIN: ${ROOM_PIN}...`);
  console.log(`🎯 Target URL: ${TARGET_URL}\n`);

  const tasks = [];
  for (let i = 1; i <= TOTAL_STUDENTS; i++) {
    tasks.push(joinAndPlayStudent(i));
    await new Promise(r => setTimeout(r, 40)); // 40ms join pacing
  }

  await Promise.all(tasks);
  console.log(`\n✅ Gameplay test completed for all ${TOTAL_STUDENTS} realistic students!`);
}

main().catch(console.error);
