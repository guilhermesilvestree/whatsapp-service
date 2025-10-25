// src/services/whatsapp.client.js

const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const qrcode = require("qrcode");
const mongoose = require("mongoose");
const path = require("path");
const os = require("os");
const fs = require("fs");

// --- Armazenamento Global ---
const clients = new Map(); // Armazena instâncias do Client por clinicId
const qrCodes = new Map(); // Armazena QR codes ativos por clinicId
const creatingQr = new Map(); // Flag para indicar que um QR está sendo gerado
let mongoStore; // Instância única do MongoStore

// --- Inicialização do MongoStore ---
const initializeMongoStore = () => {
  // Verifica se o Mongoose está conectado (estados 1: connected, 2: connecting)
  if (!mongoose.connection.readyState || mongoose.connection.readyState === 0 || mongoose.connection.readyState === 3) {
    console.error("Mongoose não está conectado. Não foi possível inicializar o MongoStore.");
    return false; // Retorna falha
  }
  if (!mongoStore) {
    try {
        mongoStore = new MongoStore({ mongoose: mongoose });
        console.log("MongoStore para sessões WhatsApp inicializado com sucesso.");
        return true; // Retorna sucesso
    } catch (error) {
        console.error("Erro ao criar MongoStore:", error);
        return false; // Retorna falha
    }
  }
  return true; // Já inicializado
};

// --- Obter Status do Cliente ---
const getClientStatus = (clinicId) => {
  const id = clinicId.toString();
  const client = clients.get(id);

  if (!client) return "disconnected";

  // Debug log (opcional)
  // console.log(`[DEBUG STATUS ${id}] Client state: ${client.state}`);

  if (qrCodes.has(id)) return "qrcode_pending";
  if (creatingQr.has(id)) return "creating_qr";
  if (client.info) return "connected"; // Confia no objeto info se existe

  // Estados intermediários ou de inicialização
  if (client.state === 'INITIALIZING' || client.state === 'STARTING' || client.state === 'QRCODE') return "initializing";

  // Estados que geralmente indicam necessidade de reconexão ou problema
  if (client.state === 'CONFLICT' || client.state === 'UNPAIRED' || client.state === 'UNLAUNCHED' || client.state === 'UNPAIRED_IDLE') return "disconnected";

  // Fallback - Se o estado for desconhecido ou não mapeado, assume desconectado
  return "disconnected";
};

// --- Logout e Remoção ---
const logoutAndRemoveClient = async (clinicId) => {
  const id = clinicId.toString();
  const client = clients.get(id);

  if (client) {
    console.log(`[CLIENT ${id}] Iniciando logout e remoção... Estado atual: ${client.state}`);
    try {
      // Tenta fazer logout APENAS se o cliente parece estar num estado conectado ou pronto
       // Adiciona verificação explícita por client.pupPage para mais segurança
       const isLikelyConnected = client.info || client.state === 'READY' || client.state === 'CONNECTED' || (client.pupPage && !client.pupPage.isClosed());
      if (isLikelyConnected) {
        await client.logout();
        console.log(`[CLIENT ${id}] Logout realizado.`);
      } else {
        console.log(`[CLIENT ${id}] Pulando logout (estado ${client.state} ou sem página).`);
      }
    } catch (error) {
      console.warn(`[CLIENT ${id}] Erro (seguro) durante logout: ${error.message}`);
    }

    try {
      // Tenta destruir a instância do navegador se ela existir
      // Adiciona verificação se pupBrowser existe antes de chamar destroy
       if (client.pupBrowser) {
           await client.destroy();
           console.log(`[CLIENT ${id}] Destroy realizado.`);
       } else {
           console.warn(`[CLIENT ${id}] Pulando destroy (client.pupBrowser não encontrado).`);
       }
    } catch (error) {
      // Captura erros específicos de 'Target closed' que podem ocorrer se o browser já fechou
      if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
           console.warn(`[CLIENT ${id}] Erro esperado durante destroy (Target/Session closed): ${error.message}`);
      } else {
           console.warn(`[CLIENT ${id}] Erro (inesperado) durante destroy: ${error.message}`);
      }
    } finally {
        // Garante a remoção do mapa mesmo se destroy falhar
        clients.delete(id);
    }
  } else {
      console.log(`[CLIENT ${id}] Cliente não encontrado na memória para logout/remoção.`);
  }

  // Limpa QR codes e flags associadas
  qrCodes.delete(id);
  creatingQr.delete(id);
  console.log(`[CLIENT ${id}] Cliente removido e limpo da memória.`);
};

