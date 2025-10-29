// src/services/whatsapp.client.js

// === Dependências ===
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode");
const mongoose = require("mongoose");
const path = require("path");
const os = require("os");
const fs = require("fs");

// --- Armazenamento Global ---
const clients = new Map();     // clinicId -> socket Baileys
const qrCodes = new Map();     // clinicId -> dataURL do QR
const creatingQr = new Map();  // clinicId -> boolean (QR em criação)
let mongoStore;                // Mantido por compatibilidade com a API antiga

// === Helpers ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const safeDeleteMaps = (id) => {
  qrCodes.delete(id);
  creatingQr.delete(id);
};

const mapBaileysToStatus = (sockWrapper) => {
  if (!sockWrapper) return "disconnected";
  const { state, hasInfo } = sockWrapper;
  if (qrCodes.has(sockWrapper.id)) return "qrcode_pending";
  if (creatingQr.has(sockWrapper.id)) return "creating_qr";
  if (hasInfo) return "connected";
  if (state === "connecting" || state === "qr" || state === "starting")
    return "initializing";
  return "disconnected";
};

const formatJid = (number) => {
  // Aceita @c.us (wwebjs) e converte para @s.whatsapp.net (Baileys)
  if (number.endsWith("@s.whatsapp.net")) return number;
  if (number.endsWith("@c.us"))
    return number.replace("@c.us", "@s.whatsapp.net");
  return `${number}@s.whatsapp.net`;
};

// === Inicialização do MongoStore (compat) ===
const initializeMongoStore = () => {
  // Mantemos a checagem para compatibilidade com o antigo RemoteAuth,
  // ainda que Baileys use auth em disco por padrão neste serviço.
  if (
    !mongoose.connection.readyState ||
    mongoose.connection.readyState === 0 ||
    mongoose.connection.readyState === 3
  ) {
    console.error(
      "Mongoose não está conectado. Não foi possível inicializar o MongoStore."
    );
    return false;
  }
  if (!mongoStore) {
    try {
      // Compat placeholder: ficamos só com o ponteiro setado para indicar "ok"
      mongoStore = { ok: true };
      console.log(
        "MongoStore (compat) para sessões WhatsApp marcado como inicializado."
      );
      return true;
    } catch (error) {
      console.error("Erro ao criar MongoStore (compat):", error);
      return false;
    }
  }
  return true;
};

// === Status do Cliente ===
const getClientStatus = (clinicId) => {
  const id = clinicId.toString();
  const wrapper = clients.get(id);
  if (!wrapper) return "disconnected";
  return mapBaileysToStatus(wrapper);
};

// === Logout e Remoção ===
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

  safeDeleteMaps(id);
  console.log(`[CLIENT ${id}] Cliente removido e limpo da memória.`);
};

// === Inicialização do Cliente (Baileys) ===
const initializeClient = async (clinicId) => {
  const id = clinicId.toString();
  console.log(`[CLIENT ${id}] Iniciando processo de inicialização...`);

  // Se já existe na memória, decide conforme status
  if (clients.has(id)) {
    const existing = clients.get(id);
    const status = getClientStatus(id);
    console.log(
      `[CLIENT ${id}] Cliente já existe na memória. Status: ${status}, State: ${existing.state}`
    );
    if (
      status === "connected" ||
      status === "initializing" ||
      status === "creating_qr" ||
      status === "qrcode_pending"
    ) {
      console.log(`[CLIENT ${id}] Retornando cliente existente.`);
      return existing.sock;
    } else {
      console.log(
        `[CLIENT ${id}] Cliente em estado inválido (${status}). Removendo antes de recriar.`
      );
      await logoutAndRemoveClient(id);
    }
  }

  if (!mongoStore && !initializeMongoStore()) {
    throw new Error(
      "MongoStore não pôde ser inicializado. Verifique a conexão com o MongoDB."
    );
  }

  // Marca flag de criação de QR antes de iniciar
  creatingQr.set(id, true);
  console.log(`[CLIENT ${id}] Marcando criação de QR code.`);

  // Caminho de sessão em disco (persistência)
  const dataPath = path.resolve(`.baileys_auth/session-${id}`);
  ensureDir(dataPath);
  console.log(`[CLIENT ${id}] Usando dataPath: ${dataPath}`);


  // Auth em disco (multi-file)
  const { state, saveCreds } = await useMultiFileAuthState(dataPath);

  // Wrapper para guardar metadados de status
  const wrapper = {
    id,
    sock: null,
    state: "starting",
    hasInfo: false,
  };

  // Cria o socket Baileys
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: undefined,
    browser: Browsers.macOS("Chrome"),
    syncFullHistory: false,
  });

  // Atribui no wrapper e salva no mapa
  wrapper.sock = sock;
  clients.set(id, wrapper);

  // === Eventos ===
  // QR
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        console.log(`[CLIENT ${id}] Evento QR recebido.`);
        const qrDataUrl = await qrcode.toDataURL(qr);
        qrCodes.set(id, qrDataUrl);
        creatingQr.delete(id);
        wrapper.state = "qr";
        console.log(
          `[CLIENT ${id}] QR code gerado e armazenado. Flag 'creatingQr' removida.`
        );
      } catch (qrErr) {
        console.error(
          `[CLIENT ${id}] Erro ao gerar QR Data URL: ${qrErr.message}`
        );
        creatingQr.delete(id);
        wrapper.state = "qr_error";
      }
    }

    if (connection === "open") {
      console.log(`[CLIENT ${id}] Conexão aberta (READY).`);
      wrapper.state = "connected";
      wrapper.hasInfo = true;
      safeDeleteMaps(id);
      // Baileys não expõe pushname diretamente aqui; ok manter log enxuto
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.warn(`[CLIENT ${id}] Conexão fechada. Code: ${code}`);
      safeDeleteMaps(id);

      // Decide se tenta limpeza total
      const mustLogout =
        code === DisconnectReason.loggedOut ||
        code === DisconnectReason.badSession ||
        code === DisconnectReason.restartRequired;

      if (mustLogout) {
        await logoutAndRemoveClient(id);
      } else {
        // Mantém cliente para possível reinit por fora
        wrapper.state = "disconnected";
      }
    } else if (connection === "connecting") {
      wrapper.state = "connecting";
      console.log(`[CLIENT ${id}] Conectando...`);
    }
  });

  // Credenciais: persistência
  sock.ev.on("creds.update", saveCreds);

  // Eventos de mensagens/erros (logs básicos)
  sock.ev.on("messaging-history.set", () =>
    console.log(`[CLIENT ${id}] Histórico sincronizado (parcial).`)
  );
  sock.ev.on("ws.close", () =>
    console.warn(`[CLIENT ${id}] WS fechado (ws.close).`)
  );
  sock.ev.on("ws.open", () => console.log(`[CLIENT ${id}] WS aberto.`));

  console.log(`[CLIENT ${id}] Retornando instância (inicialização em andamento).`);
  return sock;
};

