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

// --- Storage: Supabase (persistente) con fallback a JSON local ---
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
let supa = null;
if (SUPA_URL && SUPA_KEY && !SUPA_KEY.includes('PEGA')) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supa = createClient(SUPA_URL, SUPA_KEY);
    console.log('✅ Supabase activado');
  } catch (e) { console.log('supabase init fail:', e.message); }
}
function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ tareas: [], grupos: [] }, null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
async function trackChat(id) {
  if (supa) { try { await supa.from('grupos').upsert({ id: String(id) }, { onConflict: 'id' }); } catch (e) {} return; }
  const db = loadDB();
  if (!db.grupos.includes(id)) { db.grupos.push(id); saveDB(db); }
}
async function dbList(chatId) {
  if (supa) {
    const { data } = await supa.from('tareas').select('*').eq('chat_id', String(chatId)).eq('completada', false).order('fecha_entrega');
    return (data || []).map(t => ({ id: t.nid, materia: t.materia, tipo: t.tipo, descripcion: t.descripcion, fechaEntrega: t.fecha_entrega, dificultad: t.dificultad, horas: t.horas, creador: t.creador, chatId: Number(t.chat_id), avisados: t.avisados || [], completada: t.completada }));
  }
  const db = loadDB();
  return db.tareas.filter(x => !x.completada && (String(x.chatId) === String(chatId) || !x.chatId));
}
async function dbAdd(chatId, d) {
  if (supa) {
    const { data: max } = await supa.from('tareas').select('nid').eq('chat_id', String(chatId)).order('nid', { ascending: false }).limit(1);
    const nid = ((max && max[0]?.nid) || 0) + 1;
    await supa.from('tareas').insert({ chat_id: String(chatId), nid, materia: d.materia, tipo: d.tipo, descripcion: d.descripcion, fecha_entrega: d.fechaEntrega, dificultad: d.dificultad, horas: d.horas, creador: d.creador, avisados: [], completada: false });
    return nid;
  }
  const db = loadDB();
  const id = (db.tareas.at(-1)?.id || 0) + 1;
  db.tareas.push({ id, ...d, chatId, avisados: [], completada: false });
  saveDB(db);
  return id;
}
async function dbDone(chatId, nid) {
  if (supa) { const { data } = await supa.from('tareas').update({ completada: true }).eq('chat_id', String(chatId)).eq('nid', nid).select(); return (data || [])[0]; }
  const db = loadDB();
  const t = db.tareas.find(x => x.id === nid && (String(x.chatId) === String(chatId) || !x.chatId));
  if (t) { t.completada = true; saveDB(db); }
  return t;
}
async function dbDel(chatId, nid) {
  if (supa) { await supa.from('tareas').delete().eq('chat_id', String(chatId)).eq('nid', nid); return; }
  const db = loadDB();
  db.tareas = db.tareas.filter(x => !(x.id === nid && (String(x.chatId) === String(chatId) || !x.chatId)));
  saveDB(db);
}
async function dbAllPending() {
  if (supa) {
    const { data } = await supa.from('tareas').select('*').eq('completada', false);
    return (data || []).map(t => ({ id: t.nid, dbId: t.id, materia: t.materia, tipo: t.tipo, descripcion: t.descripcion, fechaEntrega: t.fecha_entrega, dificultad: t.dificultad, horas: t.horas, creador: t.creador, chatId: t.chat_id, avisados: t.avisados || [] }));
  }
  return loadDB().tareas.filter(x => !x.completada);
}
async function dbMarkAvisado(t, diff) {
  const nav = [...(t.avisados || []), diff];
  if (supa && t.dbId) { await supa.from('tareas').update({ avisados: nav }).eq('id', t.dbId); return; }
  const db = loadDB();
  const lt = db.tareas.find(x => x.id === t.id);
  if (lt) { lt.avisados.push(diff); saveDB(db); }
}
async function dbGrupos() {
  if (supa) { const { data } = await supa.from('grupos').select('id'); return (data || []).map(g => g.id); }
  return loadDB().grupos;
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

bot.onText(/\/start|\/ayuda|\/help/, async (msg) => {
  await trackChat(msg.chat.id);
  bot.sendMessage(msg.chat.id, `🤖 Bot Tareas Colegio\n\nEscríbeme natural, sin formato raro:\n/agregar tarea portada de naturales para el lunes de biología\n/agregar examen de matemáticas fracciones para el 12-09 difícil\n\nO con formato:\n/agregar Matematicas | examen fracciones | 12-09 | dificil | 4 horas\n\n/ver - pendientes\n/listo 5\n/borrar 5\n/pregunta lo que sea - IA general`);
});

bot.onText(/\/agregar (.+)/, async (msg, match) => {
  await trackChat(msg.chat.id);
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
  const offs = offsets(dificultad, horas);
  const avisos = offs.map(o => fecha.subtract(o,'day').format('DD MMM')).join(', ');
  const creador = msg.from.username ? '@'+msg.from.username : msg.from.first_name;
  const id = await dbAdd(msg.chat.id, { materia, tipo, descripcion, fechaEntrega: fecha.toISOString(), dificultad, horas, creador });
  bot.sendMessage(msg.chat.id, `✅ Tarea guardada #${id}\n📌 ${materia} - ${tipo} ${descripcion}\n📅 Entrega: ${fecha.format('DD MMM dddd')}\n⚠️ Dificultad: ${dificultad} (${horas}h)\n⏰ Les avisaré solo el: ${avisos}\n👤 Puesta por ${creador}`);
});

bot.onText(/\/ver(.*)/, async (msg, match) => {
  await trackChat(msg.chat.id);
  let lista = await dbList(msg.chat.id);
  if ((match[1]||'').includes('examen')) lista = lista.filter(x => x.tipo.includes('examen'));
  if (!lista.length) return bot.sendMessage(msg.chat.id, '🎉 No hay tareas pendientes.');
  lista.sort((a,b)=> dayjs(a.fechaEntrega)-dayjs(b.fechaEntrega));
  bot.sendMessage(msg.chat.id, '📝 Pendientes:\n\n' + lista.map(fmt).join('\n\n'));
});

bot.onText(/\/listo (\d+)/, async (msg, match) => {
  await trackChat(msg.chat.id);
  const id = parseInt(match[1]);
  const t = await dbDone(msg.chat.id, id);
  if (!t) return bot.sendMessage(msg.chat.id, '❌ No encontré ese #id en este grupo.');
  const quien = msg.from.username ? '@'+msg.from.username : msg.from.first_name;
  bot.sendMessage(msg.chat.id, `🎉 Bien ${quien}! #${id} marcada como hecha.`);
});

bot.onText(/\/borrar (\d+)/, async (msg, match) => {
  await trackChat(msg.chat.id);
  const id = parseInt(match[1]);
  await dbDel(msg.chat.id, id);
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
    const lista = await dbList(msg.chat.id);
    const pendientes = lista.map(fmt).join('\n').slice(0, 2000);
    const prompt = `Eres como ChatGPT / Gemini para un grupo de 4 amigos de colegio. Respondes CUALQUIER pregunta general (ciencia, historia, universo, tareas, matemáticas, etc), en español, claro y útil.\nIMPORTANTE sobre recordatorios: este bot SÍ envía recordatorios automáticos solo al grupo (según dificultad: facil 1 día antes, media 3 y 1 día antes, dificil 7,3,1 día antes + día entrega) + resumen diario 7pm. Nunca digas que no puedes avisar automático. Si preguntan "me recuerdas el domingo?", responde "Sí, te avisaré solo esos días: ..." usando las fechas.\nTareas pendientes del grupo:\n${pendientes || 'ninguna'}\n\nPregunta de ${msg.from.first_name}: ${q}`;
    let txt = (await askGemini(prompt)).slice(0, 3500);
    bot.sendMessage(msg.chat.id, `🤖 ${txt}`);
  } catch (e) {
    console.log('gemini error final:', e.message);
    bot.sendMessage(msg.chat.id, '😅 Gemini está saturado ahorita (error 503 de Google). Espera 1 min y prueba de nuevo:\n/pregunta ' + q);
  }
});

