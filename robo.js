// robo.js - WhatsApp + Google Sheets (envio simples com debug)
// Mantido o fluxo original; apenas atualizada a mensagem e o uso da coluna E (Escolhas).

require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_RANGE = process.env.SHEET_RANGE || 'Página1!B:F';

console.log('[BOOT] SHEET_ID =', SHEET_ID);
console.log('[BOOT] SHEET_RANGE =', SHEET_RANGE);

// --- extrai o nome da aba (pra escrever na coluna F) ---
function getSheetName(range) {
  const i = range.indexOf('!');
  return i === -1 ? range : range.slice(0, i);
}
const SHEET_TAB = getSheetName(SHEET_RANGE);

// === Google Sheets ===
const auth = new google.auth.GoogleAuth({
  keyFile: 'credenciais.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// === WhatsApp (forçando versão da web e Chrome instalado) ===
// Se o Chrome estiver em outro caminho, ajuste `executablePath`
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'bot1' }),
  webVersionCache: {
    type: 'remote',
    remotePath:
      'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/web-version.json',
  },
  puppeteer: {
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 10_000,
});

client.on('qr', (qr) => {
  console.log('[WHATSAPP] QR gerado. Escaneie com o celular.');
  qrcode.generate(qr, { small: true });
});
client.on('loading_screen', (p, m) => console.log('[WHATSAPP] loading_screen', p, m || ''));
client.on('authenticated', () => console.log('🔐 [WHATSAPP] authenticated'));
client.on('remote_session_saved', () => console.log('💾 [WHATSAPP] remote_session_saved'));
client.on('change_state', (s) => console.log('[WHATSAPP] change_state:', s));
client.on('auth_failure', (m) => console.error('❌ [WHATSAPP] auth_failure:', m));
client.on('disconnected', (r) => console.warn('⚠️ [WHATSAPP] disconnected:', r));

let ready = false;
client.on('ready', async () => {
  ready = true;
  console.log('✅ [WHATSAPP] Conectado!');
  await testReadOnce(); // leitura de teste
  while (true) {
    try {
      await processSheetOnce();
    } catch (e) {
      console.error('[LOOP] erro:', e);
    }
    await delay(60_000);
  }
});

client.initialize();

// watchdog: avisa se não ficou ready em 30s
setTimeout(async () => {
  if (ready) return;
  const st = await safeGetState();
  console.warn('⏱️ [WATCHDOG] ainda não ficou ready. estado =', st);
  console.warn('Se não avançar, limpe a sessão (apague .wwebjs_auth) e rode de novo.');
}, 30_000);

// === helpers ===
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
async function safeGetState() {
  try {
    return await client.getState();
  } catch {
    return 'desconhecido';
  }
}
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('55')) return digits; // já tem DDI
  if (digits.length >= 10) return '55' + digits; // assume Brasil
  return null;
}
async function readRows() {
  console.log('[SHEETS] Lendo', SHEET_RANGE, '…');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });
  const values = res.data.values || [];
  console.log('[SHEETS] Linhas (inclui cabeçalho):', values.length);
  return values;
}
async function writeCell(a1, value) {
  console.log('[SHEETS] Escrevendo', a1, '=>', value);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: a1,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

// ========== MENSAGEM (atualizada) ==========
// Antes usava só o nome; agora inclui as escolhas (coluna E).
function buildMessage(nome, escolhas) {
  const first = (nome || '').trim().split(' ')[0] || '';
  const escolhido = (escolhas || '').toString().trim();
  const trechoEscolhas = escolhido ? `, vi que você quer o ${escolhido}` : '';
  return `Oi, ${first}! Recebemos seu pedido de portfólio${trechoEscolhas}. Você veio por alguma indicação?`;
}

async function testReadOnce() {
  try {
    const rows = await readRows();
    if (!rows.length) {
      console.warn('[TEST] 0 linhas — confira compartilhamento e RANGE.');
      return;
    }
    console.log('[TEST] Cabeçalho:', rows[0]);
    console.log('[TEST] Amostra:', rows.slice(1, 4));
  } catch (e) {
    console.error('[TEST] erro leitura planilha:', e.message);
  }
}

async function processSheetOnce() {
  const rows = await readRows();
  let pend = 0;

  for (let i = 1; i < rows.length; i++) {
    // B=Nome | C=Número | D=Data | E=Escolhas | F=Status
    const [nome, numero, data, escolhas, status] = rows[i];

    // pula os já enviados
    if ((status || '').toString().toUpperCase().includes('ENVIADO')) continue;

    const normalized = normalizePhone(numero);
    const a1 = `${SHEET_TAB}!F${i + 1}`;

    if (!normalized) {
      console.warn(`⚠️ [Linha ${i + 1}] Número inválido:`, numero);
      await writeCell(a1, 'ERRO_NUMERO');
      continue;
    }

    // verifica se é usuário de WhatsApp (feedback na planilha)
    let isUser = false;
    try {
      isUser = await client.isRegisteredUser(`${normalized}@c.us`);
    } catch (e) {
      console.warn(`[Linha ${i + 1}] isRegisteredUser falhou: ${e.message}`);
    }
    if (!isUser) {
      console.warn(`⚠️ [Linha ${i + 1}] Não é usuário de WhatsApp: ${normalized}`);
      await writeCell(a1, 'NAO_WHATSAPP');
      continue;
    }

    // envia
    pend++;
    try {
      console.log(`➡️ [Linha ${i + 1}] Enviando para ${nome} (${normalized})…`);
      await client.sendMessage(`${normalized}@c.us`, buildMessage(nome, escolhas));
      await writeCell(a1, `ENVIADO ${new Date().toLocaleString('pt-BR')}`);
      console.log(`✅ [Linha ${i + 1}] ENVIADO`);
    } catch (err) {
      console.error(`❌ [Linha ${i + 1}] erro envio:`, err.message);
      await writeCell(a1, `ERRO_ENVIO ${new Date().toLocaleString('pt-BR')}`);
    }

    await delay(2500);
  }

  if (pend === 0) console.log('[LOOP] nada pendente agora.');
}