// === Envio de Mensagem (Baileys) ===
const sendMessage = async (clinicId, number, message) => {
  const id = clinicId.toString();
  const wrapper = clients.get(id);
  let currentStatus = getClientStatus(id);

  console.log(
    `[SEND ${id}] Tentando enviar para ${number}. Status inicial: ${currentStatus}`
  );

  // Se não conectado, tenta aguardar/reativar logicamente (sem alterar contrato)
  if (currentStatus !== "connected") {
    console.warn(
      `[SEND ${id}] Cliente não conectado (status: ${currentStatus}). Verificando instância...`
    );

    if (wrapper) {
      if (
        currentStatus === "initializing" ||
        currentStatus === "creating_qr" ||
        currentStatus === "qrcode_pending"
      ) {
        console.log(
          `[SEND ${id}] Estado ${currentStatus}. Aguardando até 15s por conexão...`
        );
        await sleep(15000);
        currentStatus = getClientStatus(id);
        console.log(`[SEND ${id}] Status após aguardar: ${currentStatus}`);
        if (currentStatus !== "connected") {
          throw new Error(
            `Cliente WhatsApp não conectou após ${currentStatus}. Status: ${currentStatus}`
          );
        }
      } else {
        console.warn(
          `[SEND ${id}] Estado ${currentStatus}. Tentando reinicializar...`
        );
        try {
          await initializeClient(clinicId);
          await sleep(15000);
          currentStatus = getClientStatus(id);
          if (currentStatus !== "connected") {
            throw new Error(
              `Cliente não conectou após reinicialização forçada. Status: ${currentStatus}`
            );
          }
          console.log(`[SEND ${id}] Cliente conectado após reinicialização.`);
        } catch (initError) {
          console.error(
            `[SEND ${id}] Falha ao reinicializar: ${initError.message}`
          );
          throw new Error(`Cliente WhatsApp não conectado: ${initError.message}`);
        }
      }
    } else {
      console.warn(
        `[SEND ${id}] Nenhuma instância encontrada. Tentando inicializar...`
      );
      try {
        await initializeClient(clinicId);
        await sleep(15000);
        currentStatus = getClientStatus(id);
        if (currentStatus !== "connected") {
          throw new Error(
            `Cliente não conectou após inicialização inicial. Status: ${currentStatus}`
          );
        }
        console.log(`[SEND ${id}] Cliente conectado após inicialização inicial.`);
      } catch (initError) {
        console.error(
          `[SEND ${id}] Falha ao inicializar: ${initError.message}`
        );
        throw new Error(`Cliente WhatsApp não conectado: ${initError.message}`);
      }
    }
  }

  // Releitura do wrapper (pode ter sido recriado)
  const finalWrapper = clients.get(id);
  if (!finalWrapper || getClientStatus(id) !== "connected") {
    throw new Error(
      `Erro inesperado: Cliente não disponível ou não conectado após verificações.`
    );
  }

  const chatJid = formatJid(number);

  try {
    console.log(`[SEND ${id}] Enviando para jid ${chatJid}...`);
    const result = await finalWrapper.sock.sendMessage(chatJid, {
      text: message,
    });
    // Baileys retorna objeto com key.id
    const sentId = result?.key?.id || "unknown";
    console.log(
      `[SEND ${id}] Mensagem enviada com sucesso para ${number}. ID: ${sentId}`
    );
    return result;
  } catch (error) {
    console.error(`[SEND ${id}] Falha ao enviar mensagem para ${number}:`, error);

    const msg = String(error?.message || "");
    if (
      msg.includes("connection closed") ||
      msg.includes("timed out") ||
      msg.includes("disconnected")
    ) {
      console.warn(
        `[SEND ${id}] Erro indica desconexão ou instabilidade. Limpando cliente.`
      );
      await logoutAndRemoveClient(clinicId);
    }
    throw new Error(`Falha ao enviar mensagem: ${msg || "erro desconhecido"}`);
  }
};

// === Exports ===
module.exports = {
  initializeMongoStore,
  initializeClient,
  getClientStatus,
  logoutAndRemoveClient,
  sendMessage,
  clients,
  qrCodes,
};