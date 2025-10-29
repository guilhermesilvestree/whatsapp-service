// src/routes/whatsapp.routes.js
const express = require('express');
const router = express.Router();
const { verifyServiceToken } = require('../utils/auth.middleware');
const whatsappClient = require('../services/whatsapp.client');
const asyncHandler = require('../utils/asyncHandler'); // Crie este helper simples

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

module.exports = router;