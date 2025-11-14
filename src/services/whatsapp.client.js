// src/services/whatsapp.client.js
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const p = require('pino');


// --- Funções auxiliares ---
// --- Armazenamento Global ---
const clients = new Map(); // Armazena instâncias do socket por clinicId (valor = socket)
const qrCodes = new Map(); // Armazena QR codes (string) por clinicId
const creatingQr = new Map(); // Flag para indicar que um QR está sendo gerado
const ADMIN_CLIENT_ID = 'admin'; // O ID estático para o cliente admin

// --- Inicialização do MongoStore (placeholder) ---
const initializeMongoStore = () => {
  if (!mongoose.connection.readyState || mongoose.connection.readyState === 0 || mongoose.connection.readyState === 3) {
    console.error("Mongoose não está conectado. Não foi possível inicializar o MongoStore.");
    return false;
  }
  return true;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};


// --- Obter Status do Cliente ---
const getClientStatus = (clinicId) => {
  const id = clinicId.toString();
  const client = clients.get(id); // 1. Tenta buscar na memória

  if (client) {
    if (qrCodes.has(id)) return "qrcode_pending";
    if (creatingQr.has(id)) return "creating_qr";
    if (client.user) return "connected"; // <-- Conexão ativa
    if (client.ws && client.ws.readyState === 1) return "initializing";
  }

  const sessionPath = path.resolve(".baileys_auth", `session-${id}`);
  
  if (fs.existsSync(sessionPath)) {
    return "connected";
  }

  // 4. Se não achou na memória NEM no disco
  return "disconnected";
};

const safeDeleteMaps = (id) => {
  qrCodes.delete(id);
  creatingQr.delete(id);
};

// --- Logout e Remoção ---
const logoutAndRemoveClient = async (clinicId) => {
  const id = clinicId.toString();
  const wrapper = clients.get(id);

  if (wrapper) {
    const { sock } = wrapper;
    console.log(
      `[CLIENT ${id}] Iniciando logout e remoção... Estado atual: ${wrapper.state}`
    );

    try {
      if (sock?.logout) {
        await sock.logout();
        console.log(`[CLIENT ${id}] Logout realizado.`);
      }
    } catch (err) {
      console.warn(
        `[CLIENT ${id}] Erro (seguro) durante logout: ${err.message}`
      );
    }

    try {
      // Fecha conexão WS, remove listeners
      if (sock?.ws?.close) sock.ws.close();
      if (sock?.ev?.removeAllListeners) sock.ev.removeAllListeners();
      console.log(`[CLIENT ${id}] Socket encerrado.`);
    } catch (err) {
      console.warn(
        `[CLIENT ${id}] Erro (seguro) ao encerrar socket: ${err.message}`
      );
    } finally {
      clients.delete(id);
    }
  } else {
    console.log(
      `[CLIENT ${id}] Cliente não encontrado na memória para logout/remoção.`
    );
  }

  safeDeleteMaps(id); // Limpa QR codes e flags de criação

  // --- INÍCIO DA MODIFICAÇÃO ---
  // Adicione este bloco para limpar o diretório da sessão
  const dataPath = path.resolve(`.baileys_auth/session-${id}`);
  
  if (fs.existsSync(dataPath)) {
    try {
      // Usamos rmSync (síncrono) para garantir que a pasta seja removida
      // antes da função terminar.
      fs.rmSync(dataPath, { recursive: true, force: true });
      console.log(`[CLIENT ${id}] Pasta de sessão (${dataPath}) removida do disco.`);
    } catch (err) {
      console.error(
        `[CLIENT ${id}] Falha ao remover pasta de sessão (${dataPath}): ${err.message}`
      );
    }
  }
  // --- FIM DA MODIFICAÇÃO ---

  console.log(`[CLIENT ${id}] Cliente removido e limpo da memória.`);
};
// --- Limpeza do diretório de sessão ---
const clearSessionDir = (dirPath) => {
  if (fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`[SESSION] Diretório de sessão limpo: ${dirPath}`);
    } catch (err) {
      console.warn(`[SESSION] Falha ao remover diretório ${dirPath}: ${err.message}`);
    }
  }
};