// --- Inicialização do Cliente ---
const initializeClient = async (clinicId) => {
  const id = clinicId.toString();
  console.log(`[CLIENT ${id}] Iniciando processo de inicialização...`);

  // Verifica se já existe um cliente e se está num estado 'bom' ou inicializando
  if (clients.has(id)) {
    const existingClient = clients.get(id);
    const status = getClientStatus(id);
    console.log(`[CLIENT ${id}] Cliente já existe na memória. Status: ${status}, State: ${existingClient.state}`);
    // Se está conectado, inicializando, esperando QR ou criando QR, retorna o existente
    if (status === 'connected' || status === 'initializing' || status === 'creating_qr' || status === 'qrcode_pending') {
        console.log(`[CLIENT ${id}] Retornando cliente existente.`);
        return existingClient;
    } else {
        console.log(`[CLIENT ${id}] Cliente existente em estado inválido (${status}). Forçando remoção antes de recriar.`);
        await logoutAndRemoveClient(id); // Limpa o estado ruim
    }
  }

  if (!mongoStore && !initializeMongoStore()) { // Tenta inicializar se ainda não o fez
    throw new Error("MongoStore não pôde ser inicializado. Verifique a conexão com o MongoDB.");
  }

  // Marca que está criando QR code ANTES de iniciar o processo
  creatingQr.set(id, true);
  console.log(`[CLIENT ${id}] Marcando criação de QR code.`);

  // --- Configuração do Data Path ---
  const dataPath = path.join(os.tmpdir(), ".wwebjs_auth", `session-${id}`);
  if (!fs.existsSync(dataPath)) {
    try {
      fs.mkdirSync(dataPath, { recursive: true });
      console.log(`[CLIENT ${id}] Diretório dataPath criado: ${dataPath}`);
    } catch (err) {
      creatingQr.delete(id); // Limpa flag em caso de erro
      throw new Error(`Falha ao criar diretório de sessão: ${err.message}`);
    }
  } else {
      console.log(`[CLIENT ${id}] Usando dataPath existente: ${dataPath}`);
  }

  // --- Estratégia de Autenticação ---
  const authStrategy = new RemoteAuth({
    store: mongoStore,
    clientId: id,
    backupSyncIntervalMs: 600000, // Backup a cada 10 minutos
    dataPath: dataPath,
  });

  // --- Opções do Puppeteer (Usando o padrão baixado) ---
  let puppeteerOptions = {
    headless: 'new', // Modo headless padrão recomendado
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Essencial para containers (Render, Docker)
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu', // Útil em ambientes sem GPU dedicada
      // '--single-process', // Pode usar menos memória, mas pode ser menos estável
      '--disable-extensions'
    ],
    // userDataDir: dataPath // Pode ajudar na persistência, mas RemoteAuth já usa dataPath
  };

  console.log(`[CLIENT ${id}] Usando puppeteer padrão. Opções:`, { args: puppeteerOptions.args, headless: puppeteerOptions.headless });

  // --- Criação do Cliente ---
  let client;
  try {
    client = new Client({
      authStrategy: authStrategy,
      puppeteer: puppeteerOptions,
      // Aumenta timeouts para dar mais tempo em ambientes lentos
      // qrTimeout: 60000, // 60 segundos para escanear QR
      // authTimeoutMs: 90000, // 90 segundos para autenticar
      takeoverOnConflict: true, // Tenta resolver conflitos de sessão
      takeoverTimeoutMs: 0 // Espera indefinidamente se houver conflito (pode precisar de ajuste)
    });
    console.log(`[CLIENT ${id}] Instância do Client criada.`);
  } catch (error) {
    console.error(`[CLIENT ${id}] Erro crítico ao instanciar Client: ${error.message}`);
    creatingQr.delete(id);
    throw error;
  }

  // Adiciona ao mapa ANTES de adicionar listeners e inicializar
  clients.set(id, client);

  // --- Listeners de Eventos ---
  client.removeAllListeners(); // Garante que não haja listeners duplicados de tentativas anteriores

  client.on("qr", async (qr) => {
    console.log(`[CLIENT ${id}] Evento QR recebido.`);
    try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        qrCodes.set(id, qrDataUrl);
        creatingQr.delete(id); // Limpa a flag AQUI, pois o QR está pronto
        console.log(`[CLIENT ${id}] QR code gerado e armazenado. Flag 'creatingQr' removida.`);
    } catch (qrError) {
        console.error(`[CLIENT ${id}] Erro ao gerar QR Data URL: ${qrError.message}`);
        // Considerar limpar a flag creatingQr mesmo em erro para permitir nova tentativa?
        creatingQr.delete(id);
    }
  });

  client.on("ready", () => {
    console.log(`[CLIENT ${id}] Evento READY recebido. Cliente está pronto!`);
    qrCodes.delete(id); // Limpa QR code se ainda existir
    creatingQr.delete(id); // Garante que a flag seja removida
    if (client.info) {
        console.log(`[CLIENT ${id}] Informações: ${client.info.wid.user}, PushName: ${client.info.pushname}`);
    } else {
        console.warn(`[CLIENT ${id}] Cliente 'ready', mas 'client.info' não está disponível ainda.`);
    }
  });

  client.on("authenticated", () => {
    console.log(`[CLIENT ${id}] Evento AUTHENTICATED recebido.`);
    qrCodes.delete(id); // Limpa QR se a autenticação ocorrer (ex: restauração de sessão)
    creatingQr.delete(id);
  });

  client.on("auth_failure", async (msg) => {
    console.error(`[CLIENT ${id}] Evento AUTH_FAILURE recebido: ${msg}`);
    qrCodes.delete(id);
    creatingQr.delete(id);
    await logoutAndRemoveClient(clinicId); // Tenta limpar completamente o estado inválido
  });

  client.on("disconnected", async (reason) => {
    console.warn(`[CLIENT ${id}] Evento DISCONNECTED recebido: ${reason}`);
    qrCodes.delete(id);
    creatingQr.delete(id);
    // Tenta remover o cliente da memória para forçar reinicialização na próxima chamada
    await logoutAndRemoveClient(clinicId);
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[CLIENT ${id} LOADING] ${percent}% ${message}`);
  });

  client.on('error', (err) => {
    console.error(`[CLIENT ${id} ERROR] Erro na instância do cliente:`, err);
    // Considerar chamar logoutAndRemoveClient aqui dependendo da gravidade do erro
  });

  // --- Inicialização ---
  console.log(`[CLIENT ${id}] Chamando client.initialize()...`);
  client.initialize().then(() => {
    // Este 'then' pode ser chamado antes do 'ready' ou 'authenticated'
    console.log(`[CLIENT ${id}] Promise de initialize() resolvida.`);
    // Não limpa creatingQr aqui, espera os eventos 'ready' ou 'authenticated'
  }).catch(async (err) => {
    console.error(`[CLIENT ${id}] ERRO CATASTRÓFICO durante initialize():`, err);
    qrCodes.delete(id);
    creatingQr.delete(id);
    // Tenta limpar o cliente se a inicialização falhar catastroficamente
    await logoutAndRemoveClient(clinicId);
  });

  console.log(`[CLIENT ${id}] Retornando instância do cliente (inicialização em andamento).`);
  return client; // Retorna o cliente imediatamente, a inicialização continua em background
};

// --- Envio de Mensagem ---
const sendMessage = async (clinicId, number, message) => {
  const id = clinicId.toString();
  const client = clients.get(id);
  let currentStatus = getClientStatus(id); // Pega o status inicial

  console.log(`[SEND ${id}] Tentando enviar para ${number}. Status inicial: ${currentStatus}`);

  // Verifica se o cliente está conectado
  if (currentStatus !== "connected") {
    console.warn(`[SEND ${id}] Cliente não conectado (status: ${currentStatus}). Verificando se existe instância...`);
    // Se não está conectado, mas existe uma instância, pode estar inicializando ou esperando QR
    if (client) {
         // Se estiver inicializando ou esperando QR, aguarda um pouco
        if (currentStatus === 'initializing' || currentStatus === 'creating_qr' || currentStatus === 'qrcode_pending') {
            console.log(`[SEND ${id}] Cliente em estado ${currentStatus}. Aguardando até 15 segundos por conexão...`);
            // Espera um tempo limitado para ver se conecta
            await new Promise(resolve => setTimeout(resolve, 15000));
            currentStatus = getClientStatus(id); // Reavalia o status
            console.log(`[SEND ${id}] Status após aguardar: ${currentStatus}`);
            if (currentStatus !== 'connected') {
                 throw new Error(`Cliente WhatsApp não conectou após ${currentStatus}. Status: ${currentStatus}`);
            }
        } else { // Se o estado é 'disconnected' ou outro não esperado
             console.warn(`[SEND ${id}] Cliente em estado ${currentStatus}. Tentando reinicializar...`);
             try {
                 await initializeClient(clinicId); // Tenta recomeçar
                 await new Promise(resolve => setTimeout(resolve, 15000)); // Espera novamente
                 currentStatus = getClientStatus(id);
                 if (currentStatus !== 'connected') {
                     throw new Error(`Cliente não conectou após reinicialização forçada. Status: ${currentStatus}`);
                 }
                 console.log(`[SEND ${id}] Cliente conectado após reinicialização.`);
             } catch (initError) {
                 console.error(`[SEND ${id}] Falha ao reinicializar: ${initError.message}`);
                 throw new Error(`Cliente WhatsApp não conectado: ${initError.message}`);
             }
        }

    } else {
        // Se não há instância do cliente, tenta criar uma nova
        console.warn(`[SEND ${id}] Nenhuma instância do cliente encontrada. Tentando inicializar...`);
         try {
             await initializeClient(clinicId);
             await new Promise(resolve => setTimeout(resolve, 15000)); // Espera
             currentStatus = getClientStatus(id);
             if (currentStatus !== 'connected') {
                  throw new Error(`Cliente não conectou após inicialização inicial. Status: ${currentStatus}`);
             }
             console.log(`[SEND ${id}] Cliente conectado após inicialização inicial.`);
         } catch (initError) {
             console.error(`[SEND ${id}] Falha ao inicializar: ${initError.message}`);
             throw new Error(`Cliente WhatsApp não conectado: ${initError.message}`);
         }
    }
  }

  // Pega a instância novamente, caso tenha sido recriada
  const finalClient = clients.get(id);
  if (!finalClient || getClientStatus(id) !== 'connected') {
      throw new Error(`Erro inesperado: Cliente não disponível ou não conectado após verificações.`);
  }


  // Formata o número para o padrão chatId (numero@c.us)
  const chatId = number.endsWith("@c.us") ? number : `${number}@c.us`;

  try {
    console.log(`[SEND ${id}] Enviando para chatId ${chatId}...`);
    const result = await finalClient.sendMessage(chatId, message);
    console.log(`[SEND ${id}] Mensagem enviada com sucesso para ${number}. ID: ${result.id.id}`);
    return result;
  } catch (error) {
    console.error(`[SEND ${id}] Falha ao enviar mensagem para ${number}:`, error);
    // Verifica se o erro indica desconexão para tentar limpar o estado
    if (error.message.includes('Session closed') || error.message.includes('Page crashed') || error.message.includes('disconnected')) {
        console.warn(`[SEND ${id}] Erro indica desconexão ou crash. Limpando cliente.`);
        await logoutAndRemoveClient(clinicId);
    }
    // Re-lança o erro para a rota tratar (e logar no Sentry, se aplicável)
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
  clients, // Expor para debug ou gerenciamento externo, se necessário
  qrCodes, // Expor para a rota /qrcode buscar diretamente
};