// Bot Telegram Tareas Colegio - gratis
// Comandos: /ayuda /agregar /ver /listo /borrar /pregunta
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const dayjs = require('dayjs');
const fs = require('fs');
const http = require('http');

// Servidorcito para Render/Koyeb gratis (health check, evita que lo tumben)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('bot ok'); }).listen(PORT, () => console.log('health en :' + PORT));

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) { console.error('Falta TELEGRAM_TOKEN en .env'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
const DB_FILE = './db.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ tareas: [], grupos: [] }, null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function trackChat(id) {
  const db = loadDB();
  if (!db.grupos.includes(id)) { db.grupos.push(id); saveDB(db); }
}

function parseFecha(str) {
  str = (str||'').trim().toLowerCase();
  if (str === 'mañana' || str === 'manana') return dayjs().add(1, 'day').startOf('day');
  if (str === 'hoy') return dayjs().startOf('day');
  const m = str.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/);
  if (!m) return null;
  let year = m[3] ? parseInt(m[3]) : dayjs().year();
  let f = dayjs(`${year}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`);
  if (!m[3] && f.isBefore(dayjs().startOf('day'))) f = f.add(1, 'year');
  return f.isValid() ? f.startOf('day') : null;
}
function offsets(dificultad, horas) {
  dificultad = (dificultad||'').toLowerCase();
  if (horas >= 3) dificultad = 'dificil';
  if (dificultad.startsWith('facil') || dificultad.startsWith('fácil')) return [1, 0];
  if (dificultad.startsWith('media')) return [3, 1, 0];
  return [7, 3, 1, 0];
}
function fmt(t) {
  const f = dayjs(t.fechaEntrega).format('DD MMM');
  const dias = dayjs(t.fechaEntrega).startOf('day').diff(dayjs().startOf('day'), 'day');
  const cuando = dias < 0 ? '(vencida)' : dias === 0 ? '(¡hoy!)' : dias === 1 ? '(mañana)' : `(${dias} días)`;
  return `#${t.id} 📌 ${t.materia} - ${t.tipo} ${t.descripcion}\n   📅 ${f} ${cuando} | ⚠️ ${t.dificultad} ${t.horas}h 👤 ${t.creador}`;
}

bot.onText(/\/start|\/ayuda|\/help/, (msg) => {
  trackChat(msg.chat.id);
  bot.sendMessage(msg.chat.id, `🤖 Bot Tareas Colegio\n\nEscríbeme natural, sin formato raro:\n/agregar tarea portada de naturales para el lunes de biología\n/agregar examen de matemáticas fracciones para el 12-09 difícil\n\nO con formato:\n/agregar Matematicas | examen fracciones | 12-09 | dificil | 4 horas\n\n/ver - pendientes\n/listo 5\n/borrar 5\n/pregunta lo que sea - IA general`);
});