// --- Inicialização do Cliente com Baileys ---
const initializeClient = async (clinicId) => {
  const id = clinicId.toString();
  console.log(`[CLIENT ${id}] Iniciando processo de inicialização...`);

  // Verifica cliente existente
  if (clients.has(id)) {
    const existingClient = clients.get(id);
    const status = getClientStatus(id);
    console.log(`[CLIENT ${id}] Cliente já existe. Status: ${status}`);
    if (['connected', 'initializing', 'creating_qr', 'qrcode_pending'].includes(status)) {
      console.log(`[CLIENT ${id}] Retornando cliente existente.`);
      return existingClient;
    } else {
      console.log(`[CLIENT ${id}] Cliente em estado inválido (${status}). Forçando remoção.`);
      await logoutAndRemoveClient(id);
    }
  }

  if (!initializeMongoStore()) {
    throw new Error("MongoStore não pôde ser inicializado. Verifique a conexão com o MongoDB.");
  }

  creatingQr.set(id, true);
  console.log(`[CLIENT ${id}] Marcando criação de QR code.`);

  // Diretório de autenticação (na raiz do projeto)
  const sessionPath = path.resolve(".baileys_auth", `session-${id}`);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log(`[CLIENT ${id}] Diretório de sessão criado: ${sessionPath}`);
  } else {
    console.log(`[CLIENT ${id}] Usando diretório de sessão existente: ${sessionPath}`);
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  let client;
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[CLIENT ${id}] Usando Baileys versão: ${version.join('.')}`);

    client = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: p({ level: 'silent' }),
      browser: ['Chrome (Linux)', '', ''],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Salva a instância do socket (valor = socket)
    clients.set(id, client);
    console.log(`[CLIENT ${id}] Instância do socket criada e armazenada.`);

    // --- Eventos ---
    client.ev.on('creds.update', saveCreds);

    client.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr: qrString } = update;

      if (qrString) {
        console.log(`[CLIENT ${id}] QR code recebido.`);
        try {
          const qrDataUrl = await qrcode.toDataURL(qrString);
          qrCodes.set(id, qrDataUrl);
          creatingQr.delete(id);
          console.log(`[CLIENT ${id}] QR code gerado e armazenado.`);
        } catch (err) {
          console.error(`[CLIENT ${id}] Erro ao gerar QR: ${err.message}`);
          creatingQr.delete(id);
        }
      }

      if (connection === 'open') {
        console.log(`[CLIENT ${id}] Conectado com sucesso!`);
        qrCodes.delete(id);
        creatingQr.delete(id);
        if (client.user) {
          console.log(`[CLIENT ${id}] Usuário conectado: ${client.user.id}`);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.warn(`[CLIENT ${id}] Conexão fechada: ${lastDisconnect?.error?.message || 'Desconhecido'}`);
        qrCodes.delete(id);
        creatingQr.delete(id);

        if (shouldReconnect) {
          console.log(`[CLIENT ${id}] Tentando reconectar em 3s...`);
          setTimeout(() => initializeClient(clinicId).catch(err => console.error(`[CLIENT ${id}] Erro ao reinicializar: ${err.message}`)), 3000);
        } else {
          console.log(`[CLIENT ${id}] Logout detectado. Limpando sessão.`);
          clearSessionDir(sessionPath);
          await logoutAndRemoveClient(id);
        }
      }
    });

    // Evita erro de evento não tratado e adiciona logs para updates de mensagens
    client.ev.on('messages.upsert', (upsert) => {
      // upsert: { messages: [...], type: 'notify'|'append'|'...' }
      console.log(`[CLIENT ${id}] messages.upsert type=${upsert.type} count=${upsert.messages?.length || 0}`);
    });

    // messages.update fornece status/acks/delivery/fail info
    client.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        try {
          console.log(`[CLIENT ${id}] messages.update: key=${u.key?.id || 'n/a'} status=${u.status || 'n/a'} type=${u.update?.status || 'n/a'}`, u);
        } catch (err) {
          console.debug(`[CLIENT ${id}] messages.update logging falhou: ${err.message}`);
        }
      }
    });

    client.ev.on('presence.update', (p) => {
      console.log(`[CLIENT ${id}] presence.update:`, p);
    });

    client.ev.on('chats.set', (c) => {
      console.log(`[CLIENT ${id}] chats.set: total=${c.length}`);
    });

  } catch (error) {
    console.error(`[CLIENT ${id}] Erro crítico ao criar socket: ${error.message}`);
    creatingQr.delete(id);
    clearSessionDir(sessionPath);
    // Remove qualquer cliente parcialmente criado
    if (clients.has(id)) clients.delete(id);
    throw error;
  }

  console.log(`[CLIENT ${id}] Retornando instância do cliente (inicialização em andamento).`);
  return client;
};

// --- Envio de Mensagem ---
const sendMessage = async (clinicId, number, message) => {
  const id = clinicId.toString();
  let client = clients.get(id);
  let currentStatus = getClientStatus(id);

  console.log(`[SEND ${id}] Tentando enviar para ${number}. Status inicial: ${currentStatus}`);

  // Aguarda conexão
  const waitForConnection = async () => {
    const maxWait = 15000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      currentStatus = getClientStatus(id);
      if (currentStatus === 'connected') break;
      if (currentStatus === 'disconnected') {
        if (client) await logoutAndRemoveClient(id);
        // inicia (não await a chamada se quiser background init) — aqui aguardamos para garantir conn
        await initializeClient(clinicId);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    currentStatus = getClientStatus(id);
    if (currentStatus !== 'connected') {
      throw new Error(`Timeout: Cliente não conectou após ${maxWait}ms. Status: ${currentStatus}`);
    }
  };

  if (currentStatus !== 'connected') {
    console.log(`[SEND ${id}] Cliente não conectado. Aguardando...`);
    await waitForConnection();
  }

  client = clients.get(id);
  if (!client || !client.user) {
    throw new Error("Cliente não está conectado ou não autenticado.");
  }

  const chatId = number.endsWith('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

  try {
    console.log(`[SEND ${id}] Enviando para ${chatId}...`);
    const result = await client.sendMessage(chatId, { text: message });
    console.log(`[SEND ${id}] Mensagem enviada com sucesso. ID: ${result.key?.id || 'n/a'}`);
    return result;
  } catch (error) {
    console.error(`[SEND ${id}] Falha ao enviar mensagem:`, error.message || error);
    // Se erro de login/conn, limpa cliente para forçar reauth no próximo envio
    if ((error.message && error.message.includes('not logged in')) || (error.message && error.message.includes('connection closed'))) {
      try { await logoutAndRemoveClient(clinicId); } catch (e) { /* ignora */ }
    }
    throw new Error(`Falha ao enviar mensagem: ${error.message || String(error)}`);
  }
};

// --- Admin helpers ---
const initializeAdminClient = async () => {
  console.log(`[CLIENT ${ADMIN_CLIENT_ID}] Inicializando cliente admin...`);
  return initializeClient(ADMIN_CLIENT_ID);
};

const getAdminClientStatus = () => {
  return getClientStatus(ADMIN_CLIENT_ID);
};

const getAdminQrCode = () => {
  if (qrCodes.has(ADMIN_CLIENT_ID)) {
    return qrCodes.get(ADMIN_CLIENT_ID);
  }
  return null;
};

const sendAdminMessage = async (number, message) => {
  console.log(`[SEND ${ADMIN_CLIENT_ID}] Enviando mensagem admin para ${number}`);
  return sendMessage(ADMIN_CLIENT_ID, number, message);
};

// --- Funções utilitárias para expor a conexão ---
/**
 * Retorna a instância do socket (conn) para um clinicId, ou null se não existir.
 * Ex.: const conn = whatsappClient.getConn(clinicId);
 */
const getConn = (clinicId) => {
  const id = clinicId ? clinicId.toString() : null;
  if (!id) return null;
  return clients.get(id) || null;
};

/**
 * Retorna a "entry" completa do cliente — no design atual a entry é o próprio socket.
 * Mantido para compatibilidade futura caso queira armazenar objetos { conn, status }.
 */
const getClientEntry = (clinicId) => {
  const id = clinicId ? clinicId.toString() : null;
  if (!id) return null;
  return clients.get(id) || null;
};

// --- Exports ---
module.exports = {
  initializeMongoStore,
  initializeClient,
  getClientStatus,
  logoutAndRemoveClient,
  sendMessage,
  clients,
  qrCodes,

  ADMIN_CLIENT_ID,
  initializeAdminClient,
  getAdminClientStatus,
  getAdminQrCode,
  sendAdminMessage,

  // Exports novos
  getConn,
  getClientEntry,
};
