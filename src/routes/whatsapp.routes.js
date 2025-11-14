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

// === ROTA: Obter QR Code ===
router.get('/qrcode', asyncHandler(async (req, res) => {
  const clinicId = req.clinicId;
  const id = clinicId.toString();
  const currentStatus = whatsappClient.getClientStatus(clinicId);

  if (currentStatus === "connected") {
    return res.status(200).json({ status: "connected", message: "WhatsApp já está conectado." });
  }

  if (whatsappClient.qrCodes.has(id)) {
    return res.status(200).json({
      status: "qrcode",
      message: "Leia o QR Code.",
      qrCode: whatsappClient.qrCodes.get(id)
    });
  }

  // Força a reinicialização se necessário
  if (currentStatus === "disconnected" || (currentStatus === "initializing" && !whatsappClient.qrCodes.has(id))) {
    console.log(`[QR-ROUTE ${id}] Forçando RESET e REINICIALIZAÇÃO.`);
    await whatsappClient.logoutAndRemoveClient(clinicId);
    whatsappClient.initializeClient(clinicId).catch(err =>
      console.error(`Erro async ao inicializar ${clinicId}:`, err)
    );
    return res.status(202).json({ status: "creating_qr", message: "Iniciando cliente e gerando QR Code..." });
  }

  return res.status(202).json({ status: "creating_qr", message: "Gerando QR Code. Aguarde..." });
}));

// === ROTA: Status do cliente ===
router.get('/status', asyncHandler(async (req, res) => {
    const status = whatsappClient.getClientStatus(req.clinicId);
    let message = 'Status desconhecido.';
    
    switch (status) {
      case "connected": 
        message = "WhatsApp conectado."; 
        break;
      case "qrcode_pending": 
        message = "QR Code gerado. Aguardando leitura."; 
        break;
      case "creating_qr": 
        message = "Criando QR Code. Aguarde..."; 
        break;
      case "initializing": 
        message = "Conexão em progresso."; 
        break;
      case "disconnected": 
        message = "WhatsApp desconectado (requer novo QR Code)."; 
        break;
    }
    
    res.status(200).json({ status, message });
  }));

// === ROTA: Logout manual ===
router.post('/logout', asyncHandler(async (req, res) => {
  await whatsappClient.logoutAndRemoveClient(req.clinicId);
  res.status(200).json({ status: "success", message: "Cliente WhatsApp desconectado." });
}));

// === ROTA: Enviar mensagem (sempre SEM NONO DÍGITO) ===
router.post('/send-message', asyncHandler(async (req, res) => {
  let { to, message } = req.body;

  console.log(`[SEND_MESSAGE][${req.clinicId}] Requisição recebida:`, {
    body: req.body,
    clinicId: req.clinicId
  });

  if (!to || !message) {
    return res.status(400).json({ message: 'Parâmetros "to" e "message" são obrigatórios.' });
  }

  try {
    // === Normaliza o número ===
    let number = String(to).replace(/\D/g, ''); // só dígitos
    number = number.replace(/^55/, ''); // remove +55 ou 55 do início

    // remove o 9 após o DDD, se existir
    if (number.length === 11 && number[2] === '9') {
      number = number.slice(0, 2) + number.slice(3);
    }

    // garante prefixo 55
    number = '55' + number;

    console.log(`[SEND_MESSAGE][${req.clinicId}] Enviando mensagem para ${number} (sem nono dígito).`);

    // Envia mensagem
    const result = await whatsappClient.sendMessage(req.clinicId, number, message);

    console.log(`[SEND_MESSAGE][${req.clinicId}] Mensagem enviada com sucesso. ID: ${result.key?.id || 'N/A'}`);

    res.status(200).json({
      success: true,
      message: 'Mensagem enviada com sucesso (sem nono dígito).',
      to: number,
      result: { id: result.key?.id || null }
    });

  } catch (error) {
    console.error(`[SEND_MESSAGE][${req.clinicId}] ERRO ao enviar mensagem:`, {
      error: error.message,
      stack: error.stack
    });
    res.status(400).json({
      success: false,
      message: error.message || 'Erro ao enviar mensagem.'
    });
  }
}));

// === ROTA: Listar conexões ativas ===
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

// === ROTA: Deletar todas as sessões ===
router.post('/delete-all-sessions', asyncHandler(async (req, res) => {
  console.log(`[DELETE-ALL] Iniciando exclusão total de TODAS as sessões...`);

  const clientIds = Array.from(whatsappClient.clients.keys());
  console.log(`[DELETE-ALL] Desconectando ${clientIds.length} clientes da memória...`);

  await Promise.all(clientIds.map(id => whatsappClient.logoutAndRemoveClient(id)));
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
    if (error.code === 'ENOENT') {
      console.warn(`[DELETE-ALL] Pasta ${authRootPath} não encontrada (provavelmente já removida).`);
      return res.status(200).json({
        status: "deleted_all",
        message: `Sessões em memória limpas (pasta de autenticação ${authRootPath} já não existia).`
      });
    }

    console.error(`[DELETE-ALL] Erro ao remover pasta ${authRootPath}:`, error);
    res.status(500).json({
      status: "error",
      message: `Sessões em memória limpas, mas falha ao remover pasta (${authRootPath}) do disco: ${error.message}`
    });
  }
}));

module.exports = router;
