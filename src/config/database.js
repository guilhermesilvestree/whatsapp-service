// src/config/database.js
const mongoose = require('mongoose');

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI não definido nas variáveis de ambiente.');
    process.exit(1);
  }

  try {
    // Opções de conexão podem ser ajustadas conforme necessário
    await mongoose.connect(process.env.MONGO_URI, {
       maxPoolSize: 10, // Pool menor pode ser suficiente para o serviço
       serverSelectionTimeoutMS: 5000, // Timeout mais curto para falha rápida
       socketTimeoutMS: 45000,
    });

    console.log('MongoDB Conectado com Sucesso para MongoStore!');
  } catch (err) {
    console.error('Erro ao conectar com o MongoDB:', err.message);
    // Permite que o servidor tente iniciar mesmo sem DB,
    // mas MongoStore não funcionará.
    // Ou process.exit(1); se a conexão for estritamente necessária.
    console.warn('MongoStore não estará funcional sem conexão com o DB.');
  }

  // Monitora eventos de desconexão/reconexão (opcional)
  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB desconectado.');
  });
  mongoose.connection.on('reconnected', () => {
    console.log('MongoDB reconectado.');
  });

  // Encerramento gracioso
  process.on('SIGINT', async () => {
    await mongoose.connection.close();
    console.log('Conexão MongoDB encerrada.');
    process.exit(0);
  });
};

module.exports = connectDB;