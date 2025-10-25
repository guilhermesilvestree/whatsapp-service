// src/app.js
const express = require('express');
const cors = require('cors');
const whatsappRoutes = require('./routes/whatsapp.routes');

const app = express();

// Middlewares Globais
app.use(cors()); // Permite requisições de origens diferentes (necessário para a api-clinic)
app.use(express.json()); // Habilita o parsing de JSON no corpo das requisições

// Rota de Health Check (opcional, mas útil)
app.get('/health', (req, res) => {
  res.status(200).send('WhatsApp Service OK');
});

// Rotas Principais do Serviço
app.use('/', whatsappRoutes); // Monta as rotas do WhatsApp na raiz ou em /api/whatsapp, etc.

// Middleware de Tratamento de Erros (Simples)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err.stack || err.message);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    message: err.message || 'Erro interno no servidor.',
    // stack: process.env.NODE_ENV === 'production' ? null : err.stack, // Opcional: não expor stack em produção
  });
});

// Middleware para Rotas Não Encontradas (404)
app.use((req, res) => {
  res.status(404).json({ message: `Rota não encontrada - ${req.originalUrl}` });
});


module.exports = app;