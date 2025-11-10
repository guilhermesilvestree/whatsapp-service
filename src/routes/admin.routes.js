// src/routes/admin.routes.js
const express = require('express');
const router = express.Router();
const { verifyAdminKey } = require('../utils/admin.auth.middleware');
const whatsappClient = require('../services/whatsapp.client');
const asyncHandler = require('../utils/asyncHandler');

// Aplica o middleware de verificação de chave de API em todas as rotas admin
router.use(verifyAdminKey);

/**
 * @route GET /admin/status
 * @description Verifica o status do cliente admin.
 */
router.get('/status', asyncHandler(async (req, res) => {
    const status = whatsappClient.getAdminClientStatus();
    res.status(200).json({ status: status, clientId: whatsappClient.ADMIN_CLIENT_ID });
}));

/**
 * @route GET /admin/qrcode
 * @description Obtém o QR code para o cliente admin, se pendente.
 * Se desconectado, inicia a geração.
 */
router.get('/qrcode', asyncHandler(async (req, res) => {
    const status = whatsappClient.getAdminClientStatus();
    const adminId = whatsappClient.ADMIN_CLIENT_ID;

    if (status === "connected") {
        return res.status(200).json({ status: "connected", message: "Cliente admin já está conectado." });
    }

    const qr = whatsappClient.getAdminQrCode();
    if (qr) {
        return res.status(200).json({ status: "qrcode", message: "Leia o QR Code.", qrCode: qr });
    }

    // Se não tem QR e não está conectado, força a inicialização
    console.log(`[ADMIN-QR-ROUTE] Status: ${status}. Iniciando geração de QR...`);
    // Inicia em background
    whatsappClient.initializeAdminClient().catch(err => console.error(`[ADMIN-QR-ROUTE] Erro async ao inicializar ${adminId}:`, err));

    return res.status(202).json({ status: "creating_qr", message: "Gerando QR Code. Aguarde e tente novamente em alguns segundos." });
}));

/**
 * @route POST /admin/send-message
 * @description Envia uma mensagem transacional (ex: redefinição de senha).
 */
router.post('/send-message', asyncHandler(async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ message: 'Parâmetros "to" e "message" são obrigatórios.' });
    }

    try {
        // Usa a função específica de envio do admin
        // Ela tentará conectar se o cliente admin não estiver pronto
        const result = await whatsappClient.sendAdminMessage(to, message);
        // O ID da mensagem está em result.key.id com Baileys
        res.status(200).json({ message: 'Mensagem admin enviada com sucesso.', result: { id: result.key?.id || 'unknown' } });
    } catch (error) {
        console.error(`[ADMIN_SEND_MESSAGE] Erro: ${error.message}`);
        res.status(400).json({ message: error.message || 'Erro ao enviar mensagem admin.' });
    }
}));

/**
 * @route POST /admin/logout
 * @description Desconecta o cliente admin.
 */
router.post('/logout', asyncHandler(async (req, res) => {
    await whatsappClient.logoutAndRemoveClient(whatsappClient.ADMIN_CLIENT_ID);
    res.status(200).json({ status: "success", message: "Cliente WhatsApp Admin desconectado." });
}));


module.exports = router;