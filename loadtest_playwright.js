/* ================================================================
   QuizFlow — Realistic 600 Active Gameplay Student Simulator
   Lightweight Node.js HTTP Runner — 0 Chrome overhead!
   Generates unique real student names, diverse avatars, and plays all questions A,B,C,D!
   ================================================================ */

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3001';
const ROOM_PIN   = process.env.PIN || '971047';
const TOTAL_STUDENTS = parseInt(process.env.STUDENTS || '600', 10);
const HOLD_MS    = parseInt(process.env.HOLD_MS || '300000', 10); // 5 minutes

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
    // 1. Join room via API with retry loop for cold serverless container warmup
    let joinedOk = false;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const joinRes = await fetch(`${TARGET_URL}/api/room/${ROOM_PIN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'join',
            player: {
              id: playerId,
              nickname: studentName,
              avatarSeed: avatar.seed,
              avatarStyle: avatar.style,
              joinedAt: Date.now(),
              connected: true,
              score: 0
            }
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

    // 2. Active Gameplay Polling Loop
    const startTime = Date.now();
    let lastAnsweredQuestionIdx = -1;
    const pollIntervalMs = TOTAL_STUDENTS >= 200 ? 1500 : 600;

    while (Date.now() - startTime < HOLD_MS) {
      try {
        const stateRes = await fetch(`${TARGET_URL}/api/room/${ROOM_PIN}?_t=${Date.now()}`, {
          headers: { 'Cache-Control': 'no-cache' }
        });

        if (stateRes.ok) {
          const body = await stateRes.json().catch(() => ({}));
          const state = body?.state;

          if (state?.status === 'question_active' && state?.currentQuestionIndex !== lastAnsweredQuestionIdx) {
            lastAnsweredQuestionIdx = state.currentQuestionIndex;
            const randomOption = Math.floor(Math.random() * 4); // Random A=0, B=1, C=2, D=3
            const randomResponseTimeMs = Math.floor(1000 + Math.random() * 3500);
            const randomTimeRemaining = Math.max(1000, 20000 - randomResponseTimeMs);

            // Wait reaction time before answering
            await new Promise(r => setTimeout(r, Math.min(1800, randomResponseTimeMs / 2)));

            // Submit answer via API
            const ansRes = await fetch(`${TARGET_URL}/api/room/${ROOM_PIN}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'submit_answer',
                playerId: playerId,
                selectedIndex: randomOption,
                timeRemainingMs: randomTimeRemaining,
                responseTimeMs: randomResponseTimeMs
              })
            });

            if (ansRes.ok) {
              console.log(`🎲 ${studentName} (${avatar.seed}) answered Q${lastAnsweredQuestionIdx + 1} with Option ${['A','B','C','D'][randomOption]}!`);
            }
          }
        }
      } catch (e) {
        // Retry silently
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
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
