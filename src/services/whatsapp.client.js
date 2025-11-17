// src/services/whatsapp.client.js
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  Browsers,
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



// === CORREÇÃO DA FUNÇÃO DE STATUS ===
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

const cleanupClientMemory = (clinicId) => {
  const id = clinicId.toString();
  const client = clients.get(id);

  if (client) {
    console.log(`[CLEANUP ${id}] Limpando cliente da memória (sem logout/delete de sessão).`);
    try {
      // Tenta fechar a conexão WS e remover listeners sem deslogar
      if (client.ws?.close) client.ws.close();
      if (client.ev?.removeAllListeners) client.ev.removeAllListeners();
    } catch (err) {
      console.warn(`[CLEANUP ${id}] Erro (seguro) ao fechar socket: ${err.message}`);
    }
  }
  
  clients.delete(id); // Remove da memória
  safeDeleteMaps(id); // Limpa QR codes pendentes ou flags de criação
  console.log(`[CLEANUP ${id}] Cliente removido da memória.`);
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


// --- Envio de Mensagem (COM 3 TENTATIVAS - CORRIGIDO) ---
const sendMessage = async (clinicId, number, message) => {
  const id = clinicId.toString();
  const MAX_RETRIES = 3; // 3 tentativas

  // --- Helper de conexão (do arquivo original) ---
  const waitForConnection = async () => {
    let client = clients.get(id);
    let currentStatus = getClientStatus(id);
    const maxWait = 15000; // 15s
    const start = Date.now();
    
    console.log(`[WAIT ${id}] Aguardando conexão. Status: ${currentStatus}`);

    while (Date.now() - start < maxWait) {
      currentStatus = getClientStatus(id);
      if (currentStatus === 'connected') {
          console.log(`[WAIT ${id}] Conectado.`);
          return clients.get(id); // Retorna o cliente conectado
      }
      
      if (currentStatus === 'disconnected') {
        console.log(`[WAIT ${id}] Cliente desconectado. Iniciando reconexão...`);
        // Aqui não precisamos limpar, apenas inicializar
        // A initializeClient já verifica se existe (clients.has(id))
        if (clients.has(id)) {
           console.warn(`[WAIT ${id}] Cliente existe mas está desconectado. Limpando da memória.`);
           cleanupClientMemory(id); // Limpa só da memória
        }

        try {
             await initializeClient(clinicId); // Tenta inicializar usando a sessão do disco
        } catch (initError) {
            console.error(`[WAIT ${id}] Falha ao iniciar cliente durante espera: ${initError.message}`);
            throw new Error(`Falha ao reiniciar cliente: ${initError.message}`);
        }
      }
      
      await new Promise(r => setTimeout(r, 1000));
    }
    
    // Timeout
    currentStatus = getClientStatus(id);
    if (currentStatus !== 'connected') {
      throw new Error(`Timeout: Cliente não conectou após ${maxWait}ms. Status: ${currentStatus}`);
    }
    return clients.get(id);
  };
  // --- Fim do helper ---


  // --- Início do Loop de Tentativas ---
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[SEND ${id}] Tentativa ${attempt}/${MAX_RETRIES} para ${number}.`);
    
    let client;
    try {
      let currentStatus = getClientStatus(id);
      if (currentStatus !== 'connected') {
        console.log(`[SEND ${id}] Não conectado (Status: ${currentStatus}). Acionando waitForConnection...`);
        client = await waitForConnection(); 
      } else {
        client = clients.get(id); // Pega o cliente já conectado
      }

      if (!client || !client.user) {
        throw new Error("Cliente não está conectado ou não autenticado após espera.");
      }

      const chatId = number.endsWith('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

      console.log(`[SEND ${id}] Enviando para ${chatId} (Tentativa ${attempt})...`);
      
      const result = await client.sendMessage(chatId, { text: message });
      
      console.log(`[SEND ${id}] Mensagem enviada com sucesso. ID: ${result.key?.id || 'n/a'}`);
      return result; // SUCESSO!

    } catch (error) {
      console.warn(`[SEND ${id}] Erro na tentativa ${attempt}:`, error.message || error);
      
      const errorMsg = (error.message || '').toLowerCase();
      const isConnectionError = errorMsg.includes('not logged in') || 
                                errorMsg.includes('connection closed') || 
                                errorMsg.includes('disconnected') ||
                                errorMsg.includes('timeout') || 
                                errorMsg.includes('cliente não conectou');

      if (isConnectionError) {
        console.warn(`[SEND ${id}] Erro de conexão detectado. Limpando cliente DA MEMÓRIA.`);
        
        // **A MUDANÇA CRÍTICA ESTÁ AQUI**
        // Não usamos mais logoutAndRemoveClient, que apaga a sessão.
        // Usamos a função leve que só limpa a memória.
        cleanupClientMemory(clinicId); 
        
        if (attempt === MAX_RETRIES) {
          console.error(`[SEND ${id}] Falha final após ${MAX_RETRIES} tentativas.`);
          throw new Error(`Falha ao enviar mensagem após ${MAX_RETRIES} tentativas: ${error.message || String(error)}`);
        }
        
        await new Promise(r => setTimeout(r, 2000)); // Espera antes de tentar de novo
        
      } else {
        // Erro não recuperável (ex: número inválido)
        console.error(`[SEND ${id}] Erro não recuperável. Parando tentativas.`);
        throw error; 
      }
    }
  }
  // --- Fim do Loop de Tentativas ---
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
  cleanupClientMemory,
  getClientEntry,
};