bot.onText(/\/agregar (.+)/, async (msg, match) => {
  trackChat(msg.chat.id);
  const resto = match[1];
  const partes = resto.split('|').map(s => s.trim());
  let materia, tipo, descripcion, fecha, dificultad, horas;

  if (partes.length >= 3) {
    materia = partes[0];
    const td = partes[1].split(' ');
    tipo = (td[0]||'tarea').toLowerCase();
    descripcion = td.slice(1).join(' ') || tipo;
    fecha = parseFecha(partes[2]||'');
    dificultad = (partes[3]||'media').toLowerCase();
    horas = parseInt((partes[4]||'1').match(/\d+/)?.[0] || '1');
  } else {
    // Lenguaje natural con Gemini: "/agregar tarea de hoy portada de naturales para el lunes..."
    if (typeof geminiClient === 'undefined' || !geminiClient) return bot.sendMessage(msg.chat.id, '❌ Escribe con formato o activa Gemini. Ej:\n/agregar tarea portada naturales para el lunes biología');
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const hoy = dayjs().format('YYYY-MM-DD dddd');
      const prompt = `Hoy es ${hoy}. Extrae una tarea escolar del texto y devuelve SOLO JSON válido sin markdown: {"materia": "...", "tipo": "trabajo|examen|exposicion|proyecto|tarea", "descripcion": "...", "fecha": "DD-MM-YYYY", "dificultad": "facil|media|dificil", "horas": 1}\nReglas: si dice "lunes" calcula el próximo lunes desde hoy. Si no dice dificultad, estima: portada/dibujo=facil 1h, examen=dificil 3h, trabajo=media 2h. Texto: "${resto}"`;
      let txt = (await askGemini(prompt)).replace(/```json|```/g, '').trim();
      const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
      materia = j.materia || 'General'; tipo = (j.tipo || 'tarea').toLowerCase(); descripcion = j.descripcion || resto;
      const m = (j.fecha || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      fecha = m ? dayjs(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`) : parseFecha(j.fecha || '') || dayjs().add(1, 'day');
      dificultad = (j.dificultad || 'media').toLowerCase(); horas = parseInt(j.horas) || 1;
    } catch (e) {
      console.log('parse natural fail:', e.message);
      return bot.sendMessage(msg.chat.id, '❌ No te entendí. Prueba:\n/agregar naturales portada biología para el lunes');
    }
  }
  if (!fecha || !fecha.isValid()) return bot.sendMessage(msg.chat.id, '❌ Fecha no entendida. Usa 12-09, mañana, lunes, etc.');
  const db = loadDB();
  const id = (db.tareas.at(-1)?.id || 0) + 1;
  const offs = offsets(dificultad, horas);
  const avisos = offs.map(o => fecha.subtract(o,'day').format('DD MMM')).join(', ');
  const creador = msg.from.username ? '@'+msg.from.username : msg.from.first_name;
  db.tareas.push({ id, materia, tipo, descripcion, fechaEntrega: fecha.toISOString(), dificultad, horas, creador, chatId: msg.chat.id, avisados: [], completada: false });
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ Tarea guardada #${id}\n📌 ${materia} - ${tipo} ${descripcion}\n📅 Entrega: ${fecha.format('DD MMM dddd')}\n⚠️ Dificultad: ${dificultad} (${horas}h)\n⏰ Les avisaré el: ${avisos}\n👤 Puesta por ${creador}`);
});

bot.onText(/\/ver(.*)/, (msg, match) => {
  trackChat(msg.chat.id);
  const db = loadDB();
  // solo tareas de este grupo
  let lista = db.tareas.filter(x => !x.completada && (x.chatId === msg.chat.id || !x.chatId));
  if ((match[1]||'').includes('examen')) lista = lista.filter(x => x.tipo.includes('examen'));
  if (!lista.length) return bot.sendMessage(msg.chat.id, '🎉 No hay tareas pendientes.');
  lista.sort((a,b)=> dayjs(a.fechaEntrega)-dayjs(b.fechaEntrega));
  bot.sendMessage(msg.chat.id, '📝 Pendientes:\n\n' + lista.map(fmt).join('\n\n'));
});

bot.onText(/\/listo (\d+)/, (msg, match) => {
  trackChat(msg.chat.id);
  const id = parseInt(match[1]);
  const db = loadDB();
  const t = db.tareas.find(x => x.id === id && (x.chatId === msg.chat.id || !x.chatId));
  if (!t) return bot.sendMessage(msg.chat.id, '❌ No encontré ese #id en este grupo.');
  t.completada = true; saveDB(db);
  const quien = msg.from.username ? '@'+msg.from.username : msg.from.first_name;
  bot.sendMessage(msg.chat.id, `🎉 Bien ${quien}! #${id} ${t.materia} marcada como hecha.`);
});

bot.onText(/\/borrar (\d+)/, (msg, match) => {
  trackChat(msg.chat.id);
  const id = parseInt(match[1]);
  const db = loadDB();
  db.tareas = db.tareas.filter(x => !(x.id === id && (x.chatId === msg.chat.id || !x.chatId)));
  saveDB(db);
  bot.sendMessage(msg.chat.id, `🗑️ Tarea #${id} borrada.`);
});

// Gemini /pregunta con fallback y reintento (el 503 es sobrecarga temporal de Google)
const { GoogleGenerativeAI } = require('@google/generative-ai');
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash', 'gemini-2.5-flash'];
let geminiClient = null;
if (GEMINI_KEY && !GEMINI_KEY.includes('PEGA_AQUI')) {
  geminiClient = new GoogleGenerativeAI(GEMINI_KEY);
}
async function askGemini(prompt) {
  let lastErr = null;
  for (const mname of GEMINI_MODELS) {
    for (let intento = 0; intento < 2; intento++) {
      try {
        const m = geminiClient.getGenerativeModel({ model: mname });
        const r = await m.generateContent(prompt);
        return r.response.text();
      } catch (e) {
        lastErr = e;
        console.log(`gemini ${mname} intento ${intento + 1} fail:`, e.message.slice(0, 200));
        await new Promise(r => setTimeout(r, 2000 * (intento + 1)));
      }
    }
  }
  throw lastErr;
}

bot.onText(/\/pregunta (.+)/, async (msg, match) => {
  trackChat(msg.chat.id);
  const q = match[1];
  if (!geminiClient) return bot.sendMessage(msg.chat.id, '❌ Falta GEMINI_API_KEY.');
  await bot.sendChatAction(msg.chat.id, 'typing');
  try {
    const db = loadDB();
    const pendientes = db.tareas.filter(x => !x.completada && x.chatId === msg.chat.id).map(fmt).join('\n').slice(0, 2000);
    const prompt = `Eres como ChatGPT / Gemini para un grupo de 4 amigos de colegio. Respondes CUALQUIER pregunta general (ciencia, historia, universo, tareas, matemáticas, etc), en español, claro y útil, como si te preguntaran a la Gemini directa.\nSi la pregunta es sobre tareas, usa este contexto:\nTareas pendientes del grupo:\n${pendientes || 'ninguna'}\n\nPregunta de ${msg.from.first_name}: ${q}\nResponde completo pero sin rollo excesivo.`;
    let txt = (await askGemini(prompt)).slice(0, 3500);
    bot.sendMessage(msg.chat.id, `🤖 ${txt}`);
  } catch (e) {
    console.log('gemini error final:', e.message);
    bot.sendMessage(msg.chat.id, '😅 Gemini está saturado ahorita (error 503 de Google). Espera 1 min y prueba de nuevo:\n/pregunta ' + q);
  }
});

// Recordatorios cada hora
cron.schedule('0 * * * *', async () => {
  const db = loadDB();
  const hoy = dayjs().startOf('day');
  let changed = false;
  for (const t of db.tareas.filter(x => !x.completada)) {
    const entrega = dayjs(t.fechaEntrega).startOf('day');
    const diff = entrega.diff(hoy, 'day');
    const offs = offsets(t.dificultad, t.horas);
    if (offs.includes(diff) && !t.avisados.includes(diff)) {
      const msg = diff === 0
        ? `⏰ ¡HOY SE ENTREGA! #${t.id} ${t.materia} - ${t.tipo} ${t.descripcion} ¡háganla ya!`
        : `⏰ Recordatorio #${t.id} ${t.materia} - ${t.tipo} ${t.descripcion}\n📅 Entrega ${entrega.format('DD MMM')} (en ${diff} días) ⚠️ ${t.dificultad}`;
      try { await bot.sendMessage(t.chatId || db.grupos[0], msg); } catch(e){ console.log('No se pudo avisar:', e.message); }
      t.avisados.push(diff); changed = true;
    }
  }
  if (changed) saveDB(db);
});

// Resumen diario 7pm
cron.schedule('0 19 * * *', async () => {
  const db = loadDB();
  for (const gid of db.grupos) {
    const pendientes = db.tareas.filter(x => !x.completada && x.chatId === gid).sort((a,b)=> dayjs(a.fechaEntrega)-dayjs(b.fechaEntrega));
    if (!pendientes.length) continue;
    bot.sendMessage(gid, '📝 Resumen diario:\n\n' + pendientes.map(fmt).join('\n\n'));
  }
});

bot.on('polling_error', (e) => console.log('polling:', e.message));
console.log('✅ Bot Telegram corriendo. Busca tu bot y dale /ayuda');
