// src/app.js
const express = require('express');
const cors = require('cors');
const whatsappRoutes = require('./routes/whatsapp.routes');

const app = express();

// Middlewares Globais
app.use(cors());
app.use(express.json());

// Rota de Health Check (opcional, mas útil)
app.get('/health', (req, res) => {
  res.status(200).send('WhatsApp Service OK');
});

app.use('/', whatsappRoutes);

app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err.stack || err.message);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    message: err.message || 'Erro interno no servidor.',
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
});

// Middleware para Rotas Não Encontradas (404)
app.use((req, res) => {
  res.status(404).json({ message: `Rota não encontrada - ${req.originalUrl}` });
});


module.exports = app;