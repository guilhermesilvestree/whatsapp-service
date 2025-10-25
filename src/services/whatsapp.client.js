// src/services/whatsapp.client.js

const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const qrcode = require("qrcode");
const mongoose = require("mongoose");
const path = require("path");
const os = require("os");
const fs = require("fs");

// --- Detecção de Ambiente ---
const IS_SERVERLESS = process.env.VERCEL === "1"; // Ou outra variável se não usar Vercel

let chromium;
// Tenta carregar chromium apenas se serverless
// ATENÇÃO: Mesmo com isso, Vercel não é ideal para processos longos.
// Prefira Render, Fly.io, Railway, etc.
if (IS_SERVERLESS) {
  try {
    chromium = require("@sparticuz/chromium");
    console.log("[CLIENT] Carregado @sparticuz/chromium para ambiente serverless.");
  } catch (e) {
    console.error("Falha ao carregar @sparticuz/chromium. Processo pode falhar.", e);
  }
}

// --- Armazenamento Global ---
const clients = new Map(); // Armazena instâncias do Client por clinicId
const qrCodes = new Map(); // Armazena QR codes ativos por clinicId
const creatingQr = new Map(); // Flag para indicar que um QR está sendo gerado
let mongoStore; // Instância única do MongoStore

// --- Inicialização do MongoStore ---
const initializeMongoStore = () => {
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

  // Tentativa de verificar o estado interno se disponível
  const internalState = client.pupPage ? 'CONNECTED_INTERNAL' : 'DISCONNECTED_INTERNAL';
  // console.log(`[DEBUG STATUS ${id}] Client state: ${client.state}, Internal state guess: ${internalState}`); // Log de debug

  // Lógica de status (pode precisar de ajustes com base na observação)
  if (qrCodes.has(id)) return "qrcode_pending"; // Prioriza mostrar QR se existe
  if (creatingQr.has(id)) return "creating_qr";
  if (client.info) return "connected"; // Confia no objeto info se ele existe

  // Estados intermediários ou de falha
  if (client.state === 'INITIALIZING' || client.state === 'STARTING') return "initializing";
  if (client.state === 'CONFLICT' || client.state === 'UNPAIRED' || client.state === 'UNLAUNCHED' || client.state === 'UNPAIRED_IDLE') return "disconnected"; // Considera desconectado nesses casos


  // Fallback - pode indicar um estado inesperado ou desconectado
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
      if (client.info || client.state === 'READY' || client.state === 'CONNECTED') {
        await client.logout();
        console.log(`[CLIENT ${id}] Logout realizado.`);
      } else {
        console.log(`[CLIENT ${id}] Pulando logout (estado ${client.state}).`);
      }
    } catch (error) {
      console.warn(`[CLIENT ${id}] Erro (seguro) durante logout: ${error.message}`);
    }

    try {
      // Tenta destruir a instância do navegador
       if (client.pupBrowser || client.pupPage) {
           await client.destroy();
           console.log(`[CLIENT ${id}] Destroy realizado.`);
       } else {
           console.warn(`[CLIENT ${id}] Pulando destroy (sem browser/page).`);
       }

    } catch (error) {
      console.warn(`[CLIENT ${id}] Erro (seguro) durante destroy: ${error.message}`);
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

  // --- Configuração do Puppeteer ---
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


  const authStrategy = new RemoteAuth({
    store: mongoStore,
    clientId: id,
    backupSyncIntervalMs: 600000, // Aumenta intervalo de backup para 10 min
    dataPath: dataPath, // Necessário para RemoteAuth funcionar corretamente
  });

  let puppeteerOptions = {
      //headless: true, // Use true para produção normal
      args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", // Essencial em containers/ambientes restritos
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu", // Frequentemente necessário em servidores sem GPU física
          //'--single-process', // Pode ajudar em ambientes com pouca memória, mas pode ser menos estável
          '--disable-extensions', // Desabilita extensões
      ],
      // userDataDir: dataPath // Pode ajudar na persistência da sessão em alguns casos
  };

  if (IS_SERVERLESS && chromium) {
    console.log("[CLIENT ${id}] Configurando para ambiente Serverless com @sparticuz/chromium.");
    try {
        const executablePath = await chromium.executablePath();
        if (!executablePath) {
            throw new Error('Não foi possível obter executablePath do chromium.');
        }
        puppeteerOptions.executablePath = executablePath;
        puppeteerOptions.args = [...chromium.args, ...puppeteerOptions.args]; // Combina args
        puppeteerOptions.headless = chromium.headless; // Garante 'new' se suportado pelo chromium
         console.log(`[CLIENT ${id}] Usando chromium em: ${executablePath ? 'path_obtido' : 'path_nao_obtido'}`);
    } catch (error) {
        console.error(`[CLIENT ${id}] Erro ao configurar chromium serverless: ${error.message}`);
        creatingQr.delete(id);
        throw error; // Re-lança o erro
    }
  } else {
    console.log(`[CLIENT ${id}] Configurando para ambiente padrão (não serverless ou chromium não disponível).`);
     puppeteerOptions.headless = 'new'; // Usa o novo modo headless por padrão
  }

  console.log(`[CLIENT ${id}] Opções Puppeteer final:`, { args: puppeteerOptions.args, headless: puppeteerOptions.headless, executablePath: !!puppeteerOptions.executablePath });

  // --- Criação do Cliente ---
  let client;
  try {
      client = new Client({
        authStrategy: authStrategy,
        puppeteer: puppeteerOptions,
        // Configurações adicionais podem ser necessárias dependendo do ambiente
        // qrMaxRetries: 2, // Tenta gerar QR code no máximo 2 vezes
         takeoverOnConflict: true, // Tenta assumir controle se outra sessão estiver ativa
      });
      console.log(`[CLIENT ${id}] Instância do Client criada.`);
  } catch (error) {
      console.error(`[CLIENT ${id}] Erro ao instanciar Client: ${error.message}`);
      creatingQr.delete(id);
      throw error;
  }


  // Adiciona ao mapa ANTES de inicializar
  clients.set(id, client);

  // --- Listeners de Eventos ---
  client.on("qr", async (qr) => {
    console.log(`[CLIENT ${id}] Evento QR recebido.`);
    try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        qrCodes.set(id, qrDataUrl);
        creatingQr.delete(id); // Limpa a flag aqui
        console.log(`[CLIENT ${id}] QR code gerado e armazenado. Flag 'creatingQr' removida.`);
    } catch (qrError) {
        console.error(`[CLIENT ${id}] Erro ao gerar QR Data URL: ${qrError.message}`);
        // Mantém a flag creatingQr para tentar novamente na próxima chamada? Ou remove?
        // Depende da lógica desejada. Remover pode levar a 'disconnected'.
    }

  });

  client.on("ready", () => {
    console.log(`[CLIENT ${id}] Cliente está PRONTO!`);
    qrCodes.delete(id);
    creatingQr.delete(id);
    // client.info já deve estar populado aqui
    console.log(`[CLIENT ${id}] Informações: ${client.info?.wid?.user}, PushName: ${client.info?.pushname}`);
  });

   client.on("authenticated", () => {
       console.log(`[CLIENT ${id}] Autenticado com sucesso.`);
       // Limpa QR e flag caso a autenticação ocorra sem 'ready' (ex: restauração de sessão)
       qrCodes.delete(id);
       creatingQr.delete(id);
   });


  client.on("auth_failure", (msg) => {
    console.error(`[CLIENT ${id}] FALHA NA AUTENTICAÇÃO: ${msg}`);
    qrCodes.delete(id); // Limpa QR obsoleto
    creatingQr.delete(id); // Limpa flag
    // Considerar remover o cliente aqui para forçar recriação na próxima tentativa?
    logoutAndRemoveClient(clinicId); // Tenta limpar completamente
  });

  client.on("disconnected", (reason) => {
    console.warn(`[CLIENT ${id}] Desconectado: ${reason}`);
    qrCodes.delete(id);
    creatingQr.delete(id);
    logoutAndRemoveClient(clinicId); // Força a limpeza completa no disconnect
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[CLIENT ${id} LOADING] ${percent}% ${message}`);
  });

  client.on('error', (err) => {
    console.error(`[CLIENT ${id} ERROR] Erro na instância:`, err);
    // Pode ser útil limpar o cliente aqui também
    // logoutAndRemoveClient(clinicId);
  });

  // --- Inicialização ---
  console.log(`[CLIENT ${id}] Chamando client.initialize()...`);
  client.initialize().then(() => {
    console.log(`[CLIENT ${id}] Initialize completado com sucesso (pode ainda não estar 'ready').`);
    // Não limpa creatingQr aqui, espera 'ready' ou 'authenticated'
  }).catch((err) => {
    console.error(`[CLIENT ${id}] ERRO CATASTRÓFICO durante initialize:`, err);
    qrCodes.delete(id);
    creatingQr.delete(id);
    logoutAndRemoveClient(clinicId); // Limpa em caso de falha grave na inicialização
  });

  return client;
};

// --- Envio de Mensagem ---
const sendMessage = async (clinicId, number, message) => {
  const id = clinicId.toString();
  const client = clients.get(id);
  const status = getClientStatus(id);

  console.log(`[SEND ${id}] Tentando enviar para ${number}. Status atual: ${status}`);

  if (!client || status !== "connected") {
    // Tenta inicializar se desconectado, mas avisa que pode falhar
    if (!client || status === 'disconnected') {
        console.warn(`[SEND ${id}] Cliente desconectado. Tentando inicializar...`);
        try {
            await initializeClient(clinicId); // Tenta reconectar/reiniciar
            // Dá um pequeno tempo para a conexão tentar estabelecer
            await new Promise(resolve => setTimeout(resolve, 5000));
             const newStatus = getClientStatus(id);
             if (newStatus !== 'connected') {
                 throw new Error(`Cliente WhatsApp não conectado após tentativa de reinicialização. Status: ${newStatus}`);
             }
             // Pega a nova instância do cliente se foi recriado
             const newClient = clients.get(id);
             if (!newClient) throw new Error('Cliente não encontrado após reinicialização.');
             return await newClient.sendMessage(`${number}@c.us`, message); // Tenta enviar com o novo cliente
        } catch (initError) {
             console.error(`[SEND ${id}] Falha ao reinicializar: ${initError.message}`);
             throw new Error(`Cliente WhatsApp não conectado ou falha ao inicializar: ${initError.message}`);
        }

    } else {
       throw new Error(`Cliente WhatsApp não está pronto para enviar mensagens. Status: ${status}`);
    }
  }


  // Formata o número para o padrão chatId (numero@c.us)
  const chatId = number.endsWith("@c.us") ? number : `${number}@c.us`;

  try {
    console.log(`[SEND ${id}] Enviando para chatId ${chatId}...`);
    const result = await client.sendMessage(chatId, message);
    console.log(`[SEND ${id}] Mensagem enviada com sucesso para ${number}. ID: ${result.id.id}`);
    return result;
  } catch (error) {
    console.error(`[SEND ${id}] Falha ao enviar mensagem para ${number}:`, error);
    // Verifica se o erro indica desconexão para tentar limpar o estado
    if (error.message.includes('Session closed') || error.message.includes('disconnected')) {
        console.warn(`[SEND ${id}] Erro indica desconexão. Tentando limpar cliente.`);
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
  clients, // Expor para debug, se necessário
  qrCodes, // Expor para a rota /qrcode buscar diretamente
};