// Notas de voz: transcribe con Gemini y actúa como /agregar natural o /pregunta
async function transcribeVoice(fileId) {
  const link = await bot.getFileLink(fileId);
  const res = await fetch(link);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('Audio muy largo (máx ~1 min, manda 10-20 seg)');
  const b64 = buf.toString('base64');
  const prompt = `Transcribe este audio en español y devuelve SOLO JSON: {"texto":"...","intencion":"tarea|pregunta|otro"} Si habla de tarea/examen/trabajo para fecha, intencion=tarea. Si pregunta algo, intencion=pregunta.`;
  // Rápido: 1 intento por modelo, sin esperas largas
  let lastErr = null;
  for (const mname of GEMINI_MODELS) {
    try {
      const m = geminiClient.getGenerativeModel({ model: mname });
      const r = await m.generateContent([{ text: prompt }, { inlineData: { data: b64, mimeType: 'audio/ogg' } }]);
      let txt = r.response.text().replace(/```json|```/g, '').trim();
      return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    } catch (e) { lastErr = e; console.log(`voice ${mname} fail rápido:`, e.message.slice(0, 150)); }
  }
  throw lastErr || new Error('Gemini audio saturado');
}
bot.on('voice', async (msg) => {
  await trackChat(msg.chat.id);
  if (!geminiClient) return bot.sendMessage(msg.chat.id, '❌ Falta GEMINI para voz.');
  await bot.sendChatAction(msg.chat.id, 'typing');
  try {
    const t = await transcribeVoice(msg.voice.file_id);
    const texto = t.texto || '';
    await bot.sendMessage(msg.chat.id, `🎤 Escuché: "${texto}"`);
    // Si es tarea -> guarda, si no (pregunta u otro) -> responde como ChatGPT
    if ((t.intencion || '').toLowerCase() !== 'tarea') {
      const lista = await dbList(msg.chat.id);
      const pendientes = lista.map(fmt).join('\n').slice(0, 2000);
      const p2 = `Eres ChatGPT / Gemini para grupo de colegio. Respondes CUALQUIER pregunta general en español, claro y útil. Tareas pendientes para contexto:\n${pendientes || 'ninguna'}\nPregunta por voz de ${msg.from.first_name}: ${texto}`;
      const ans = (await askGemini(p2)).slice(0, 3500);
      return bot.sendMessage(msg.chat.id, `🤖 ${ans}`);
    } else {
      // tarea por voz: parsea como natural
      const hoy = dayjs().format('YYYY-MM-DD dddd');
      const p2 = `Hoy es ${hoy}. Extrae tarea y devuelve SOLO JSON: {"materia":"...","tipo":"trabajo|examen|exposicion|proyecto|tarea","descripcion":"...","fecha":"DD-MM-YYYY","dificultad":"facil|media|dificil","horas":1} Texto: "${texto}"`;
      let txt = (await askGemini(p2)).replace(/```json|```/g, '').trim();
      const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
      const materia = j.materia || 'General', tipo = (j.tipo || 'tarea').toLowerCase(), descripcion = j.descripcion || texto;
      const m = (j.fecha || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      const fecha = m ? dayjs(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`) : parseFecha(j.fecha || '') || dayjs().add(1, 'day');
      const dificultad = (j.dificultad || 'media').toLowerCase(), horas = parseInt(j.horas) || 1;
      const creador = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
      const id = await dbAdd(msg.chat.id, { materia, tipo, descripcion, fechaEntrega: fecha.toISOString(), dificultad, horas, creador });
      const offs = offsets(dificultad, horas);
      const avisos = offs.map(o => fecha.subtract(o, 'day').format('DD MMM')).join(', ');
      return bot.sendMessage(msg.chat.id, `✅ Por voz #${id}\n📌 ${materia} - ${tipo} ${descripcion}\n📅 ${fecha.format('DD MMM dddd')}\n⚠️ ${dificultad} (${horas}h)\n⏰ Avisaré: ${avisos}`);
    }
  } catch (e) {
    console.log('voice fail:', e.message);
    bot.sendMessage(msg.chat.id, '😅 No entendí la nota de voz, habla 10-20 seg claro e inténtalo de nuevo.');
  }
});

// Recordatorios cada hora
cron.schedule('0 * * * *', async () => {
  const hoy = dayjs().startOf('day');
  for (const t of await dbAllPending()) {
    const entrega = dayjs(t.fechaEntrega).startOf('day');
    const diff = entrega.diff(hoy, 'day');
    const offs = offsets(t.dificultad, t.horas);
    if (offs.includes(diff) && !(t.avisados || []).includes(diff)) {
      const msg = diff === 0
        ? `⏰ ¡HOY SE ENTREGA! #${t.id} ${t.materia} - ${t.tipo} ${t.descripcion} ¡háganla ya!`
        : `⏰ Recordatorio #${t.id} ${t.materia} - ${t.tipo} ${t.descripcion}\n📅 Entrega ${entrega.format('DD MMM')} (en ${diff} días) ⚠️ ${t.dificultad}`;
      try { await bot.sendMessage(t.chatId, msg); } catch(e){ console.log('No se pudo avisar:', e.message); }
      await dbMarkAvisado(t, diff);
    }
  }
});

// Resumen diario 7pm
cron.schedule('0 19 * * *', async () => {
  for (const gid of await dbGrupos()) {
    const pendientes = (await dbList(gid)).sort((a,b)=> dayjs(a.fechaEntrega)-dayjs(b.fechaEntrega));
    if (!pendientes.length) continue;
    bot.sendMessage(gid, '📝 Resumen diario:\n\n' + pendientes.map(fmt).join('\n\n'));
  }
});

bot.on('polling_error', (e) => console.log('polling:', e.message));
console.log('✅ Bot Telegram corriendo. Busca tu bot y dale /ayuda');
