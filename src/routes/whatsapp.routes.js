// src/routes/whatsapp.routes.js
const express = require('express');
const router = express.Router();
const { verifyServiceToken } = require('../utils/auth.middleware');
const whatsappClient = require('../services/whatsapp.client');
const asyncHandler = require('../utils/asyncHandler');

const fs = require('fs').promises;
const path = require('path');

// Aplica o middleware de verificação de token em todas as rotas
router.use(verifyServiceToken);

router.get('/qrcode', asyncHandler(async (req, res) => {
    const clinicId = req.clinicId;
    const id = clinicId.toString();
    const currentStatus = whatsappClient.getClientStatus(clinicId);

    if (currentStatus === "connected") {
        return res.status(200).json({ status: "connected", message: "WhatsApp já está conectado." });
    }
    if (whatsappClient.qrCodes.has(id)) {
        return res.status(200).json({ status: "qrcode", message: "Leia o QR Code.", qrCode: whatsappClient.qrCodes.get(id) });
    }
    // Força a reinicialização se necessário (pode ajustar essa lógica)
    if (currentStatus === "disconnected" || (currentStatus === "initializing" && !whatsappClient.qrCodes.has(id))) {
         console.log(`[QR-ROUTE ${id}] Forçando RESET e REINICIALIZAÇÃO.`);
         await whatsappClient.logoutAndRemoveClient(clinicId); // Limpa estado antigo
         whatsappClient.initializeClient(clinicId).catch(err => console.error(`Erro async ao inicializar ${clinicId}:`, err)); // Inicia em background
         return res.status(202).json({ status: "creating_qr", message: "Iniciando cliente e gerando QR Code..." });
    }
     // Se já está criando ou inicializando e esperando QR
     return res.status(202).json({ status: "creating_qr", message: "Gerando QR Code. Aguarde..." });
}));

router.get('/status', asyncHandler(async (req, res) => {
    const status = whatsappClient.getClientStatus(req.clinicId);
    // Mapear status para mensagens amigáveis (como no controller original)
    let message = 'Status desconhecido.';
     switch (status) {
        case "connected": message = "WhatsApp conectado."; break;
        case "qrcode_pending": message = "QR Code gerado. Aguardando leitura."; break;
        case "creating_qr": message = "Criando QR Code. Aguarde..."; break;
        case "initializing": message = "Conexão em progresso."; break;
        case "disconnected": message = "WhatsApp desconhecido ou desconectado."; break;
     }
    res.status(200).json({ status, message });
}));

router.post('/logout', asyncHandler(async (req, res) => {
    await whatsappClient.logoutAndRemoveClient(req.clinicId);
    res.status(200).json({ status: "success", message: "Cliente WhatsApp desconectado." });
}));

router.post('/send-message', asyncHandler(async (req, res) => {
    let { to, message } = req.body;

    // Log de debug: recebimento de requisição
    console.log(`[SEND_MESSAGE][${req.clinicId}] Requisição recebida:`, {
        body: req.body,
        clinicId: req.clinicId
    });

    if (!to || !message) {
        console.warn(`[SEND_MESSAGE][${req.clinicId}] Parâmetros ausentes. Body recebido:`, req.body);
        return res.status(400).json({ message: 'Parâmetros "to" e "message" são obrigatórios.' });
    }

    // Garante que o número tenha prefixo 55, mas sem duplicar
    to = to.toString().replace(/^(\+?55)?/, ''); // Remove +55 ou 55 no começo
    to = '55' + to; // Adiciona 55 no começo

    try {
        const result = await whatsappClient.sendMessage(req.clinicId, to, message);
        console.log(`[SEND_MESSAGE][${req.clinicId}] Mensagem enviada com sucesso. ID: ${result.id}`);
        res.status(200).json({ message: 'Mensagem enviada para a fila.', result: { id: result.id } });
    } catch (error) {
        // Log detalhado do erro e do que foi recebido
        console.error(`[SEND_MESSAGE][${req.clinicId}] ERRO ao enviar mensagem:`, {
            error: error.message,
            stack: error.stack,
            params: { to, message },
            clinicId: req.clinicId,
            body: req.body
        });
        res.status(400).json({ message: error.message || 'Erro ao enviar mensagem.' });
    }
}));

// === INÍCIO DAS ROTAS ADICIONAIS ===

/**
 * Rota para listar todas as conexões ativas na memória.
 */
router.get('/connections', asyncHandler(async (req, res) => {
    const connections = [];
    const clientIds = whatsappClient.clients.keys();
    
    for (const id of clientIds) {
        const status = whatsappClient.getClientStatus(id);
        connections.push({ clinicId: id, status });
    }

    res.status(200).json({
        count: connections.length,
        connections
    });
}));


/**
 * Rota para DELETAR TODAS AS SESSÕES (memória e disco).
 */
router.post('/delete-all-sessions', asyncHandler(async (req, res) => {
    console.log(`[DELETE-ALL] Iniciando exclusão total de TODAS as sessões...`);

    // 1. Desconectar todos os clientes da memória
    const clientIds = Array.from(whatsappClient.clients.keys());
    console.log(`[DELETE-ALL] Desconectando ${clientIds.length} clientes da memória...`);
    
    await Promise.all(
        clientIds.map(id => whatsappClient.logoutAndRemoveClient(id))
    );
    
    console.log(`[DELETE-ALL] Clientes em memória limpos.`);

    const authRootPath = path.resolve(".baileys_auth");

    try {
        await fs.rm(authRootPath, { recursive: true, force: true });
        console.log(`[DELETE-ALL] Pasta ${authRootPath} removida do disco.`);
        res.status(200).json({
            status: "deleted_all",
            message: `Todas as sessões (${clientIds.length}) foram desconectadas e a pasta de autenticação (${authRootPath}) foi removida.`
        });
    } catch (error) {
        // Trata erro caso a pasta não exista
        if (error.code === 'ENOENT') {
             console.warn(`[DELETE-ALL] Pasta ${authRootPath} não encontrada (provavelmente já removida).`);
             return res.status(200).json({
                status: "deleted_all",
                message: `Sessões em memória limpas (pasta de autenticação ${authRootPath} já não existia).`
            });
        }
        // Outro erro de remoção
        console.error(`[DELETE-ALL] Erro ao remover pasta ${authRootPath}:`, error);
        res.status(500).json({
            status: "error",
            message: `Sessões em memória limpas, mas falha ao remover pasta (${authRootPath}) do disco: ${error.message}`
        });
    }
}));

// === FIM DAS ROTAS ADICIONAIS ===

module.exports = router;