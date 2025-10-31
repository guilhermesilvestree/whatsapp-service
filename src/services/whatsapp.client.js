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
// const os = require('os'); // <--- REMOVIDO (não é mais necessário)
const fs = require('fs');
const p = require('pino'); // Logger leve do Baileys

// --- Armazenamento Global ---
const clients = new Map(); // Armazena instâncias do socket por clinicId
const qrCodes = new Map(); // Armazena QR codes (string) por clinicId
const creatingQr = new Map(); // Flag para indicar que um QR está sendo gerado

// --- Inicialização do MongoStore ---
const initializeMongoStore = () => {
  if (!mongoose.connection.readyState || mongoose.connection.readyState === 0 || mongoose.connection.readyState === 3) {
    console.error("Mongoose não está conectado. Não foi possível inicializar o MongoStore.");
    return false;
  }
  return true; // Baileys não usa MongoStore diretamente, mas mantemos para compatibilidade
};

// --- Obter Status do Cliente ---
const getClientStatus = (clinicId) => {
  const id = clinicId.toString();
  const client = clients.get(id);
  if (!client) return "disconnected";
  if (qrCodes.has(id)) return "qrcode_pending";
  if (creatingQr.has(id)) return "creating_qr";
  if (client.user) return "connected";
  if (client.ws && client.ws.readyState === 1) return "initializing";
  return "disconnected";
};

// --- Logout e Remoção ---
const logoutAndRemoveClient = async (clinicId) => {
  const id = clinicId.toString();
  const client = clients.get(id);
  if (client) {
    console.log(`[CLIENT ${id}] Iniciando logout e remoção...`);
    try {
      if (client.ws && client.ws.readyState === 1) {
        await client.logout();
        console.log(`[CLIENT ${id}] Logout realizado.`);
      }
    } catch (error) {
      console.warn(`[CLIENT ${id}] Erro durante logout: ${error.message}`);
    }
    try {
      client.end();
    } catch (error) {
      console.warn(`[CLIENT ${id}] Erro ao finalizar socket: ${error.message}`);
    } finally {
      clients.delete(id);
    }
  } else {
    console.log(`[CLIENT ${id}] Cliente não encontrado na memória para logout/remoção.`);
  }
  qrCodes.delete(id);
  creatingQr.delete(id);
  console.log(`[CLIENT ${id}] Cliente removido e limpo da memória.`);
};

// --- Limpeza do diretório de sessão ---
const clearSessionDir = (dirPath) => {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`[SESSION] Diretório de sessão limpo: ${dirPath}`);
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

  // --- Diretório de autenticação (CORRIGIDO PARA A RAIZ DO PROJETO) ---
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

    clients.set(id, client);
    console.log(`[CLIENT ${id}] Instância do socket criada.`);

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
          console.log(`[CLIENT ${id}] Usuário: ${client.user.id}, Nome: ${client.user.name}`);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.warn(`[CLIENT ${id}] Conexão fechada: ${lastDisconnect?.error?.message || 'Desconhecido'}`);
        qrCodes.delete(id);
        creatingQr.delete(id);

        if (shouldReconnect) {
          console.log(`[CLIENT ${id}] Tentando reconectar...`);
          setTimeout(() => initializeClient(clinicId), 3000);
        } else {
          console.log(`[CLIENT ${id}] Logout detectado. Limpando sessão.`);
          clearSessionDir(sessionPath);
          await logoutAndRemoveClient(id);
        }
      }
    });

    client.ev.on('messages.upsert', () => {}); // Evita erro de evento não tratado

  } catch (error) {
    console.error(`[CLIENT ${id}] Erro crítico ao criar socket: ${error.message}`);
    creatingQr.delete(id);
    clearSessionDir(sessionPath);
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
    console.log(`[SEND ${id}] Mensagem enviada com sucesso. ID: ${result.key.id}`);
    return result;
  } catch (error) {
    console.error(`[SEND ${id}] Falha ao enviar mensagem:`, error.message);
    if (error.message.includes('not logged in') || error.message.includes('connection closed')) {
      await logoutAndRemoveClient(clinicId);
    }
    throw new Error(`Falha ao enviar mensagem: ${error.message}`);
  }
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
};